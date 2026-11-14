/**
 * 从移动版百度收割公众号原文链接。
 *
 * 为什么要用移动版：PC 版 www.baidu.com/s 在这个网络出口连续几次就被跳到
 * wappass 图形验证码，桌面版拿不到结果；m.baidu.com 走的是另一条链路，
 * 目前仍能正常返回，且结果里带完整 __biz/mid/idx/chksm（少了 chksm 微信会返回验证页）。
 *
 * 只收割链接，不判断内容——账号名、发布时间、正文都要真正打开文章才知道，
 * 提前用搜索摘要去猜学校，猜错的代价远大于多抓一篇。
 *
 * 用法：node tools/bench/harvest.mjs [输出文件] [最大请求数]
 * 输出是增量写的，中途被限流也不会丢掉已经拿到的链接。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const OUT = process.argv[2] ?? 'output/bench/links-harvest.json'
const MAX_REQ = Number(process.argv[3] ?? 40)
/** 被要求验证码后等多久再试。实测一个出口 IP 大约能连查 4–5 次，之后要凉一会儿 */
const BLOCK_WAIT_MS = Number(process.argv[4] ?? 180000)

/** 上海主要高校：够覆盖 985/211 到市属院校，学生会对标才有说服力 */
const SCHOOLS = [
  '复旦大学', '上海交通大学', '同济大学', '华东师范大学', '华东理工大学',
  '上海大学', '东华大学', '上海外国语大学', '上海财经大学', '上海理工大学',
  '上海师范大学', '上海海事大学', '上海中医药大学', '上海对外经贸大学',
  '上海工程技术大学', '上海应用技术大学', '上海电力大学', '上海立信会计金融学院',
  '上海政法学院', '上海体育大学', '上海科技大学'
]

/** 活动类型：从晚礼式大活动到日常招募，覆盖学生会一年里的主要工作面 */
const ACTIVITIES = [
  '迎新晚会', '十大歌手', '运动会', '毕业季', '招新', '讲座',
  '志愿服务', '社团招新', '校园歌手大赛', '元旦晚会', '游园会', '辩论赛'
]

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function keyOf(url) {
  const biz = /[?&]__biz=([^&]+)/.exec(url)
  const mid = /[?&]mid=([^&]+)/.exec(url)
  const idx = /[?&]idx=([^&]+)/.exec(url)
  if (!biz || !mid) return ''
  return `${biz[1]}-${mid[1]}-${idx?.[1] ?? '1'}`
}

async function serp(word, pn = 0) {
  const url = `https://m.baidu.com/s?word=${encodeURIComponent(word)}&pn=${pn}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    }
  })
  const html = await res.text()
  const found = [...html.matchAll(/https?:\/\/mp\.weixin\.qq\.com\/s\?[^"' <>\\]*/g)]
    .map((m) => m[0].replace(/&amp;/g, '&'))
  // 判定被拦：一个链接都没有，且页面上出现验证码特征。
  // 只看 wappass 会误判——搜索结果页的脚本里本来就带着这个域名的字符串。
  const blocked = found.length === 0 && /请输入验证码|wappass\.baidu\.com\/static\/captcha|网络不给力/.test(html)
  return { status: res.status, size: html.length, found, blocked }
}

const store = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { items: [] }
const seen = new Set(store.items.map((i) => i.key))

let requests = 0
let added = 0

/** 已经查过的「学校+活动」组合：每轮配额只有四五次请求，重复查等于白烧 */
const done = new Set(store.items.map((i) => `${i.school}|${i.activity}`))

outer: for (const activity of ACTIVITIES) {
  for (const school of SCHOOLS) {
    if (requests >= MAX_REQ) break outer
    // 按活动排外层：一个配额窗口里尽量覆盖不同学校，而不是把一所学校的所有活动查完
    if (done.has(`${school}|${activity}`)) continue
    const word = `site:mp.weixin.qq.com ${school} ${activity}`
    let r
    // 被拦不是失败，是「等一会儿再来」：同一个查询最多等三轮，
    // 三轮都不过就跳过这一条，别把整轮采集卡死在一个词上。
    for (let attempt = 0; attempt < 3; attempt++) {
      requests += 1
      try {
        r = await serp(word)
      } catch (e) {
        console.log(`[${requests}] 请求失败 ${school} ${activity}: ${e.message}`)
        await sleep(15000)
        r = null
        continue
      }
      if (!r.blocked) break
      console.log(`[${requests}] 需要验证码，等 ${Math.round(BLOCK_WAIT_MS / 1000)}s 后重试（第 ${attempt + 1} 轮）`)
      if (requests >= MAX_REQ) break outer
      await sleep(BLOCK_WAIT_MS)
    }
    if (!r || r.blocked) {
      console.log(`[${requests}] 跳过 ${school}/${activity}`)
      continue
    }
    let n = 0
    for (const url of r.found) {
      const key = keyOf(url)
      if (!key || seen.has(key)) continue
      seen.add(key)
      store.items.push({ key, url, school, activity, at: new Date().toISOString() })
      n += 1
    }
    added += n
    done.add(`${school}|${activity}`)
    console.log(`[${requests}] ${school}/${activity}: 返回 ${r.found.length} 条，新增 ${n}，累计 ${store.items.length}`)
    writeFileSync(OUT, JSON.stringify(store, null, 1))
    // 间隔拉开一点：太快会触发限流，宁可慢
    await sleep(4000 + Math.random() * 3000)
  }
}

writeFileSync(OUT, JSON.stringify(store, null, 1))
console.log(`\n完成：请求 ${requests} 次，新增 ${added} 条，共 ${store.items.length} 条 → ${OUT}`)
