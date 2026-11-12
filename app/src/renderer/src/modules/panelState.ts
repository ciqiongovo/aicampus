import type { PanelApi, PanelOverview, PanelOverviewQuery, PanelRecommendation } from '../../../shared/panel'

const MAX_CACHED_VIEWS = 6
const MAX_CACHED_CARDS = 180
export const PANEL_PAGE_SIZE = 30

function sameFields<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[]
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** IPC clones rows. Reuse unchanged objects so memoized cards actually skip work. */
export function sharePanelRows(previous: PanelOverview | null, next: PanelOverview): PanelOverview {
  if (!previous) return next
  const old = new Map(previous.recommendations.map((item) => [item.id, item]))
  return {
    ...next,
    recommendations: next.recommendations.map((item) => {
      const existing = old.get(item.id)
      return existing && sameFields(existing, item) ? existing : item
    })
  }
}

/** Exact-query, session-only LRU. Never persist email content or guess source counters. */
export class PanelMemoryCache {
  private entries = new Map<string, PanelOverview>()

  get(key: string): PanelOverview | undefined {
    const value = this.entries.get(key)
    if (value) {
      this.entries.delete(key)
      this.entries.set(key, value)
    }
    return value
  }

  put(key: string, value: PanelOverview): void {
    this.entries.delete(key)
    if (value.recommendations.length > MAX_CACHED_CARDS) return
    this.entries.set(key, value)
    let cards = [...this.entries.values()].reduce((sum, entry) => sum + entry.recommendations.length, 0)
    while (this.entries.size > MAX_CACHED_VIEWS || cards > MAX_CACHED_CARDS) {
      const oldest = this.entries.keys().next().value!
      cards -= this.entries.get(oldest)!.recommendations.length
      this.entries.delete(oldest)
    }
  }

  clear(): void { this.entries.clear() }
}

interface SessionEvents {
  overview: (data: PanelOverview | null) => void
  loading: (loading: boolean) => void
  error: (message: string) => void
}

/** No shared FIFO: model latency must not hold up an action or a source selection.
 * Epochs fence source/query, visibility and mutations; each request lane is single-flight.
 */
export class PanelDataSession {
  private live = false
  private active = false
  private source: string | undefined
  private query: PanelOverviewQuery = { limit: PANEL_PAGE_SIZE }
  private epoch = 0
  private sequence = 0
  private committedSequence = 0
  private current: PanelOverview | null = null
  private cache = new PanelMemoryCache()
  private readFlight: Promise<void> | null = null
  private generationFlight: Promise<void> | null = null
  private generationEpoch = 0
  private pendingRead = false
  private pendingGeneration = false
  private mutating = false

  constructor(private api: Pick<PanelApi, 'panelOverview'>, private events: SessionEvents) {}

  start(): void { this.live = true }

  stop(): void {
    this.live = false
    this.active = false
    this.epoch += 1
    this.pendingRead = this.pendingGeneration = false
  }

  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.epoch += 1
    if (active) this.readThenGenerate()
    else {
      this.pendingRead = this.pendingGeneration = false
      this.events.loading(false)
    }
  }

  private cacheKey(): string { return JSON.stringify([this.source, this.query.priority, this.query.beforeInfoId, this.query.mailDateRange]) }

  selectView(source: string | undefined, priority?: PanelRecommendation['priority'], beforeInfoId?: number, mailDateRange?: PanelOverviewQuery['mailDateRange']): void {
    if (source === this.source && priority === this.query.priority && beforeInfoId === this.query.beforeInfoId && mailDateRange === this.query.mailDateRange) return
    this.source = source
    this.query = { limit: PANEL_PAGE_SIZE, priority, beforeInfoId, ...(mailDateRange === undefined ? {} : { mailDateRange }) }
    this.epoch += 1
    this.current = this.cache.get(this.cacheKey()) ?? null
    this.events.overview(this.current)
    this.events.error('')
    this.readThenGenerate()
  }

  private available(): boolean { return this.live && this.active && !this.mutating }

  private readThenGenerate(): void {
    if (!this.available()) return
    const epoch = this.epoch
    void this.read().then(() => { if (epoch === this.epoch) this.generate() })
  }

  private token(): { key: string | undefined; query: PanelOverviewQuery; valid: () => boolean; sequence: number } {
    const key = this.source
    const query = this.query
    const epoch = this.epoch
    const sequence = ++this.sequence
    return { key, query, sequence, valid: () => this.live && this.active && epoch === this.epoch }
  }

  private commit(data: PanelOverview, sequence: number, generated = false): void {
    if (sequence < this.committedSequence) return
    this.committedSequence = sequence
    // Generation can observe actions from other views. Do not keep their old cards cached.
    if (generated) this.cache.clear()
    this.current = sharePanelRows(this.current, data)
    this.cache.put(this.cacheKey(), this.current)
    this.events.overview(this.current)
    this.events.error('')
    this.events.loading(false)
  }

  private read(): Promise<void> {
    if (!this.available()) return Promise.resolve()
    if (this.readFlight) {
      this.pendingRead = true
      return this.readFlight
    }
    const token = this.token()
    this.events.loading(!this.current)
    this.readFlight = this.api.panelOverview(token.key, false, token.query)
      .then((data) => { if (token.valid()) this.commit(data, token.sequence) })
      .catch((error: unknown) => { if (token.valid()) this.events.error(String(error instanceof Error ? error.message : error)) })
      .finally(() => {
        this.readFlight = null
        if (token.valid()) this.events.loading(false)
        if (this.pendingRead && this.available()) {
          this.pendingRead = false
          this.readThenGenerate()
        }
      })
    return this.readFlight
  }

  /** Poll/focus/refresh consumes generation response directly; no trailing reread. */
  generate = (reportError = false): void => {
    if (!this.available()) return
    if (this.generationFlight) {
      this.pendingGeneration = this.pendingGeneration || this.generationEpoch !== this.epoch
      return
    }
    const token = this.token()
    this.generationEpoch = this.epoch
    this.events.loading(!this.current || reportError)
    this.generationFlight = this.api.panelOverview(token.key, true, token.query)
      .then((data) => { if (token.valid()) this.commit(data, token.sequence, true) })
      .catch((error: unknown) => {
        if (token.valid() && reportError) this.events.error(String(error instanceof Error ? error.message : error))
      })
      .finally(() => {
        this.generationFlight = null
        if (token.valid()) this.events.loading(false)
        if (this.pendingGeneration && this.available()) {
          this.pendingGeneration = false
          this.generate()
        }
      })
  }

  /** Actions bypass model generation; continue waits only for the single model lane. */
  async mutate(operation: (key: string | undefined, query: PanelOverviewQuery) => Promise<PanelOverview | undefined>, waitForGeneration = false): Promise<boolean> {
    if (!this.available()) return false
    this.mutating = true
    this.epoch += 1
    this.cache.clear()
    this.pendingRead = this.pendingGeneration = false
    const token = this.token()
    try {
      if (waitForGeneration) {
        await this.generationFlight
        // Never start another generation after an await if source/route/visibility changed.
        if (!token.valid()) return false
      }
      const data = await operation(token.key, token.query)
      if (data && token.valid()) this.commit(data, token.sequence)
    } finally {
      this.mutating = false
      if (token.valid()) this.events.loading(false)
      if (!token.valid() && this.available()) this.readThenGenerate()
    }
    return true
  }

  removeHandled(id: PanelRecommendation['id']): void {
    this.cache.clear()
    if (!this.current || !this.live) return
    this.current = { ...this.current, recommendations: this.current.recommendations.filter((item) => item.id !== id) }
    this.events.overview(this.current)
  }
}
