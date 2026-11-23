/**
 * 搜狗微信检索通道。
 *
 * 为什么要另开一条：原来只走百度，一个号一年发几十条，百度收录的常常只有个位数，
 * 「跨校对标」拿到的样本太薄。搜狗微信搜索是另一套索引，能按公众号名检索、
 * 一个号翻到 10 页约 100 条，而且结果自带公众号名和精确发布时间。
 *
 * 链路（每一环都实测过，不是照着文档写的）：
 * 1. 打开 weixin.sogou.com 的搜索结果页 → 拿到条目（标题 / 号名 / 时间 / 跳转链 / 指纹）
 * 2. 带 cookie 请求 /link?url=… → 返回一段把地址切片拼接的 JS，拼出中转地址
 *    直接请求会掉进 antispider 验证页，必须先在同一个会话里取过搜索页的 cookie
 * 3. 用同一个浏览器配置渲染中转地址 → 得到完整文章页
 *    这一步不能省：中转地址带 src=11，裸请求一律返回「环境异常」；
 *    而浏览器配置里若没有搜狗会话，也只拿到一个空壳模板
 * 4. 从文章页里取 __biz / mid / idx 合成规范地址，正文与标题交给 judgePage 判定
 *
 * 规范地址很重要：中转地址的 signature 会过期，存下来过几天就打不开了；
 * __biz+mid+idx 是永久的，也正好是库里 articleUrlKey 用的去重键。
 *
 * 边界（必须让用户知道）：
 * - 一个号最多 10 页 ≈ 100 条，这是搜狗的硬顶，翻第 11 页返回空；
 * - 拿到的是「搜狗收录过的文章」，不等于该号全部历史；
 * - 每个号要开 100 次浏览器，慢是必然的，所以采集放进后台队列跑。
 */

import type { DatabaseSync } from 'node:sqlite'
import { articleUrlKey, parsePublishTime } from '../../../shared/benchmark'
import { parseArticleHtml, renderHtml } from './render-edge'
import { judgePage, type FetchOutcome } from './page'

/** 搜狗微信搜索的硬顶：第 11 页起返回空 */
export const SOGOU_MAX_PAGE = 10

/** 每页 10 条，这是搜狗自己的分页大小，改不了 */
const PER_PAGE = 10

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 搜索页与 /link 之间的间隔。太快会掉进 antispider，慢一点整体更稳 */
const LINK_GAP_MIN_MS = 900
const LINK_GAP_MAX_MS = 1800

export interface SogouItem {
  title: string
  /** 公众号名，结果条目里自带，不用猜 */
  account: string
  /** 精确到秒的发布时间；搜狗给的是 Unix 秒 */
  publishedAt: string | null
  /** 搜狗的文章指纹（li 的 d 属性），用于在没有规范地址前先去重 */
  fingerprint: string
  /** 相对地址 /link?url=…&token=… */
  link: string
  /**
   * 抓到这一条时那页的会话 cookie。
   *
   * 必须跟着条目走，不能用「当前最新的 cookie」去解：搜狗翻页会换 SNUID，
   * 而跳转链里的 token 掺了当时 SNUID 的字符，拿新会话去解只会被当成盗链，
   * 返回验证页。这个坑很隐蔽——单独测第一页永远正常，一翻页就全解不开。
   */
  cookie: string
}

export interface SogouSearchResult {
  items: SogouItem[]
  /** 这一轮实际认下的公众号名：搜狗会把别号的稿子按相关度混进来，要剔掉 */
  canonical: string
  /** 被反爬拦住：这时继续翻页只会把冷却时间拖得更长 */
  blocked: boolean
  error: string
}

/**
 * 从一批结果里认出「这次搜的到底是哪个号」。
 *
 * 搜狗的结果是按相关度排的，不是按号排的：查「上海科技大学学生会」，
 * 第一页里会混进「自主选拔在线」「高校人才网V」发的、标题里带校名的稿子。
 * 不剔除就会把别校别号的文章算进这个学校，做出来的对标是错的。
 *
 * 判定顺序：
 * 1. 有两条以上号名跟查询词完全一致 → 就是这个号，直接用（最常见）
 * 2. 否则取出现次数最多的号名，但要出现两次以上、且与查询词共享关键词，
 *    免得把「某校招生办」的一篇稿子认成学生会的号
 * 3. 都不成立 → 认不出，返回空，让上层报「这个号名搜不到」，而不是硬收一堆噪声
 */
export function pickCanonical(items: SogouItem[], query: string): string {
  const norm = (s: string): string => s.replace(/\s+/g, '').trim()
  const q = norm(query)
  if (!q) return ''

  const counts = new Map<string, number>()
  for (const it of items) {
    const n = norm(it.account)
    if (!n) continue
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }

  const exact = items.filter((it) => norm(it.account) === q)
  // 只要有一条号名跟查询词一字不差，就是这个号。
  // 这里不能要求「出现两次以上」：搜「上海交通大学学生会」时，结果里
  // 高频出现的往往是「上海交通大学」这个学校官号，按频次取会把官号认成学生会。
  if (exact.length >= 1) return q

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const [top, hits] = ranked[0] ?? ['', 0]
  if (!top || hits < 2) return ''
  // 只有在号名比查询词「更详细」时才认（查「上大」，认「团聚上大」）。
  // 反过来不认：查「上海交通大学学生会」时若只搜到「上海交通大学」，
  // 那是学校官号，把它的稿子当成学生会的对标对象是错的——宁可报「没找到这个号」，
  // 让用户换个名字，也不要拿官号数据充数。
  return top.length > q.length && top.includes(q) ? top : ''
}

/** 剥掉高亮用的 <em>、实体和多余空白 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 解析搜索结果页。
 *
 * 只认 `sogou_vr_…_box_N` 这种条目容器——搜狗的结构几年没变，
 * 但也不值得为它写通用 DOM 解析。结构真变了，这里只会返回空数组，
 * 不会返回半截错误数据，上层据此提示「换个检索词」而不是「采集失败」。
 */
export function parseSogouItems(html: string): SogouItem[] {
  const out: SogouItem[] = []
  const blocks = [...html.matchAll(/<li[^>]*id="sogou_vr_[\d_]*box_(\d+)"([\s\S]*?)<\/li>/g)]
  for (const [, , inner] of blocks) {
    const linkMatch = inner.match(/href="(\/link\?url=[^"]+)"/)
    if (!linkMatch) continue
    const titleMatch = inner.match(/id="sogou_vr_[\d_]*title_\d+"[^>]*>([\s\S]*?)<\/a>/)
    const accountMatch = inner.match(/class="all-time-y2"[^>]*>([\s\S]*?)<\/span>/)
    const timeMatch = inner.match(/timeConvert\('(\d+)'\)/)

    const title = titleMatch ? textOf(titleMatch[1]) : ''
    if (!title) continue

    let publishedAt: string | null = null
    if (timeMatch) {
      const d = new Date(Number(timeMatch[1]) * 1000)
      if (!Number.isNaN(d.getTime())) {
        const p = (n: number): string => String(n).padStart(2, '0')
        publishedAt =
          `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
          `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      }
    }

    out.push({
      title,
      account: accountMatch ? textOf(accountMatch[1]) : '',
      publishedAt,
      fingerprint: '',
      link: linkMatch[1].replace(/&amp;/g, '&'),
      cookie: ''
    })
  }

  // 指纹在 li 开标签上（d="…"），上面按块切的时候没留住，这里按顺序补回去
  const ds = [...html.matchAll(/<li[^>]*id="sogou_vr_[\d_]*box_\d+"[^>]*d="([^"]+)"/g)].map((m) => m[1])
  out.forEach((item, i) => {
    item.fingerprint = ds[i] ?? ''
  })

  return out
}

/**
 * 搜狗会话。
 *
 * cookie 只活在一次检索任务里：搜狗按 IP + cookie 判访客，
 * 复用一个会话翻十页比每页重新握手稳得多。
 */
export class SogouSession {
  private cookie = ''
  /** 已经建过浏览器会话的那一页地址，避免重复开浏览器 */
  private primed = false

  /** 搜一页。account 传公众号名（不加引号，加了反而搜不到） */
  async search(account: string, page = 1): Promise<{ items: SogouItem[]; blocked: boolean; error: string }> {
    const query = encodeURIComponent(account)
    const url = `https://weixin.sogou.com/weixin?type=2&query=${query}&page=${page}`
    let html = ''
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...(page > 1 ? { Referer: 'https://weixin.sogou.com/weixin?type=2&query=' + query } : {})
        }
      })
      const setCookie = res.headers.getSetCookie?.() ?? []
      if (setCookie.length) {
        this.cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
      }
      if (!res.ok) return { items: [], blocked: false, error: `搜狗返回 ${res.status}` }
      html = await res.text()
    } catch (error) {
      return { items: [], blocked: false, error: (error as Error).message.slice(0, 80) }
    }

    const items = parseSogouItems(html)
    // 把这一页的会话记到每条上，翻页换了 cookie 也还能回头去解
    for (const it of items) it.cookie = this.cookie
    // 有条目就不是被拦。一条都没有且页面出现验证特征，才判为反爬
    const blocked = items.length === 0 && /antispider|请输入验证码|verify\.css/.test(html)
    return { items, blocked, error: blocked ? '' : items.length ? '' : '这一页没有结果' }
  }

  /**
   * 翻到没结果或到 10 页为止，返回属于这个号的条目。
   *
   * 第一页先认号（搜狗结果按相关度排，混着别号的稿子），
   * 认出来之后每一页都只留这个号的，最后按指纹去重——
   * 同一篇在搜狗里可能因为转发出现在两条结果里。
   */
  async searchAll(
    account: string,
    onPage?: (page: number, got: number) => void
  ): Promise<SogouSearchResult> {
    let canonical = ''
    const all: SogouItem[] = []
    const seen = new Set<string>()

    for (let page = 1; page <= SOGOU_MAX_PAGE; page++) {
      if (page > 1) await sleep(LINK_GAP_MIN_MS + Math.random() * (LINK_GAP_MAX_MS - LINK_GAP_MIN_MS))
      const r = await this.search(account, page)
      if (r.blocked) return { items: all, canonical, blocked: true, error: '搜狗要求验证，先停一停' }
      if (r.items.length === 0) break

      // 第一页定调：认不出这个号，后面翻得再多也是别家的稿子
      if (page === 1) {
        canonical = pickCanonical(r.items, account)
        if (!canonical) {
          onPage?.(page, 0)
          return { items: [], canonical: '', blocked: false, error: '没认出这个公众号，换个号名再试' }
        }
      }

      let got = 0
      for (const it of r.items) {
        if (it.account.replace(/\s+/g, '') !== canonical) continue
        const id = it.fingerprint || it.link
        if (seen.has(id)) continue
        seen.add(id)
        all.push(it)
        got += 1
      }
      onPage?.(page, got)
      // 不满一页说明到底了，没必要再翻
      if (r.items.length < PER_PAGE) break
    }

    return { items: all, canonical, blocked: false, error: all.length ? '' : '这个号没有被搜狗收录的文章' }
  }

  /**
   * 把 /link?url=… 解成中转地址。
   *
   * 搜狗的跳转页不是 302，而是一段把地址切成十几段再拼回去的 JS
   * （`url += 'https://mp.'; url += 'weixin.qq.c'; …`）。
   * 把片段按顺序接起来就是地址；页面同时还发一个 approve 统计请求，
   * 漏了它下次就直接掉进验证页，所以按原样请求一次即可。
   */
  async resolve(item: SogouItem): Promise<string> {
    if (item.link.startsWith('http')) return item.link
    // 用「抓到这一条时」的会话，不是当前最新的：翻页会换 SNUID，
    // 新会话解旧 token 会被当成盗链
    const cookie = item.cookie || this.cookie
    try {
      const res = await fetch('https://weixin.sogou.com' + item.link, {
        headers: {
          'User-Agent': DESKTOP_UA,
          Referer: 'https://weixin.sogou.com/',
          ...(cookie ? { Cookie: cookie } : {})
        }
      })
      const body = await res.text()
      if (/antispider|verify\.css/.test(body)) return ''
      const parts = [...body.matchAll(/url \+= '([^']*)'/g)].map((m) => m[1])
      const joined = parts.join('')
      return /^https?:\/\/mp\.weixin\.qq\.com\//.test(joined) ? joined : ''
    } catch {
      return ''
    }
  }

  /**
   * 建浏览器会话。
   *
   * 这一步很反直觉但必须做：外部浏览器用的是独立配置目录，
   * 里面若没有搜狗会话，打开中转地址只会拿到一个「微信公众平台」的空壳，
   * 正文一个字都没有。先让它访问一次搜狗搜索页，cookie 就落进这个目录了。
   */
  async primeBrowser(account: string): Promise<void> {
    if (this.primed) return
    const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(account)}`
    await renderHtml(url, 30000)
    this.primed = true
  }
}

/** 从文章页源码里取规范身份。取不到就别硬编，返回 null 让上层按指纹去重 */
export function extractIdentity(html: string): { url: string; key: string } | null {
  const pick = (name: string): string => {
    const m = html.match(new RegExp(`var\\s+${name}\\s*=\\s*["']([^"']+)["']`))
    return m ? m[1] : ''
  }
  const biz = pick('biz') || (html.match(/__biz=([A-Za-z0-9=%]+)/) ?? [])[1] || ''
  const mid = pick('mid') || (html.match(/[?&]mid=(\d+)/) ?? [])[1] || ''
  const idx = pick('idx') || (html.match(/[?&]idx=(\d+)/) ?? [])[1] || '1'
  if (!biz || !mid) return null
  const url = `https://mp.weixin.qq.com/s?__biz=${biz}&mid=${mid}&idx=${idx}`
  const key = articleUrlKey(url)
  return key ? { url, key } : null
}

export interface SogouArticle extends FetchOutcome {
  /** 规范地址；取不到时为空，上层改存指纹 */
  url: string
  urlKey: string
  /** 搜狗结果里的标题，页面标题为空时兜底 */
  fallbackTitle: string
  account: string
}

/**
 * 打开中转地址，取回一篇文章。
 *
 * 走 renderHtml（外部浏览器）而不是 Electron 窗口，原因有两个：
 * 一是这一步可能在后台跑很久，不该占着应用窗口；
 * 二是搜狗会话的 cookie 就存在外部浏览器那个配置目录里，换后端还得重新建。
 */
export async function fetchViaSogou(midUrl: string, item: SogouItem): Promise<SogouArticle> {
  const base: SogouArticle = {
    status: 'unreachable',
    title: '',
    author: '',
    publishedAt: null,
    body: '',
    error: '',
    url: '',
    urlKey: '',
    fallbackTitle: item.title,
    account: item.account
  }

  if (!midUrl) return { ...base, error: '搜狗跳转链解不开（多半是会话过期）' }

  const html = await renderHtml(midUrl, 35000)
  if (!html) return { ...base, error: '页面没渲染出来' }

  const identity = extractIdentity(html)
  const page = parseArticleHtml(html)
  const judged = judgePage(page, parsePublishTime)

  return {
    ...judged,
    // 页面标题偶尔是空的（纯图推送、模板差异），退回搜索结果里的标题
    title: judged.title.trim() || item.title,
    // 页面上的号名比搜索结果更可信；取不到再用搜索结果的
    author: judged.author.trim() || item.account,
    // 搜狗给的时间是精确的，页面上的时间常缺秒，优先用搜狗的
    publishedAt: judged.publishedAt ?? item.publishedAt,
    url: identity?.url ?? '',
    urlKey: identity?.key ?? '',
    fallbackTitle: item.title,
    account: item.account
  }
}

/** 库里是否已有这篇。先按规范键查，再按「同号同名同天」兜底 */
export function alreadyHave(db: DatabaseSync, article: SogouArticle): boolean {
  if (article.urlKey) {
    const row = db.prepare('SELECT 1 AS ok FROM bench_article WHERE url_key = ? LIMIT 1').get(article.urlKey)
    if (row) return true
  }
  const title = article.title.trim()
  if (!title) return false
  const day = (article.publishedAt ?? '').slice(0, 10)
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM bench_article
        WHERE title = ? AND (? = '' OR substr(published_at, 1, 10) = ?)
        LIMIT 1`
    )
    .get(title, day, day)
  return !!row
}
