#!/usr/bin/env node
/**
 * 准备内置 QCE 运行集：从 NapCat-QCE 发行包裁剪出 Windows x64 必需文件，
 * 复制到 resources/qce/，供 InfoAgent 通过「登录 QQ」直接启动。
 *
 * 用法：
 *   node scripts/prepare-qce.cjs                 # 默认从 DSHprogramfiles 的发行包复制
 *   QCE_SOURCE=<目录> node scripts/prepare-qce.cjs
 *   node scripts/prepare-qce.cjs --force         # 先清空 resources/qce 再复制
 *
 * 设计说明：
 * - 只保留 win32-x64 原生模块，darwin/linux/arm64 产物（约 70MB）全部忽略。
 * - 运行集体积约 52MB，不进 Git，由本脚本生成，保证可重复构建。
 * - 许可证为 GPL-3.0：只做独立进程分发，不修改、不合并其源码。
 */
const { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const DEFAULT_SOURCE = resolve(
  ROOT,
  '..',
  'DSHprogramfiles',
  '聊天记录',
  '2026-10-18-QCE',
  'app',
  'NapCat-QCE-Windows-x64'
)
const SOURCE = process.env.QCE_SOURCE ? resolve(process.env.QCE_SOURCE) : DEFAULT_SOURCE
const DEST = join(ROOT, 'resources', 'qce')
const FORCE = process.argv.includes('--force')

const FILES = [
  'launcher-user.bat',
  'find-qq.ps1',
  'loadNapCat.js',
  'qqnt.json',
  'napcat.mjs',
  'conout-wiJ7YKRd.js',
  'qce-server.exe'
]

const DIRS = ['node_modules', 'plugins', 'static', 'worker']

/** 只保留 Windows x64 的原生模块（其余平台产物约 70MB，全部丢弃） */
const NATIVE = [
  'native/dpapi/win32-x64/@primno+dpapi.node',
  'native/ffmpeg/ffmpegAddon.win32.x64.node',
  'native/napi2native/ffmpeg.dll',
  'native/napi2native/napi2native.win32.x64.node',
  'native/packet/MoeHoo.win32.x64.node',
  'native/pty/win32.x64/conpty.node',
  'native/pty/win32.x64/conpty_console_list.node',
  'native/pty/win32.x64/pty.node',
  'native/pty/win32.x64/winpty-agent.exe',
  'native/pty/win32.x64/winpty.dll'
]

const CONFIG = [
  'config/napcat.json',
  'config/onebot11.json',
  'config/plugins.json',
  'config/plugins/napcat-plugin-builtin/config.json'
]

function fail(message) {
  console.error('[prepare-qce] ' + message)
  process.exit(1)
}

function copyOne(relative) {
  const from = join(SOURCE, relative)
  const to = join(DEST, relative)
  if (!existsSync(from)) fail('缺少文件：' + relative)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

function directorySize(path) {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    total += entry.isDirectory() ? directorySize(child) : statSync(child).size
  }
  return total
}

if (!existsSync(join(SOURCE, 'qce-server.exe'))) fail('找不到 QCE 发行包：' + SOURCE)
if (FORCE && existsSync(DEST)) rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })

for (const file of FILES) copyOne(file)
for (const directory of DIRS) {
  cpSync(join(SOURCE, directory), join(DEST, directory), { recursive: true })
}
for (const file of [...NATIVE, ...CONFIG]) copyOne(file)

const license = join(SOURCE, '..', '..', '..', '..', '2026-10-18-QQ采集', '外部源码-qq-chat-exporter-master', 'LICENSE')
if (existsSync(license)) copyFileSync(license, join(DEST, 'LICENSE-QCE.txt'))

writeFileSync(
  join(DEST, 'NOTICE.md'),
  [
    '# 内置 QCE 运行集',
    '',
    '- 来源：NapCat-QCE（NapCat v4.18.28 + QQ Chat Exporter 6.3.2，构建于 2026-10-03）',
    '- 上游：https://github.com/shuakami/qq-chat-exporter',
    '- 许可证：GPL-3.0（见 LICENSE-QCE.txt），以独立进程分发，InfoAgent 只通过本地 HTTP 调用',
    '- 裁剪：仅保留 Windows x64 原生模块，其余平台产物已移除',
    '- 生成：node scripts/prepare-qce.cjs（不要手工修改本目录）',
    ''
  ].join('\n'),
  'utf8'
)

const bytes = directorySize(DEST)
console.log('[prepare-qce] 完成：' + DEST)
console.log('[prepare-qce] 体积：' + (bytes / 1024 / 1024).toFixed(1) + ' MB')
