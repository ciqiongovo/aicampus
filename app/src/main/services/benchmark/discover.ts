/**
 * 按学校去找公众号文章。
 *
 * 只有一条路：搜索引擎。微信没有开放的「按公众号列文章」接口，
 * 文章页要拿到 uin/key 才能翻历史列表，而这两个值每次会话都变。
 * 搜狗微信已经改成验证码拦截，必应和 360 不收录公众号正文。
 * 实测下来只有移动版百度还在正常返回，并且带完整 __biz/mid/idx/chksm。
 *
 * 这套东西的边界必须写在界面上：
 * - 一个出口 IP 大约能连查 4–5 次，之后要凉一会儿；
 * - 搜到的是「这个号被搜索引擎收录过的文章」，不是「它的全部文章」；
 * - 账号名是猜的，猜错就一条也搜不到，这不是故障。
 *
 * 所以这里的策略是：慢、少、可中断。宁可一次只查五六个账号，
 * 也不要为了「一次采完」把配额烧光、最后连一次都查不成。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { BenchDiscoverResult } from '../../../shared/benchmark'
import { articleUrlKey } from '../../../shared/benchmark'
import {
  candidateAccounts,
  categoryOfOrg,
  findSchool,
  mergeAccounts
} from '../../../shared/schools'
import {
  enqueueArticle,
  knownAccountsOf,
  listProspects,
  markProspect,
  upsertProspects
} from '../../db/dao/benchmarkDao'

/** 移动版 UA。用桌面 UA 访问 m.baidu.com 会被重定向到 www，那条路三次必验证码 */
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** 一个窗口能连查的次数很少，默认只查最可能的这几个 */
export const DEFAULT_ACCOUNT_LIMIT = 5

/** 账号之间的停顿。太快会立刻触发限流，慢一点反而整体更快 */
const GAP_MIN_MS = 3500
const GAP_MAX_MS = 6500

/** 连续撞几次验证码就不再试了。这跟「搜不到」是两回事，必须分开处理 */
const BLOCK_BREAKER = 2

const BLOCK_MARK = /请输入验证码|wappass\.baidu\.com\/static\/captcha|网络不给力/

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface DiscoverProgress {
  /** 第几个账号，从 1 开始 */
  current: number
  total: number
  account: string
  /** 一句话状态，直接显示给用户 */
  note: string
}

/** 搜索引擎返回的链接里常夹着 &quot;}} 这类残渣，取到第一个引号或尖括号为止 */
function cleanUrl(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&quot;[\s\S]*$/, '')
    .replace(/["'<>\s\\].*$/, '')
}

async function searchAccount(
  account: string
): Promise<{ links: string[]; blocked: boolean; error: string }> {
  // 账号名必须加引号做短语匹配。
  // 不加引号时「上海科技大学学生会」会被拆成三个词去配，
  // 返回的全是别校的「学生会」稿子——实测 25 篇里只有 4 篇是上科大的。
  // 加了引号，返回的就都是这个号自己的文章，条数少但一条是一条。
  const word = `site:mp.weixin.qq.com "${account}"`
  const url = `https://m.baidu.com/s?word=${encodeURIComponent(word)}`
  let html = ''
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    })
    if (!res.ok) return { links: [], blocked: false, error: `搜索返回 ${res.status}` }
    html = await res.text()
  } catch (error) {
    return { links: [], blocked: false, error: (error as Error).message.slice(0, 80) }
  }

  const raw = [...html.matchAll(/https?:\/\/mp\.weixin\.qq\.com\/s\?[^"' <>\\]*/g)].map((m) =>
    cleanUrl(m[0])
  )
  const links = [...new Set(raw)].filter((u) => !!articleUrlKey(u))
  // 一条链接都没有，且页面上出现验证码特征，才算被拦。
  // 只看 wappass 会误判：结果页脚本里本来就带着这个域名的字符串。
  const blocked = links.length === 0 && BLOCK_MARK.test(html)
  return { links, blocked, error: '' }
}

/**
 * 按学校去找文章并入库。
 *
 * accounts 传空时用命名套路生成前若干个；传了就用传的（用户可能知道花名）。
 * 每查一个账号就往库里落一批，中途被拦也不会把已经拿到的丢掉。
 */
export async function discoverSchool(
  db: DatabaseSync,
  input: {
    school: string
    accounts?: string[]
    limit?: number
    onProgress?: (p: DiscoverProgress) => void
  }
): Promise<BenchDiscoverResult> {
  const school = input.school.trim()
  if (!school) throw new Error('没指定学校')

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_ACCOUNT_LIMIT, 1), 12)
  // 查证过的号排在前面：配额只够搜四五次，先搜确定存在的，
  // 剩下的名额再留给按套路猜的
  const known = knownAccountsOf(db, school)
  const accounts = (input.accounts?.length
    ? input.accounts.map((a) => a.trim()).filter(Boolean)
    : mergeAccounts(known, candidateAccounts(findSchool(school)))
  ).slice(0, limit)

  // 记下这一轮打算找谁，界面上才有「找过没有、找到没有」的账
  upsertProspects(
    db,
    school,
    accounts.map((name) => ({ name, category: categoryOfOrg(name) }))
  )

  let requests = 0
  let accepted = 0
  let duplicated = 0
  let accountsHit = 0
  let blockedStreak = 0
  let blocked = false

  for (const [index, account] of accounts.entries()) {
    input.onProgress?.({
      current: index + 1,
      total: accounts.length,
      account,
      note: '正在搜索'
    })

    const result = await searchAccount(account)
    requests += 1

    if (result.blocked) {
      blockedStreak += 1
      markProspect(db, school, account, { status: 'blocked', hitCount: 0, note: '撞上搜索验证码' })
      if (blockedStreak >= BLOCK_BREAKER) {
        blocked = true
        break
      }
      // 被拦了还接着搜只会把冷却时间拖得更长，先歇一口
      await sleep(20000 + Math.random() * 10000)
      continue
    }
    blockedStreak = 0

    if (result.error) {
      markProspect(db, school, account, { status: 'empty', hitCount: 0, note: result.error })
    } else if (result.links.length === 0) {
      markProspect(db, school, account, {
        status: 'empty',
        hitCount: 0,
        note: '没搜到文章，可能这个号不叫这个名字'
      })
    } else {
      accountsHit += 1
      let fresh = 0
      for (const url of result.links) {
        const key = articleUrlKey(url)
        if (!key) continue
        const added = enqueueArticle(db, { urlKey: key, url, sourceId: null, hintSchool: school })
        if (added) {
          accepted += 1
          fresh += 1
        } else {
          duplicated += 1
        }
      }
      markProspect(db, school, account, {
        status: 'found',
        hitCount: result.links.length,
        note: fresh ? `新入队 ${fresh} 篇` : '都已在本库中'
      })
    }

    input.onProgress?.({
      current: index + 1,
      total: accounts.length,
      account,
      note: result.links.length ? `拿到 ${result.links.length} 条链接` : '这个号没搜到'
    })

    if (index < accounts.length - 1) await sleep(GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS))
  }

  const message = blocked
    ? '搜索接口要求验证码，先停一停。过 20–30 分钟再点一次，不要连着试。'
    : accountsHit === 0
      ? '这几个账号名都没搜到文章。可以手动改账号名再试，或者直接粘链接导入。'
      : `搜了 ${accountsHit} 个账号，新入队 ${accepted} 篇。`

  return { requests, accepted, duplicated, accountsHit, blocked, message }
}

/** 这一轮找过的账号清单，带各自的成败，用户据此决定下次改哪个名字 */
export function prospectsOf(db: DatabaseSync, school?: string): ReturnType<typeof listProspects> {
  return listProspects(db, school)
}
