# dsh-keypilot

[![CI](https://github.com/sucooer/dsh-keypilot/actions/workflows/ci.yml/badge.svg)](https://github.com/sucooer/dsh-keypilot/actions/workflows/ci.yml)

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
| **Key entry in the panel** | Type a reference name + paste the secret in a pool; it is written to the host credential store through the public `credentials.set` interface, and never logged |
| **Security** | Only credential *references* are stored; secret-looking values are rejected; Fail-Closed loopback/same-origin bridge |

---

## Install

This plugin is distributed through GitHub only — it is not published to npm.

### From GitHub (recommended)

Paste the repository address into the in-app plugin manager, or from a CLI:

```bash
dsh plugin --profile desktop add github:sucooer/dsh-keypilot#v0.1.2
```

Pin the tag: a git spec without `#` resolves to whatever the default branch happened to
point at, and pnpm then locks that **commit hash** into `pnpm-lock.yaml`. New commits on
`main` will never reach you, and there is no way to say which version you are on.

### Upgrading

Check what exists:

```bash
git ls-remote --tags https://github.com/sucooer/dsh-keypilot.git
```

Compare against the commit recorded for this package in the profile's
`pnpm-lock.yaml`, or just look at the tag you pinned. To move:

```bash
dsh plugin --profile desktop add github:sucooer/dsh-keypilot#v0.1.3
```

**A new version number only takes effect through a new tag name.** pnpm resolves a git
tag once and caches it by the resolved commit, so re-using a tag, or bumping `version`
in `package.json` without tagging, both leave you on the old code. Each release gets a
fresh `vX.Y.Z` tag, never a moved one. Fully quit and reopen DSH afterwards — plugins
load at host startup.

### DSH Desktop (this machine)

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

Configuration holds **references only** (e.g. `SENSENOVA_API_KEY`). Real values stay in the
host credential store (`%APPDATA%\dsh-desktop\harness\.credentials.yaml` on the desktop app).

There are two ways to enter a key.

**① The host's Settings → Models page** — the host's own entry point:

![Host settings: the "模型" (Models) entry in the sidebar is where keys are entered](docs/host-credentials.png)

Adding or editing a model provider there stores the value and derives the reference name
automatically:

```
<PROVIDER, upper-cased, non-alphanumerics → underscores>_API_KEY    # sensenova → SENSENOVA_API_KEY
```

Put **that same name** into the plugin's Key pools to take over its resolution.

**② "Save a key directly", inside the plugin's Key pools** — type a reference name, paste the
secret, click *Save & add to pool*. The value goes to the host credential store through the
public `credentials.set` interface; the plugin config still keeps the reference name only, and
no plaintext lands in it.

② exists because the host's Models page has **exactly one key field per provider**, while
rotation needs several. Add `SENSENOVA_API_KEY_2`, `_3`, … right there instead of editing the
credentials file by hand.

(Both the pool's reference field and the name field of ② accept **names only**: pasting a
secret is rejected — otherwise plaintext would end up in the plugin's config file while the
user believes they only typed a name.)

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
node --test test/run.mjs      # 387 cases
node tools/verify.mjs         # packaging self-check (74 checks)
```

Unit tests deliberately load **no host modules** — they must run anywhere — so they pin
*our* shapes, not *the host's* acceptance of them. That gap has its own check:

```bash
npm run setup -- --dsh-root "<DSH install dir>"   # once; node_modules is gitignored
npm run verify:route                              # replays the real host seam
```

It builds each declared route with the real `PiAiAdapter` and `pi-ai`, then applies the
host's own catalog validation (`dsh-llm` → `LlmRuntime.listModels`). It exists because a
shape mismatch there fails *at the model-catalog layer*, not at request time: the provider
shows up in the picker as `加载失败: adapter returned invalid or duplicate model metadata`
and no key pool can rescue it.

A second gap is that a model **listed** by a gateway is not necessarily one **your account
can call**. The catalog's model ids are a starting suggestion, so they get verified against
the live endpoint:

```bash
node tools/check-provider-models.mjs --provider nvidia        # inference + tool calling
node tools/check-provider-models.mjs --provider nvidia --all  # sweep everything /models lists
```

On NVIDIA NIM the two are wildly different: the endpoint advertises 81 models, a given
account can call about ten, and some of the rest do not error at all — they **hang without
responding**. A hanging model is the worst kind of cascade target: nothing to classify, and
the turn stalls until the stream idle timeout.

A third gap is the **browser half**, which no unit test can reach: it runs inside the host's
module loader. It has produced a real crash that only ever fired in the browser (an empty-pool
branch building an array as a single element, so `...poolCards` threw
`Spread syntax requires ...iterable[Symbol.iterator] to be a function`; the host logged
`slot entry crashed in 'settings.section'` and rendered a blank panel). So it gets driven for
real, in a headless browser:

```bash
dsh --profile web --port 34573 --no-open                    # prints ?token=... in the log
chrome --headless=new --remote-debugging-port=9222 --no-first-run \
       --user-data-dir="<fresh temp dir>" about:blank
CDP_HOST=127.0.0.1 KP_URL="http://127.0.0.1:34573/?token=..." \
  node tools/check-settings-section.mjs
```

It opens the real UI, clicks into the section, and asserts that the content rendered, nothing
crashed, the console is clean and `fetch` returned. `KP_FOCUS` scrolls a given block into view
first, and the screenshot lands in `docs/settings-panel.png` — that is how the images in this
README are produced. The CDP helper it uses is `tools/lib/cdp.mjs`, vendored in this repo
(Node 22+ global `WebSocket`; no puppeteer/playwright).

Coverage focus: route validation, pool selection, backoff/circuit-breaker state machine,
failure classification matrix (including CJK error text), DST-correct quota windows,
rotation invariants, bridge security (remote origin, DNS rebinding, cross-site writes),
config priority semantics.

Real defects these tests caught and fixed: a circuit breaker using `openedAt === 0` as its
sentinel (state collapsed when the monotonic clock started at 0); `Retry-After` being
clamped by the local backoff ceiling (re-hitting upstream before the cooldown expired);
panel edits to global settings being overridden by the host config; a declared route's
model list being treated as objects when settings hold plain id strings, which made every
model's `id`/`name` `undefined` and killed the whole route's catalog; and the in-stream
`finish.error` switch path skipping the two accounting fields the other switch paths set,
which left a cooling key showing as "reason unknown" — on the path a 429 most often takes.

---

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on Node 22 — the floor declared
in `engines` — and has **no install step**, on purpose: the two commands above load no host
modules and no third-party packages, so CI runs exactly the code a fresh clone runs, with
nothing in between to paper over a missing dependency. If a future change makes either of
them need `node_modules`, CI breaks, which is the correct outcome.

---

## Releasing

Distribution is GitHub-only. One command cuts a release:

```bash
npm run release                      # tags v<package.json version>, pushes it, opens a Release
npm run release -- --notes notes.md  # use hand-written release notes
npm run release -- --dry-run         # print the plan, change nothing
```

`tools/release.mjs` refuses to run unless the working tree is clean, the tag does not
already exist, and the version moved strictly forward — because both failure modes are
silent on the user's side. **A tag is only ever created, never moved**: pnpm resolves a
git tag once and caches the resolved commit, so a moved `v0.1.0` upgrades nobody, and a
`version` bump with no new tag ships nothing. Create a Release as well, since that is
where "is there a newer version?" is answerable at a glance.

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
