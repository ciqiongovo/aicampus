/**
 * 通过 Chrome DevTools 协议截取应用窗口。
 *
 * 为什么不用系统截屏：应用窗口可能被最小化，或者跨会话拿不到前台，
 * GrabScreen 截出来是黑的或者干脆是别的窗口。走 CDP 是直接向渲染进程要一帧，
 * 窗口在不在前台都不影响结果，也不会把用户的桌面内容带进截图。
 *
 * 用法：node tools/bench/shot.mjs <输出路径> [宽] [高]
 */

const OUT = process.argv[2] ?? 'output/bench/ui.png'
const WIDTH = Number(process.argv[3] ?? 1440)
const HEIGHT = Number(process.argv[4] ?? 900)

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('没有找到页面目标：', JSON.stringify(list.map((t) => t.type)))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

// 先固定视口尺寸，让界面按目标宽度排版，而不是按窗口当前大小
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false
})
// 等一帧，确保重排完成
await new Promise((r) => setTimeout(r, 800))

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const { writeFileSync } = await import('node:fs')
writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log(`已保存 ${OUT} (${WIDTH}x${HEIGHT})`)
ws.close()
