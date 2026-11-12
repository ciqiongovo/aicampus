import { IM_IPC } from '../shared/im'
import type { ImApi } from '../shared/im'

/**
 * IM（微信/QQ 聊天记录）API 工厂：主代理把返回值展开进 window.api（与 RendererApi 合并）。
 * 通道名与 ImApi 方法名一一对应，直接按表生成，避免手写漏项。
 */
export function createImApi(invoke: (channel: string, ...args: any[]) => Promise<any>): ImApi {
  const api = Object.fromEntries(
    Object.entries(IM_IPC).map(([name, channel]) => [name, (...args: unknown[]) => invoke(channel, ...args)])
  ) as unknown as ImApi
  return api
}
