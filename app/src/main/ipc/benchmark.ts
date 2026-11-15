/**
 * 对标库 IPC 注册。
 *
 * 与 im 模块同样的写法：只依赖一个最小的 ipcMain 接口，不 import electron，
 * 这样这段注册逻辑可以脱离 Electron 单测。真正接入时在 ipc/index.ts 里传真的进来。
 */

import type {
  BenchArticleFilter,
  BenchSourceCategory
} from '../../shared/benchmark'
import { BENCH_IPC, BENCH_PROGRESS_CHANNEL } from '../../shared/benchmark'
import type { BenchmarkService } from '../services/benchmark/service'

export interface BenchIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

function asFilter(value: unknown): BenchArticleFilter {
  const raw = (value ?? {}) as Record<string, unknown>
  const pick = (key: string): string | undefined =>
    typeof raw[key] === 'string' && (raw[key] as string).trim() ? (raw[key] as string) : undefined
  return {
    school: pick('school'),
    kind: pick('kind'),
    from: pick('from'),
    to: pick('to'),
    keyword: pick('keyword'),
    secondNoticeOnly: raw.secondNoticeOnly === true,
    limit: typeof raw.limit === 'number' ? raw.limit : undefined,
    offset: typeof raw.offset === 'number' ? raw.offset : undefined
  }
}

export function registerBenchIpc(ipcMain: BenchIpcMainLike, service: BenchmarkService): void {
  ipcMain.handle(BENCH_IPC.benchSources, () => service.sources())

  ipcMain.handle(BENCH_IPC.benchSourceAdd, (_e, input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>
    return service.addSource({
      ghId: typeof raw.ghId === 'string' ? raw.ghId : undefined,
      name: typeof raw.name === 'string' ? raw.name : '',
      school: typeof raw.school === 'string' ? raw.school : '',
      category: (typeof raw.category === 'string' ? raw.category : 'student_union') as BenchSourceCategory
    })
  })

  ipcMain.handle(BENCH_IPC.benchSourceToggle, (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'number') return false
    service.toggleSource(id, enabled !== false)
    return true
  })

  ipcMain.handle(BENCH_IPC.benchSourceRemove, (_e, id: unknown) => {
    if (typeof id !== 'number') return false
    service.removeSource(id)
    return true
  })

  ipcMain.handle(BENCH_IPC.benchArticles, (_e, filter: unknown) => service.articles(asFilter(filter)))

  ipcMain.handle(BENCH_IPC.benchArticle, (_e, id: unknown) =>
    typeof id === 'number' ? service.article(id) : null
  )

  ipcMain.handle(BENCH_IPC.benchImportLinks, (_e, text: unknown) =>
    service.importLinks(typeof text === 'string' ? text : '')
  )

  ipcMain.handle(BENCH_IPC.benchFetch, (_e, limit: unknown) =>
    service.runFetch(typeof limit === 'number' ? limit : 20)
  )

  ipcMain.handle(BENCH_IPC.benchExtract, (_e, limit: unknown) =>
    service.runExtract(typeof limit === 'number' ? limit : 20)
  )

  ipcMain.handle(BENCH_IPC.benchStats, () => service.stats())
  ipcMain.handle(BENCH_IPC.benchSchools, () => service.schools())
  ipcMain.handle(BENCH_IPC.benchKinds, () => service.kinds())

  ipcMain.handle(BENCH_IPC.benchBrief, (_e, filter: unknown) => service.brief(asFilter(filter)))

  // ---------------- v1.0：按学校采集 ----------------

  ipcMain.handle(BENCH_IPC.benchSchoolList, () => service.schoolList())

  ipcMain.handle(BENCH_IPC.benchSchoolToggle, (_e, name: unknown, enabled: unknown) => {
    if (typeof name !== 'string' || !name.trim()) return false
    service.toggleSchool(name, enabled !== false)
    return true
  })

  ipcMain.handle(BENCH_IPC.benchSchoolHome, (_e, name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) return false
    service.setHomeSchool(name)
    return true
  })

  ipcMain.handle(BENCH_IPC.benchSchoolCandidates, (_e, name: unknown) =>
    typeof name === 'string' ? service.candidates(name) : []
  )

  ipcMain.handle(
    BENCH_IPC.benchDiscover,
    async (event: unknown, name: unknown, accounts: unknown) => {
      if (typeof name !== 'string' || !name.trim()) throw new Error('没指定学校')
      const list = Array.isArray(accounts)
        ? accounts.filter((a): a is string => typeof a === 'string')
        : undefined
      // 进度往发起调用的那个窗口回推：多窗口时不能广播到别人那儿去
      const send = (event as { sender?: { send?: (channel: string, payload: unknown) => void } })
        ?.sender?.send
      return service.discover(name, list, (p) => {
        send?.(BENCH_PROGRESS_CHANNEL, { school: name, ...p })
      })
    }
  )

  ipcMain.handle(BENCH_IPC.benchProspects, (_e, school: unknown) =>
    service.prospects(typeof school === 'string' && school.trim() ? school : undefined)
  )

  ipcMain.handle(BENCH_IPC.benchSeedImport, (_e, school: unknown) =>
    service.seedImport(typeof school === 'string' && school.trim() ? school : undefined)
  )

  ipcMain.handle(BENCH_IPC.benchHomeCompare, (_e, articleId: unknown) =>
    typeof articleId === 'number' ? service.homeCompare(articleId) : []
  )
}
