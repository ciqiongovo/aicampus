/**
 * 按学校做「深度采集」：一个号翻到底，正文一并入库。
 *
 * 和 discover.ts 的区别：
 * - discover.ts 只做「发现」——搜到链接就入队，正文留到后面手动跑队列。
 *   它的定位是快、省配额、能随时停，适合日常用。
 * - 这里做「一次采到底」——搜到的每一篇当场打开、取正文、落库。
 *   慢得多（每篇一次浏览器渲染），但采完就是能直接用的数据，
 *   不用再点第二次。适合汇报前把某几所学校的数据补齐。
 *
 * 为什么要搜狗：百度只索引了被收录的那几条，一个号常年个位数；
 * 搜狗微信搜索同一个号能翻到近百条，而且结果自带号名和精确时间，
 * 不用再靠「校名+学生会」去猜。两条通道并存，搜狗为主，百度留着兜底。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { BenchDiscoverResult } from '../../../shared/benchmark'
import {
  belongsToSchool,
  candidateAccounts,
  categoryOfOrg,
  findSchool,
  mergeAccounts
} from '../../../shared/schools'
import {
  ensureSourceByName,
  enqueueArticle,
  knownAccountsOf,
  markProspect,
  upsertProspects
} from '../../db/dao/benchmarkDao'
import {
  SogouSession,
  alreadyHave,
  fetchViaSogou
} from './sogou'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 两篇之间歇一下。公众号页面按出口 IP 有阈值，连着开会被判成机器 */
const ARTICLE_GAP_MIN_MS = 1800
const ARTICLE_GAP_MAX_MS = 3200

/** 一次最多采多少个号。不设上限会让「点一下」变成几小时的无人值守任务 */
export const DEEP_ACCOUNT_LIMIT = 6

export interface DeepProgress {
  /** 第几个号 */
  current: number
  total: number
  account: string
  /** 这个号里第几篇 */
  articleIndex: number
  articleTotal: number
  note: string
}

export interface DeepOptions {
  school: string
  /** 指定号名；不传就按命名套路生成 */
  accounts?: string[]
  /** 采几个号 */
  limit?: number
  /** 每个号最多采几篇。留空表示翻到搜狗的底（约 100 篇） */
  perAccount?: number
  onProgress?: (p: DeepProgress) => void
  /** 外部喊停。采到一半要能停，否则关窗口也停不下来 */
  shouldStop?: () => boolean
}

/**
 * 采一所学校。
 *
 * 每个号先把结果页翻完（10 页封顶），再逐条打开。
 * 顺序上有意「先翻完再打开」：翻页只要 HTTP，很快；
 * 打开文章才慢。先知道总数，进度条才不是骗人的。
 */
export async function deepCollectSchool(
  db: DatabaseSync,
  options: DeepOptions
): Promise<BenchDiscoverResult & { fetched: number; accountsHit: number }> {
  const school = options.school.trim()
  if (!school) throw new Error('没指定学校')

  const limit = Math.min(Math.max(options.limit ?? 3, 1), DEEP_ACCOUNT_LIMIT)
  // 用户手动点的号名原样信任；自动跑的号名要过一遍归属校验，
  // 免得把旧版记下来的脏号（外校号、中学号）一路采下去
  const manual = options.accounts?.length ? options.accounts.map((a) => a.trim()).filter(Boolean) : []
  const known = knownAccountsOf(db, school).filter((n) => belongsToSchool(n, school))
  const accounts = (manual.length
    ? manual
    : mergeAccounts(known, candidateAccounts(findSchool(school)))
  ).slice(0, limit)

  upsertProspects(db, school, accounts.map((name) => ({ name, category: categoryOfOrg(name) })))

  const session = new SogouSession()
  // 第一件事：让外部浏览器去访问一次搜狗。少了这一步，后面每次打开中转地址
  // 都只会拿到一个空壳模板——正文一个字都没有，还查不出原因。
  await session.primeBrowser(accounts[0] ?? school)

  let requests = 0
  let accepted = 0
  let duplicated = 0
  let fetched = 0
  let accountsHit = 0
  let blocked = false

  for (const [index, account] of accounts.entries()) {
    if (options.shouldStop?.()) break

    options.onProgress?.({
      current: index + 1,
      total: accounts.length,
      account,
      articleIndex: 0,
      articleTotal: 0,
      note: '正在翻检索结果'
    })

    const search = await session.searchAll(account, (page, got) => {
      requests += 1
      options.onProgress?.({
        current: index + 1,
        total: accounts.length,
        account,
        articleIndex: 0,
        articleTotal: 0,
        note: `第 ${page} 页，本页 ${got} 篇`
      })
    })

    if (search.blocked) {
      markProspect(db, school, account, { status: 'blocked', hitCount: 0, note: '搜狗要求验证' })
      blocked = true
      break
    }

    if (!search.items.length) {
      markProspect(db, school, account, {
        status: 'empty',
        hitCount: 0,
        note: search.error || '没搜到这个号'
      })
      continue
    }

    accountsHit += 1
    // 号名以搜狗认下的为准：用户猜的「XX大学学生会」可能真名是「团聚XX」
    const canonical = search.canonical || account
    // 双保险：搜狗认出来的号如果明显不属于这所学校，这一批就不收了
    if (!manual.length && !belongsToSchool(canonical, school)) {
      accountsHit -= 1
      markProspect(db, school, canonical, {
        status: 'empty',
        hitCount: 0,
        note: `「${canonical}」看着不是这所学校的号，已跳过`
      })
      continue
    }
    const sourceId = ensureSourceByName(db, canonical, school)
    // 试采只要几篇时，别为了「看一眼效果」先把一百篇全翻出来
    const queue = options.perAccount ? search.items.slice(0, options.perAccount) : search.items
    let fresh = 0
    let failed = 0

    for (const [i, item] of queue.entries()) {
      if (options.shouldStop?.()) break

      options.onProgress?.({
        current: index + 1,
        total: accounts.length,
        account: canonical,
        articleIndex: i + 1,
        articleTotal: queue.length,
        note: item.title.slice(0, 30)
      })

      const midUrl = await session.resolve(item)
      let article = await fetchViaSogou(midUrl, item)
      // 中转链会过期（signature 带时间戳）。第一次落空时重取一次跳转，
      // 还是不行就记成没拿到，不要拿空正文入库把状态写脏。
      if (article.status === 'unreachable' && !article.body) {
        await sleep(1200)
        const again = await session.resolve(item)
        if (again && again !== midUrl) article = await fetchViaSogou(again, item)
      }

      const key = article.urlKey || (item.fingerprint ? `sogou:${item.fingerprint}` : '')
      if (!key) {
        failed += 1
        continue
      }
      if (alreadyHave(db, article)) {
        duplicated += 1
        continue
      }

      const added = enqueueArticle(db, {
        urlKey: key,
        url: article.url || midUrl,
        sourceId,
        hintSchool: school,
        title: article.title || item.title,
        publishedAt: article.publishedAt ?? item.publishedAt
      })
      if (!added) {
        duplicated += 1
        continue
      }
      accepted += 1
      fresh += 1

      // 正文当场写进去。这一步之后这篇就是「已拿到」，不再占着待采集的队列
      if (article.body && (article.status === 'ok' || article.status === 'deleted')) {
        const row = db.prepare('SELECT id FROM bench_article WHERE url_key = ?').get(key) as
          | { id: number }
          | undefined
        if (row) {
          db.prepare(
            `UPDATE bench_article
                SET body = ?, author = ?, status = ?, fetched_at = ?, error = ?
              WHERE id = ?`
          ).run(
            article.body,
            article.author,
            article.status === 'deleted' ? 'deleted' : 'fetched',
            new Date().toISOString().slice(0, 19).replace('T', ' '),
            article.error,
            row.id
          )
          if (article.status === 'ok') fetched += 1
        }
      } else if (article.error) {
        db.prepare("UPDATE bench_article SET error = ? WHERE url_key = ?").run(
          article.error.slice(0, 120),
          key
        )
      }

      await sleep(ARTICLE_GAP_MIN_MS + Math.random() * (ARTICLE_GAP_MAX_MS - ARTICLE_GAP_MIN_MS))
    }

    markProspect(db, school, canonical, {
      status: 'found',
      hitCount: search.items.length,
      note: `搜到 ${search.items.length} 篇，新入库 ${fresh} 篇`
    })
  }

  const message = blocked
    ? '搜狗要求验证，先停一停。过半小时再点，别连着试。'
    : accountsHit === 0
      ? '这几个号名都没搜到。号名对不上，可以改成它的真名（比如「团聚上大」这种花名）再试。'
      : `搜了 ${accountsHit} 个号，新入库 ${accepted} 篇，其中 ${fetched} 篇已拿到正文。`

  return { requests, accepted, duplicated, accountsHit, blocked, message, fetched }
}
