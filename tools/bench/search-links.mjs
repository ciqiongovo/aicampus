/**
 * 从公开网页搜索里捞 mp.weixin.qq.com 的真实文章链接。
 *
 * 为什么要这么绕：公众号没有公开的文章列表接口，历史文章的入口只有微信客户端。
 * 但文章链接本身是公开的，会被搜索引擎索引。所以冷启动阶段用搜索来补一批，
 * 让对标库在用户自己关注公众号之前就有内容可看。
 *
 * 只取链接，不取正文——正文交给统一抓取管线，保证入库的东西是同一种来路。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function curl(url) {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-sL', '--max-time', '25', '-A', UA, url], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.on('close', () => resolve(out))
    child.on('error', () => resolve(''))
  })
}

/**
 * Bing 的结果链接是跳转地址：https://www.bing.com/ck/a?...&u=a1<base64url>
 * 真正的目标藏在 u= 参数里，前面多一个 "a1" 前缀。不解码就只有 0 条——
 * 我第一次就是因为这个白跑了两轮搜索。
 */
function decodeBing(html) {
  const out = []
  const re = /[?&]u=a1([A-Za-z0-9_-]{20,})/g
  let m
  while ((m = re.exec(html))) {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
    try {
      out.push(Buffer.from(b64, 'base64').toString('utf8'))
    } catch {
      /* 坏一条不影响其它 */
    }
  }
  return out.join('\n')
}

/** 从任意 HTML 里抠出干净的微信文章链接，按 __biz+mid+idx 去重 */
export function extractLinks(html) {
  const found = []
  const haystack = html + '\n' + decodeBing(html)
  const re = /https?:\/\/mp\.weixin\.qq\.com\/s\?[^"'\s<>\\]+/g
  let m
  while ((m = re.exec(haystack))) {
    let url = m[0]
    // 搜索页常把 & 转成 &amp;，也可能带 #rd 尾巴
    url = url.replace(/&amp;/g, '&').split('#')[0]
    const biz = url.match(/[?&]__biz=([^&]+)/)
    const mid = url.match(/[?&]mid=([^&]+)/)
    const idx = url.match(/[?&]idx=([^&]+)/)
    if (!biz || !mid) continue
    found.push({ url, key: `${biz[1]}:${mid[1]}:${idx ? idx[1] : '1'}` })
  }
  return found
}

const QUERIES = process.argv.slice(2)

if (QUERIES.length) {
  const all = []
  for (const q of QUERIES) {
    const enc = encodeURIComponent(q)
    const engines = [
      `https://www.bing.com/search?q=${enc}&count=30`,
      `https://www.sogou.com/web?query=${enc}&num=30`
    ]
    for (const url of engines) {
      const html = await curl(url)
      const links = extractLinks(html)
      const host = new URL(url).hostname
      console.log(`${host}  ${q}  -> ${links.length} 条`)
      all.push(...links)
    }
  }
  const seen = new Set()
  const uniq = all.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
  console.log(`\n合计去重 ${uniq.length} 条`)
  fs.writeFileSync('output/bench/search-links.json', JSON.stringify(uniq, null, 1))
  console.log('已写 output/bench/search-links.json')
}
