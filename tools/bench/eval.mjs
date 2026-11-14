/**
 * 在运行中的应用里执行一段 JS，并打印结果。
 *
 * 用来做界面验证：点按钮、读状态、量尺寸，都比截图后靠眼睛猜准。
 * 用法：node tools/bench/eval.mjs "location.hash"
 */

const expr = process.argv[2]
if (!expr) {
  console.error('用法：node tools/bench/eval.mjs "<js 表达式>"')
  process.exit(1)
}

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('没有页面目标')
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

const result = await send('Runtime.evaluate', {
  expression: `(async () => { ${expr.includes('return') ? expr : `return (${expr})`} })()`,
  awaitPromise: true,
  returnByValue: true
})

if (result.exceptionDetails) {
  console.error('执行异常：', JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
  process.exitCode = 1
} else {
  const v = result.result.value
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1))
}
ws.close()
