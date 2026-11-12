import { Notification } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { getItem, listPending, markFired } from '../../db'

const SCAN_INTERVAL_MS = 60_000
const DELIVERY_TIMEOUT_MS = 30_000

type PendingDelivery = { notification: Notification; cancel: () => void }

/** 调度器运行所需的最小设置快照（A6） */
export interface SchedulerSettings {
  reminderEnabled: boolean
}

/** 主进程提醒调度器：定期补扫到期提醒，仅收到 show 才记为成功。 */
export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly inflight = new Map<number, PendingDelivery>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly getSettings: () => SchedulerSettings
  ) {}

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), SCAN_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // 退出时不写数据库；保留 pending 供下次启动补扫。
    for (const delivery of this.inflight.values()) delivery.cancel()
    this.inflight.clear()
  }

  /** 单条异常不阻塞其余提醒；未决通知跨扫描去重并持有强引用。 */
  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    // A6：通知开关关闭时不扫描、不发送（已有 inflight 由 stop/超时自然收敛）
    if (!this.getSettings().reminderEnabled) {
      this.running = false
      return
    }
    const record = (id: number, error: string | null): void => {
      try {
        markFired(this.db, id, error)
      } catch (writeError) {
        console.error('[reminders] 提醒结果写入失败：', writeError)
      }
    }
    try {
      const due = listPending(this.db, new Date().toISOString())
      for (const r of due) {
        if (this.inflight.has(r.id)) continue
        try {
          const item = getItem(this.db, r.item_id)
          const body = item ? item.title : '你有一条到期待办提醒'
          if (!Notification.isSupported()) {
            record(r.id, '系统不支持桌面通知')
            continue
          }
          const notification = new Notification({ title: 'InfoAgent 提醒', body })
          let settled = false
          let timeout: NodeJS.Timeout | null = null
          const cleanup = (): void => {
            if (timeout) clearTimeout(timeout)
            timeout = null
            notification.removeListener('show', onShow)
            notification.removeListener('failed', onFailed)
            this.inflight.delete(r.id)
          }
          const settle = (error: string | null): void => {
            if (settled) return
            settled = true
            cleanup()
            record(r.id, error)
          }
          const onShow = (): void => settle(null)
          const onFailed = (_event: unknown, error: string): void => settle(`通知发送失败：${error}`)
          const cancel = (): void => {
            settled = true
            cleanup()
            try { notification.close() } catch { /* 退出清理不得阻止其它通知清理 */ }
          }
          this.inflight.set(r.id, { notification, cancel })
          notification.on('show', onShow)
          notification.on('failed', onFailed)
          timeout = setTimeout(() => settle('通知发送超时'), DELIVERY_TIMEOUT_MS)
          try {
            notification.show()
          } catch (error) {
            settle(error instanceof Error ? error.message : String(error))
          }
        } catch (error) {
          record(r.id, error instanceof Error ? error.message : String(error))
        }
      }
    } catch (error) {
      console.error('[reminders] 到期提醒扫描失败：', error)
    } finally {
      this.running = false
    }
  }
}
