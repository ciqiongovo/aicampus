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

/**
 * 选文件并读出文本的能力，由宿主注入。
 *
 * 不直接 import electron：这段注册逻辑要能脱离 Electron 单测，
 * 「弹框、读盘」本来也是宿主的事，服务层不该知道窗口在哪。
 */
export interface BenchFilePicker {
  pickTextFile?: () => Promise<{ path: string; text: string } | null>
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

/**
 * 进度只推给发起调用的那个窗口。
 *
 * 多开窗口时广播到别人那儿去，会让人在没点过任何按钮的窗口里看到进度条乱跑。
 */
function progressTo(event: unknown, label: string) {
  const sender = (event as { sender?: { send?: (channel: string, payload: unknown) => void } })
    ?.sender
  return (p: { current: number; total: number; account: string; note: string }): void => {
    // 必须写成 sender.send(...) 而不是先把 send 取出来再调：
    // WebContents.send 依赖 this，取出来单独调会变成 undefined，报
    // "Cannot read properties of undefined (reading '_sendToMainFrame')"。
    sender?.send?.(BENCH_PROGRESS_CHANNEL, { school: label, ...p })
  }
}

export function registerBenchIpc(
  ipcMain: BenchIpcMainLike,
  service: BenchmarkService,
  deps: BenchFilePicker = {}
): void {
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

  /**
   * 整份文件导入。
   *
   * 工具导出的列表动辄几千行，粘贴框扛不住，也不该让人手动复制。
   * 取消选文件不算失败，返回 canceled 让界面安静地什么都不做。
   */
  ipcMain.handle(BENCH_IPC.benchImportFile, async () => {
    const empty = { canceled: true, file: '', accepted: 0, duplicated: 0, invalid: 0 }
    if (!deps.pickTextFile) return empty
    const picked = await deps.pickTextFile()
    if (!picked) return empty
    return { canceled: false, file: picked.path, ...service.importLinks(picked.text) }
  })

  ipcMain.handle(BENCH_IPC.benchFetch, (_e, limit: unknown) =>
    service.runFetch(typeof limit === 'number' ? limit : 20, progressTo(_e, '采集正文'))
  )

  ipcMain.handle(BENCH_IPC.benchExtract, (_e, limit: unknown) =>
    service.runExtract(typeof limit === 'number' ? limit : 20, progressTo(_e, '抽字段'))
  )

  ipcMain.handle(BENCH_IPC.benchStats, () => service.stats())
  ipcMain.handle(BENCH_IPC.benchSchools, () => service.schools())
  ipcMain.handle(BENCH_IPC.benchKinds, () => service.kinds())

  ipcMain.handle(BENCH_IPC.benchBrief, (_e, filter: unknown) => service.brief(asFilter(filter)))
  ipcMain.handle(BENCH_IPC.benchReport, (_e, filter: unknown) => service.report(asFilter(filter)))

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
      const sender = (event as { sender?: { send?: (channel: string, payload: unknown) => void } })
        ?.sender
      return service.discover(name, list, (p) => {
        // 同 progressTo：方法要带着 this 调，不能先把函数取出来
        sender?.send?.(BENCH_PROGRESS_CHANNEL, { school: name, ...p })
      })
    }
  )

  ipcMain.handle(BENCH_IPC.benchProspects, (_e, school: unknown) =>
    service.prospects(typeof school === 'string' && school.trim() ? school : undefined)
  )

  ipcMain.handle(BENCH_IPC.benchSeedImport, (_e, school: unknown) =>
    service.seedImport(typeof school === 'string' && school.trim() ? school : undefined)
  )

  ipcMain.handle(BENCH_IPC.benchAudit, () => service.audit())

  // 入参来自渲染进程，只能当它是「一串不知道是什么的东西」处理：
  // 过滤掉非整数，别把 NaN 带进 SQL 参数
  ipcMain.handle(BENCH_IPC.benchMarkNotActivity, (_e, id: unknown) => {
    const aid = Number(id)
    if (!Number.isInteger(aid) || aid <= 0) return false
    return service.markNotActivity(aid)
  })

  ipcMain.handle(BENCH_IPC.benchMarkNotActivityMany, (_e, ids: unknown) =>
    service.markNotActivityMany(
      Array.isArray(ids) ? ids.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0) : []
    )
  )

  ipcMain.handle(BENCH_IPC.benchSourceSchool, (_e, id: unknown, school: unknown) => {
    const sid = Number(id)
    if (!Number.isInteger(sid) || sid <= 0) return false
    return service.setSourceSchool(sid, typeof school === 'string' ? school : '')
  })

  ipcMain.handle(BENCH_IPC.benchPurgeSources, (_e, ids: unknown) =>
    service.purgeSources(
      Array.isArray(ids) ? ids.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0) : []
    )
  )

  ipcMain.handle(BENCH_IPC.benchHomeCompare, (_e, articleId: unknown) =>
    typeof articleId === 'number' ? service.homeCompare(articleId) : []
  )
}
