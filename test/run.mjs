/**
 * 测试入口。
 *
 * 不使用「把目录交给测试运行器自动发现」的写法：在部分 Node 版本上，目录参数会被
 * 当成模块路径直接加载而报 MODULE_NOT_FOUND，且不同版本对测试文件的命名规则
 * 也不一致。显式列出既跨版本稳定，也让「一共有哪些测试」一眼可见。
 *
 * 运行：node --test test/run.mjs
 */

import './core-route-schema.test.mjs'
import './core-credential-input.test.mjs'
import './core-pool.test.mjs'
import './core-token-bucket.test.mjs'
import './core-concurrency.test.mjs'
import './core-backoff.test.mjs'
import './core-classify.test.mjs'
import './core-quota-window.test.mjs'
import './core-cascade-redact-estimate.test.mjs'
import './core-provider-catalog.test.mjs'
import './core-canary.test.mjs'
import './core-usage.test.mjs'
import './core-webhook.test.mjs'
import './runtime-rotation.test.mjs'
import './runtime-probe-notifier.test.mjs'
import './runtime-state.test.mjs'
import './runtime-config.test.mjs'
import './runtime-http-bridge.test.mjs'
// 客户端渲染测试依赖宿主提供的 react；拿不到时整组 skip（不会变红），
// 所以可以安心放进主入口——这样「一条命令跑全部」是真的全部。
import './client-render.test.mjs'
