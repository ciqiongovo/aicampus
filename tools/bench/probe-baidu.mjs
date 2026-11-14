/**
 * 探针：看百度 site:mp.weixin.qq.com 对不同查询能返回多少条微信原文。
 *
 * 为什么要单写一个探针：搜索源的可用性是会变的（搜狗上了验证码、Bing 不索引微信），
 * 采集策略得基于「今天实测能拿到多少」来定，不能凭印象。
 * 用法：node tools/bench/probe-baidu.mjs "查询1" "查询2" ...
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const queries = process.argv.slice(2)

async function serp(query, pn = 0) {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&pn=${pn}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    }
  })
  const html = await res.text()
  const out = []
  const re = /<div[^>]*class="[^"]*result[^"]*c-container[^"]*"[\s\S]*?mu="([^"]+)"/g
  let m
  while ((m = re.exec(html))) {
    const mu = m[1].replace(/&amp;/g, '&')
    if (!mu.includes('mp.weixin.qq.com')) continue
    // 标题在容器里的 h3 > a
    const tail = html.slice(m.index, m.index + 3000)
    const t = /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(tail)
    out.push({ title: t ? t[1].replace(/<[^>]+>/g, '').trim() : '', url: mu })
  }
  return { total: html.length, items: out }
}

for (const q of queries) {
  const r = await serp(q)
  console.log(`\n【${q}】html=${r.total} 命中=${r.items.length}`)
  for (const it of r.items.slice(0, 6)) console.log('  -', it.title.slice(0, 40), '|', it.url.slice(0, 60))
  await new Promise((res) => setTimeout(res, 2000))
}
