/**
 * 「这条到底算不算一场活动」的回归测试。
 *
 * 用例全部取自库里真实存在的标题——不是编出来的例子。样本是 50 条已入库的活动，
 * 逐条看过之后，其中 20 条根本不是活动：人物报道、候选人公示、月度汇总、换届大会。
 * 这些标题和真活动放在一起几乎看不出区别（正文里都写着「晚会」「竞赛」「毕业季」），
 * 所以必须钉死：以后改词表时，误伤真活动要立刻红。
 */
const assert = require('node:assert')
const { offTopicReason } = require('../.test-out/main/services/benchmark/rule-extract.js')

let pass = 0
const fails = []

function run(name, fn) {
  try {
    fn()
    pass++
  } catch (error) {
    fails.push({ name, message: error.message })
  }
}

/** 应当被判为「不是活动」 */
function reject(title, reason) {
  run(`剔除：${title.slice(0, 26)}`, () => {
    const got = offTopicReason(title)
    assert.ok(got, `应剔除，实际放行：${title}`)
    if (reason) assert.strictEqual(got, reason, `原因应为「${reason}」，实际「${got}」`)
  })
}

/** 应当保留为活动 */
function keep(title) {
  run(`保留：${title.slice(0, 26)}`, () => {
    assert.strictEqual(offTopicReason(title), null, `应保留为活动，实际被剔除：${title}`)
  })
}

// ---------- 人物报道 ----------
reject('毕业说 | 檀忻怡：向内深耕，向外生长', '人物报道')
reject('毕业•记忆|胡雯漫：幸于选择，与更好的自己相遇', '人物报道')
reject('毕业生故事｜王宇瀚：在上科大的四年是一段“自我发现”的旅程', '人物报道')
reject('毕业季 | 优秀毕业生胡豆豆：不忘初心，挑战自我，做一个传播正能量的人', '人物报道')
reject('【青春礼赞】时令然：“职”点迷津！在众星闪耀的夜空找到属于自己的那颗流星', '人物报道')

// ---------- 名单公示 ----------
reject('重磅！上科大第五届双创大会科普专场获奖名单揭晓！', '名单公示')
reject('喜报！我校河口海岸科学研究院研究生会参加2026年上海高校学生会组织“我为同学做实事”交流展示活动获评精品项目！', '名单公示')
reject('聚焦学代会｜上海科技大学第六届学生会主席团正式候选人风采展示', '名单公示')
reject('程青风采｜展榜样风采，追卓越之光——2024年上海工程技术大学优秀学生标兵风采展示', '名单公示')
reject('上海科技大学第五届学生会第一任部长团候选人选拔公告', '名单公示')

// ---------- 会议通报 ----------
reject('2023-2024年度上海科技大学学生会第一次全体大会顺利召开', '会议通报')
reject('2025年度上海中医药大学学生会组织 述职评议会顺利召开', '会议通报')

// ---------- 合集汇总 ----------
reject('上科大一周活动预告', '合集汇总')
reject('迎新特辑 | 上科大公众号总集篇', '合集汇总')

// ---------- 招生与建制 ----------
reject('探索智驾前沿，共育创新人才 ——上科大创艺师生赴上汽设计中心参访交流', '招生与建制')
reject('如何快速了解上海科技大学物质学院？带你一键“走进物院”！', '说明文')

// ---------- 必须保住真活动 ----------
// 这几个的存在意义：词表很容易一路收紧，收到把「校迎新晚会」也当成综述
keep('这场迎新晚会，燃爆了！')
keep('“涌现新生”！欢迎来到迎新晚会！')
keep('解锁“我的复旦”！2025迎新晚会→')
keep('2025级复旦大学迎新晚会新生节目招募来啦！')
keep('「枫云决」丨羽里生花')
keep('新生杯篮球赛 | 龙争虎斗，你“新”你上！')
keep('青春闪光 “泮”你登场！上海大学2025年迎新晚会回顾')
keep('逐梦上大，青春启航！上海大学2025级新生开学典礼举行！')

// 「人物词 + 活动词」同时出现时，是活动而不是人物报道。
// 这类标题最容易被一刀切误杀，所以单列一组。
keep('优秀毕业生分享会：从保研到就业的三条路')
keep('榜样的力量 | 标兵事迹分享会')
keep('招生宣传志愿者招募 | 回母校讲讲你的大学')
keep('参访交流分享会：走进上汽设计中心')

run('空标题不炸', () => {
  assert.strictEqual(offTopicReason(''), null)
  assert.strictEqual(offTopicReason(null), null)
})

// ---------- 时间解析 ----------
// 原文里「3 月 8 日 24:00」这种写法很常见（当天结束前），它不是合法时刻，
// 直接入库会让排序和「提前几天」的计算一起出错。

const { extractByRules } = require('../.test-out/main/services/benchmark/rule-extract.js')

run('「24:00」折成 23:59，不写进非法时刻', () => {
  const r = extractByRules({
    title: '迎新晚会报名',
    body: '活动时间：3月8日 24:00 前提交',
    publishedAt: '2026-03-01 10:00'
  })
  assert.ok(r.startAt, '应该抽到开始时间')
  assert.ok(r.startAt.endsWith('23:59:00'), r.startAt)
})

run('正常时刻照原样保留', () => {
  const r = extractByRules({
    title: '迎新晚会',
    body: '活动时间：9月27日 18:30',
    publishedAt: '2026-09-01 10:00'
  })
  assert.ok(r.startAt && r.startAt.endsWith('18:30:00'), r.startAt)
})

// ---------- 结果 ----------
if (fails.length) {
  console.error(`\n未通过 ${fails.length} 项：`)
  for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.message}`)
  process.exit(1)
}
console.log(`活动判定 ${pass} 项全部通过`)
