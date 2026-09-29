# dsh-keypilot

> Enterprise-grade **transparent API key rotation, predictive rate-limit guard and
> cross-provider failover** for DeepSeek Harness.

Rotate across a pool of API keys, skip rate-saturated keys *before* a 429 happens,
cascade to fallback providers when a pool is exhausted — with a settings section that
sits in the system Settings sidebar.

---

## What it solves

Under high throughput (long agent runs, parallel sub-agents, dense tool loops), a single
key hits upstream rate limits quickly: HTTP 429, RPM/TPM exhaustion, daily quota. In
stock DSH one 429 fails the whole agent turn — tokens already produced are lost, session
replay breaks, and a human has to intervene.

dsh-keypilot takes over at one precise seam: **credential resolution**. Before the
request leaves the process the key pool decides which key to use; when a request fails
before any content has been emitted, it retries with the next key.

```
user message → llm/stream
                  │
                  ▼
            ┌─────────────┐   saturated / at concurrency cap
            │ pool select │ ──────────────────────────────► skip this key
            └──────┬──────┘
                   │ available
                   ▼
          credentials.resolve(ref)  ──►  swapped for the key chosen for this call
                   │
                   ▼
            upstream API  ──429/5xx──► classify → cooldown → retry next key
                   │
                   └─ pool exhausted ──► cross-provider cascade
```

**Provider identity never changes**, so multi-turn sessions, tool state and replayability
are untouched.

---

## The settings panel

![Settings panel: the "密钥轮换" section in the system settings sidebar](docs/settings-panel.png)

It registers as a **first-level section in the system settings sidebar** (the highlighted
"密钥轮换" entry above), not as a card inside a secondary "Settings → Plugins" page.

---

## Features

| Area | Capability |
|---|---|
| **Transparent rotation** | One key pool per provider; automatic switch on failure; zero-loss retry before first byte |
| **Predictive limits** | Local RPM/TPM token bucket skips saturated keys up front; adapts to upstream `x-ratelimit-*` headers |
| **Concurrency** | Per-key in-flight cap with timeout reclamation (guards against counter leaks) |
| **Scheduling** | `round-robin` / `least-loaded` / `lowest-latency` (p95 TTFT) |
| **Graded backoff** | Exponential for hard failures (capped ×8), flat short cooldown for soft ones, ±12.5% jitter, penalty decay |
| **Circuit breaker** | Fail fast after consecutive failures; half-open probes auto-recover |
| **Cross-provider cascade** | Declared fallback chain with depth and cycle guards |
| **Provider catalog** | ~30 presets (DeepSeek, OpenAI, Anthropic, Gemini, Moonshot, Zhipu, Qwen, Ark, SenseNova, NVIDIA NIM, OpenRouter, Ollama, …) |
| **Custom providers** | Declarative registration of a real pi-ai model route for gateways the host does not serve |
| **Quota windows** | UTC / Pacific (DST-aware) / local midnight / rolling 24h |
| **Canary probe** | One free `/models` request to cooling keys: success returns them early, still-limited ones keep waiting, auth failures get quarantined |
| **Usage report** | Per day / provider / key: requests, tokens, estimated cost; CSV & JSON export; expired buckets auto-trimmed |
| **Webhook alerts** | Telegram / Discord / Slack or any HTTP endpoint; bounded queue + 5s aggregation + exponential backoff on failure |
| **Settings panel** | First-level section in the system Settings sidebar: pool health, key states, cooldown countdowns, live event stream |
| **Security** | Only credential *references* are stored; secret-looking values are rejected; Fail-Closed loopback/same-origin bridge |

---

## Install

### DSH Desktop

The `desktop` profile is owned exclusively by the Electron application. Install through
the in-app plugin manager / marketplace, or point its "install from local directory" at
this repository root.

### Web / CLI profile

```bash
dsh plugin --profile web add link:/path/to/dsh-keypilot
```

For local development you can load it through a patch overlay without touching the
profile's plugin roster:

```yaml
# local.cordis.yml
- insert:
    - id: keypilot
      name: '@sucooer/dsh-keypilot'
```

```bash
dsh --profile web --patch ./local.cordis.yml
```

Then open **Settings → Key Rotation**.

---

## Configuration

Everything editable in the panel applies immediately, no restart. It can also live in
the profile's plugin config:

```yaml
keypilot:
  enabled: true
  cooldownMs: 60000
  concurrencyLimit: 5         # 0 = unlimited
  routingStrategy: round-robin
  circuitBreakerEnabled: true
  circuitBreakerThreshold: 5
  quotaResetWindow:
    type: midnight_utc
  cascade:
    - provider: openrouter
      model: deepseek/deepseek-chat
  providers:
    - provider: deepseek
      keys:                   # credential REFERENCES only
        - DEEPSEEK_API_KEY
        - DEEPSEEK_API_KEY_2
      rpmLimit: 60
      tpmLimit: 100000
    - provider: my-gateway
      keys: [MY_GW_KEY]
      route:
        id: my-gateway
        displayName: My gateway
        baseURL: https://gw.example.com/v1
        api: openai-completions
        models: [gpt-4o]
```

### Where the secrets live

Configuration holds **references only** (`DEEPSEEK_API_KEY`). Real values stay in the
host credential store (`$DSH_HOME/.credentials.yaml` by default). Pasting a secret into
the panel's key field is **rejected** — it would write plaintext to a config file on disk
while the user believes they only typed a name.

---

## Architecture

```
lib/core/            Pure logic: no host services, no I/O, fully unit-tested
  provider-catalog.js  built-in provider presets
  route-schema.js      route declaration validation & normalization
  token-bucket.js      RPM/TPM ledger + header adaptation
  concurrency.js       in-flight slots (with leak reclamation)
  backoff.js           backoff, jitter, penalty decay, circuit breaker
  classify.js          failure classification (should we switch?)
  quota-window.js      quota reset windows (timezone-correct)
  pool.js              key pool & scheduling
  cascade.js           cross-provider cascade (cycle-proof)
  histogram.js         TTFT percentiles
  estimate.js          token estimation
  redact.js            redaction & secret-shape detection

lib/runtime/         Host seams — the only part touching DSH
  rotate.js            rotation engine (per-request binding, safe retry points, cascade)
  custom-routes.js     pi-ai adapter registration & withdrawal
  config.js            config normalization & persistence
  state.js             health-state persistence (atomic writes)
  http-bridge.js       settings bridge (Fail-Closed loopback/same-origin)

lib/index.js         host wiring    lib/client.js  settings panel (browser half)
```

The split means **decision logic is testable without a DSH host**, and only
`lib/runtime/` needs to change when host APIs move.

### Deliberate design choices

- **No "one route per key"**. Clone routes are the usual source of route collisions,
  orphan routes and cascade recursion in this class of plugin, and are unnecessary for
  transparent rotation: keep the route, swap the resolved key.
- **Round-robin uses a fixed ticket sequence**, not the index into a *filtered* candidate
  array. The latter jumps around as the candidate set changes (cooldown, saturation,
  per-call exclusions), so "switch to the next key" stops meaning the next key.
- **Never retry after content is emitted** — otherwise the user sees two concatenated
  answers.
- **A user abort is not a failure**. `finish.aborted` and `AbortError` pass through
  untouched; pressing stop actually stops.

---

## Tests

```bash
node --test test/run.mjs      # 349 cases
node tools/verify.mjs         # packaging self-check (63 checks)
```

Coverage focus: route validation, pool selection, backoff/circuit-breaker state machine,
failure classification matrix (including CJK error text), DST-correct quota windows,
rotation invariants, bridge security (remote origin, DNS rebinding, cross-site writes),
config priority semantics.

Real defects these tests caught and fixed: a circuit breaker using `openedAt === 0` as its
sentinel (state collapsed when the monotonic clock started at 0); `Retry-After` being
clamped by the local backoff ceiling (re-hitting upstream before the cooldown expired);
panel edits to global settings being overridden by the host config.

---

## Known limitations

- **Only routes the host knows can be rotated.** Built-in providers come from the host's
  adapters; unknown gateways need a declarative custom route (depends on the host's pi-ai
  seam, with a readable diagnostic when absent).
- **Predictive limits are a local estimate.** Several processes sharing one key are
  invisible to the local ledger; upstream `x-ratelimit-remaining-*` wins when present.
- **Embedding / batch calls** draw keys from the pool but do not participate in streaming
  retry.

---

## License

MIT © [sucooer](https://github.com/sucooer)
