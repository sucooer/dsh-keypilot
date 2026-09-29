/**
 * 首字延迟（TTFT）直方图。
 *
 * 「哪把密钥更快」不能靠平均值：一次 30 秒的卡顿会把平均值拖到毫无参考价值，
 * 而用户真正体感的是**慢的那几次**。所以看 p95。这里用定长环形缓冲保存最近若干
 * 个样本——内存有上限，且旧的慢请求会自然滑出窗口，密钥换到新线路后指标能跟着变。
 *
 * @module @sucooer/dsh-keypilot/core/histogram
 */

/** 默认窗口样本数。 */
export const DEFAULT_LATENCY_WINDOW = 200

export class LatencyHistogram {
  /**
   * @param {object} [options]
   * @param {number} [options.window] 每把密钥保留的样本数
   */
  constructor(options = {}) {
    this.window = Number.isFinite(options.window) && options.window > 1 ? Math.floor(options.window) : DEFAULT_LATENCY_WINDOW
    /** @type {Map<string, { buffer: Float64Array, length: number, cursor: number }>} */
    this._series = new Map()
  }

  /** @param {string} ref */
  _seriesFor(ref) {
    let series = this._series.get(ref)
    if (series === undefined) {
      series = { buffer: new Float64Array(this.window), length: 0, cursor: 0 }
      this._series.set(ref, series)
    }
    return series
  }

  /**
   * 记录一次延迟。
   * @param {string} ref
   * @param {number} ms
   */
  record(ref, ms) {
    const value = Number(ms)
    // 负值与 NaN 是坏数据（时钟回拨、重复记账），记进去只会污染百分位。
    if (!Number.isFinite(value) || value < 0) return
    const series = this._seriesFor(ref)
    series.buffer[series.cursor] = value
    series.cursor = (series.cursor + 1) % series.buffer.length
    if (series.length < series.buffer.length) series.length += 1
  }

  /**
   * 取一个百分位。
   * @param {string} ref
   * @param {number} p 0..1
   * @returns {number | undefined} 无样本时 undefined
   */
  percentile(ref, p) {
    const series = this._series.get(ref)
    if (series === undefined || series.length === 0) return undefined
    const samples = Array.from(series.buffer.subarray(0, series.length)).sort((a, b) => a - b)
    const clamped = Math.min(1, Math.max(0, Number(p)))
    // 最近秩法：p=0.95、20 个样本 → 取第 19 个（下标 18）。
    const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(clamped * samples.length) - 1))
    return samples[index]
  }

  /**
   * 汇总指标。
   * @param {string} ref
   * @returns {{ count: number, p50?: number, p95?: number, p99?: number, min?: number, max?: number }}
   */
  stats(ref) {
    const series = this._series.get(ref)
    if (series === undefined || series.length === 0) return { count: 0 }
    const samples = Array.from(series.buffer.subarray(0, series.length))
    return {
      count: samples.length,
      p50: this.percentile(ref, 0.5),
      p95: this.percentile(ref, 0.95),
      p99: this.percentile(ref, 0.99),
      min: Math.min(...samples),
      max: Math.max(...samples),
    }
  }

  /**
   * 排序用的分数：样本不足时返回 undefined，让调用方把「没数据」和「很快」区分开。
   * @param {string} ref
   * @param {number} [minimumSamples]
   * @returns {number | undefined}
   */
  score(ref, minimumSamples = 3) {
    const series = this._series.get(ref)
    if (series === undefined || series.length < minimumSamples) return undefined
    return this.percentile(ref, 0.95)
  }

  /** @param {string} ref */
  clear(ref) {
    this._series.delete(ref)
  }

  /** 清空全部。 */
  clearAll() {
    this._series.clear()
  }

  /** 供界面使用的快照。 */
  snapshot() {
    /** @type {Record<string, ReturnType<LatencyHistogram['stats']>>} */
    const out = {}
    for (const ref of this._series.keys()) out[ref] = this.stats(ref)
    return out
  }
}
