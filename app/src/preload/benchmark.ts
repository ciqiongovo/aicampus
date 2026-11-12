import { BENCH_IPC } from '../shared/benchmark'
import type { BenchApi } from '../shared/benchmark'

/**
 * 对标库 API 工厂：主代理把返回值展开进 window.api（与 RendererApi 合并）。
 * 通道名与 BenchApi 方法名一一对应，按表生成，避免手写漏项。
 */
export function createBenchApi(invoke: (channel: string, ...args: any[]) => Promise<any>): BenchApi {
  return Object.fromEntries(
    Object.entries(BENCH_IPC).map(([name, channel]) => [
      name,
      (...args: unknown[]) => invoke(channel, ...args)
    ])
  ) as unknown as BenchApi
}
