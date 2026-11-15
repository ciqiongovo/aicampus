import { ipcRenderer } from 'electron'
import { BENCH_IPC, BENCH_PROGRESS_CHANNEL } from '../shared/benchmark'
import type { BenchApi, BenchProgressEvent } from '../shared/benchmark'

/**
 * 对标库 API 工厂：主代理把返回值展开进 window.api（与 RendererApi 合并）。
 * 通道名与 BenchApi 方法名一一对应，按表生成，避免手写漏项。
 *
 * 唯一的例外是进度订阅：它走的是主进程推送，方向与 invoke 相反，
 * 所以单独挂一个方法，不放进 BENCH_IPC 表里。
 */
export function createBenchApi(invoke: (channel: string, ...args: any[]) => Promise<any>): BenchApi {
  const api = Object.fromEntries(
    Object.entries(BENCH_IPC).map(([name, channel]) => [
      name,
      (...args: unknown[]) => invoke(channel, ...args)
    ])
  ) as unknown as BenchApi

  return {
    ...api,
    benchOnProgress: (cb: (e: BenchProgressEvent) => void) => {
      const handler = (_event: unknown, payload: BenchProgressEvent): void => cb(payload)
      ipcRenderer.on(BENCH_PROGRESS_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(BENCH_PROGRESS_CHANNEL, handler)
      }
    }
  }
}
