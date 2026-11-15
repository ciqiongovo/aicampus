/**
 * 内置 QCE 运行集的生命周期管理：启动（拉起 QQ 注入）、退出登录、状态探测。
 *
 * 与 qce.ts 的分工：
 * - qce.ts 只负责「QCE 已经跑起来」之后的 HTTP 协议（群、会话、消息）；
 * - 本模块负责「让 QCE 跑起来」：定位 resources/qce、找 QQNT、启动注入器、结束进程。
 *
 * 不 import electron：路径和命令都由调用方注入，方便在 node 测试里直接跑。
 */

import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QCE_DEFAULT_URL, QceClient, readQceToken } from './qce'

/** 启动后等待 QCE 令牌/端口的超时（毫秒） */
export const QCE_START_TIMEOUT_MS = 90_000

import type { ImQcePhase, ImQceRuntimeStatus } from '../../../shared/im'

/** 复用 shared 里的类型定义，避免主进程与渲染层各写一份 */
export type QceRuntimePhase = ImQcePhase
export type QceRuntimeStatus = ImQceRuntimeStatus

export interface QceRuntimeDeps {
  appPath: string
  resourcesPath: string
  isPackaged: boolean
  userDataPath: string
  baseUrl?: string
  platform?: NodeJS.Platform
  spawnFn?: typeof spawn
  execFn?: (command: string, args: string[]) => string
  now?: () => number
  tokenReader?: () => string | null
  healthProbe?: (baseUrl: string) => Promise<{ online: boolean; mode: string; reachable?: boolean }>
  sleep?: (ms: number) => Promise<void>
}

interface SpawnedChild {
  pid?: number
  once(event: 'exit', listener: (code: number | null) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

const isWindows = (platform: NodeJS.Platform): boolean => platform === 'win32'

/** 常见 QQNT 安装位置（与内置 launcher 的探测顺序保持一致） */
export function commonQqPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA ?? ''
  const candidates = [
    join(programFiles, 'Tencent', 'QQNT', 'QQ.exe'),
    join(programFilesX86, 'Tencent', 'QQNT', 'QQ.exe'),
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'D:\\Program Files\\Tencent\\QQNT\\QQ.exe'
  ]
  if (localAppData) candidates.splice(2, 0, join(localAppData, 'Programs', 'Tencent', 'QQNT', 'QQ.exe'))
  return candidates
}

/** 旧版 QQ（9.x）的路径特征：NapCat 只能注入 QQNT */
export function isLegacyQqPath(qqPath: string): boolean {
  return /\\bin\\qq\.exe$/i.test(qqPath)
}

/** 运行集是否可用：launcher-user.bat 与 qce-server.exe 同时存在 */
export function resolveQceDir(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  exists: (path: string) => boolean
}): string | null {
  const candidates = options.isPackaged
    ? [join(options.resourcesPath, 'resources', 'qce')]
    : [join(options.appPath, 'resources', 'qce'), join(options.resourcesPath, 'resources', 'qce')]
  for (const dir of candidates) {
    if (options.exists(join(dir, 'launcher-user.bat')) && options.exists(join(dir, 'qce-server.exe'))) {
      return dir
    }
  }
  return null
}

/** QQ 路径优先级：保存值 → 环境变量 → 常见路径；旧版 QQ 返回 E_QQ_TOO_OLD */
export function resolveQqExecutable(options: {
  saved: string | null
  envPath: string | null
  commonPaths: string[]
  exists: (path: string) => boolean
}): { qqPath: string | null; code: 'E_QQ_TOO_OLD' | null } {
  const candidates = [options.saved, options.envPath, ...options.commonPaths]
  for (const candidate of candidates) {
    if (!candidate || candidate.trim() === '') continue
    if (!options.exists(candidate)) continue
    if (isLegacyQqPath(candidate)) return { qqPath: null, code: 'E_QQ_TOO_OLD' }
    return { qqPath: candidate, code: null }
  }
  return { qqPath: null, code: null }
}

/** 状态机：把探测到的事实折算成一个可展示的阶段 */
export function derivePhase(input: {
  platform: NodeJS.Platform
  runtimeReady: boolean
  qqPath: string | null
  online: boolean
  reachable: boolean
  tokenFound: boolean
  launchedAt: number | null
  now: number
  failedCode: string | null
}): QceRuntimePhase {
  if (!isWindows(input.platform)) return 'unsupported'
  if (input.online) return 'online'
  if (input.failedCode) return 'error'
  const elapsed = input.launchedAt === null ? null : input.now - input.launchedAt
  if (elapsed !== null && elapsed >= QCE_START_TIMEOUT_MS) return 'error'
  // QCE 已经起来了但 QQ 还没登录：等扫码（令牌是 QCE 启动后才生成的）
  if (input.reachable) return 'waiting_login'
  if (!input.runtimeReady) return 'missing_runtime'
  if (elapsed !== null) return 'starting'
  // 令牌文件可能是上一次运行留下的，QCE 没跑就不算「等待扫码」
  if (!input.qqPath) return 'qq_not_found'
  return 'stopped'
}

/** 日志尾部若干行，并把可能出现的令牌脱敏 */
export function tailLogLines(text: string, limit = 20): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-limit)
    .map((line) => line.replace(/(access[_-]?token["'\s:=]+)[A-Za-z0-9._-]+/gi, '$1***'))
}

const PHASE_DETAIL: Record<QceRuntimePhase, string> = {
  unsupported: '仅支持 Windows：QCE 依赖 Windows 注入器',
  missing_runtime: '安装包缺少 QCE 运行集，请重新安装知枢',
  qq_not_found: '未检测到 QQNT，请先安装 QQ 9.9.x 或手动选择 QQ.exe',
  stopped: 'QCE 未启动',
  starting: '正在启动 QQ 与 QCE，请留意 QQ 登录窗',
  waiting_login: 'QCE 已就绪，请在 QQ 登录窗扫码',
  online: 'QQ 已登录，可以同步',
  error: '启动或登录失败'
}

const CODE_DETAIL: Record<string, string> = {
  E_RUNTIME_MISSING: '安装包缺少 QCE 运行集',
  E_QQ_NOT_FOUND: '未检测到 QQNT，请先安装 QQ 9.9.x',
  E_QQ_TOO_OLD: '检测到旧版 QQ，NapCat 需要 QQNT 9.9.x 以上',
  E_LAUNCH_FAILED: '启动器异常退出，详见日志',
  E_TOKEN_TIMEOUT: '90 秒内未生成 QCE 令牌，可能被安全软件拦截',
  E_PORT_IN_USE: '端口 40653 被其他进程占用'
}

export class QceRuntime {
  private readonly deps: Required<Pick<QceRuntimeDeps, 'appPath' | 'resourcesPath' | 'isPackaged' | 'userDataPath'>> &
    QceRuntimeDeps
  private launchedAt: number | null = null
  private launchedPid: number | null = null
  private failedCode: string | null = null
  private lastDetail: string | null = null
  private logPath: string | null = null
  private logStream: ReturnType<typeof createWriteStream> | null = null

  constructor(deps: QceRuntimeDeps) {
    this.deps = deps
  }

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform
  }

  private get baseUrl(): string {
    return (this.deps.baseUrl ?? QCE_DEFAULT_URL).replace(/\/+$/, '')
  }

  private get now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private exec(command: string, args: string[]): string {
    const run =
      this.deps.execFn ??
      ((cmd: string, cmdArgs: string[]): string =>
        execFileSync(cmd, cmdArgs, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore']
        }))
    try {
      return run(command, args)
    } catch {
      return ''
    }
  }

  qceDir(): string | null {
    return resolveQceDir({
      isPackaged: this.deps.isPackaged,
      resourcesPath: this.deps.resourcesPath,
      appPath: this.deps.appPath,
      exists: existsSync
    })
  }

  /** 读取保存的 QQ 路径（内置 launcher 会写这个文件） */
  private savedQqPath(dir: string | null): string | null {
    if (!dir) return null
    const file = join(dir, 'config', 'qq_path.txt')
    try {
      if (!existsSync(file)) return null
      const value = readFileSync(file, 'utf8').trim()
      return value === '' ? null : value
    } catch {
      return null
    }
  }

  private qqPath(dir: string | null): string | null {
    const resolved = resolveQqExecutable({
      saved: this.savedQqPath(dir),
      envPath: process.env.NAPCAT_QQ_PATH ?? null,
      commonPaths: commonQqPaths(),
      exists: existsSync
    })
    return resolved.qqPath
  }

  private runtimeVersion(dir: string | null): string | null {
    if (!dir) return null
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'plugins', 'napcat-plugin-qce', 'package.json'), 'utf8')) as {
        version?: unknown
      }
      return typeof manifest.version === 'string' ? manifest.version : null
    } catch {
      return null
    }
  }

  private qqPids(): number[] {
    if (!isWindows(this.platform)) return []
    const output = this.exec('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'])
    const pids: number[] = []
    for (const line of output.split(/\r?\n/)) {
      const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''))
      const pid = Number(cells[1])
      if (cells[0]?.toLowerCase() === 'qq.exe' && Number.isInteger(pid) && pid > 0) pids.push(pid)
    }
    return pids
  }

  private portOwnerPid(): number | null {
    if (!isWindows(this.platform)) return null
    const output = this.exec('netstat', ['-ano'])
    const suffix = ':40653'
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(suffix) || !/LISTENING/i.test(line)) continue
      const columns = line.trim().split(/\s+/)
      const pid = Number(columns[columns.length - 1])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
    return null
  }

  private killTree(pid: number): void {
    this.exec('taskkill', ['/PID', String(pid), '/T', '/F'])
  }

  private async health(): Promise<{ online: boolean; mode: string; reachable: boolean }> {
    if (this.deps.healthProbe) {
      const probed = await this.deps.healthProbe(this.baseUrl)
      return { online: probed.online, mode: probed.mode, reachable: probed.reachable ?? probed.online }
    }
    try {
      const probed = await new QceClient({ baseUrl: this.baseUrl, token: '', timeoutMs: 1500 }).health()
      return { online: probed.online, mode: probed.mode, reachable: true }
    } catch {
      return { online: false, mode: 'offline', reachable: false }
    }
  }

  private writeLogLine(line: string): void {
    this.logStream?.write(line.endsWith('\n') ? line : line + '\n')
  }

  private openLogStream(): string {
    const dir = join(this.deps.userDataPath, 'logs')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `qce-runtime-${stamp}.log`)
    this.logPath = file
    this.logStream = createWriteStream(file, { flags: 'a' })
    // 日志写入失败（目录被删、磁盘满）不能把主进程带崩
    this.logStream.on('error', () => {
      this.logStream = null
    })
    return file
  }

  logTail(limit = 20): string[] {
    if (!this.logPath || !existsSync(this.logPath)) return []
    try {
      return tailLogLines(readFileSync(this.logPath, 'utf8'), limit)
    } catch {
      return []
    }
  }

  async status(): Promise<QceRuntimeStatus> {
    const dir = this.qceDir()
    const qqPath = this.qqPath(dir)
    const tokenFound = (this.deps.tokenReader ?? (() => readQceToken()))() !== null
    const health = await this.health()
    const qqRunning = this.qqPids().length > 0
    const phase = derivePhase({
      platform: this.platform,
      runtimeReady: dir !== null,
      qqPath,
      online: health.online,
      reachable: health.reachable,
      tokenFound,
      launchedAt: this.launchedAt,
      now: this.now,
      failedCode: this.failedCode
    })
    const timeoutCode = phase === 'error' && !this.failedCode ? 'E_TOKEN_TIMEOUT' : null
    const code = phase === 'error' ? (this.failedCode ?? timeoutCode) : null
    const detail =
      phase === 'error'
        ? (this.lastDetail ?? (code ? CODE_DETAIL[code] : null) ?? PHASE_DETAIL.error)
        : PHASE_DETAIL[phase]
    return {
      phase,
      detail,
      code,
      baseUrl: this.baseUrl,
      qceDir: dir,
      qqPath,
      runtimeVersion: this.runtimeVersion(dir),
      qqRunning,
      tokenFound,
      online: health.online,
      mode: health.online ? health.mode : null,
      launchedAt: this.launchedAt ? new Date(this.launchedAt).toISOString() : null,
      logPath: this.logPath
    }
  }

  /** 启动内置运行集：结束未注入的 QQ → 启动器注入 → 等 QQ 登录窗出现 */
  async launch(): Promise<QceRuntimeStatus> {
    const dir = this.qceDir()
    if (!isWindows(this.platform)) return this.fail('E_RUNTIME_MISSING', '仅支持 Windows')
    if (!dir) return this.fail('E_RUNTIME_MISSING', '安装包缺少 QCE 运行集')

    const current = await this.status()
    if (current.online) return current

    const qqPath = this.qqPath(dir)
    if (!qqPath) {
      const legacy = resolveQqExecutable({
        saved: this.savedQqPath(dir),
        envPath: process.env.NAPCAT_QQ_PATH ?? null,
        commonPaths: commonQqPaths(),
        exists: existsSync
      })
      return this.fail(legacy.code ?? 'E_QQ_NOT_FOUND', legacy.code ? CODE_DETAIL.E_QQ_TOO_OLD : undefined)
    }

    const owner = this.portOwnerPid()
    if (owner) {
      this.killTree(owner)
      await this.sleep(600)
    }

    // NapCat 只能注入「由启动器拉起的 QQ」；已登录的 QQ 需要先退出
    const running = this.qqPids()
    for (const pid of running) this.killTree(pid)
    if (running.length > 0) await this.sleep(1200)

    this.failedCode = null
    this.lastDetail = null
    try {
      const log = this.openLogStream()
      this.writeLogLine(`[info] launch qq=${qqPath}`)
      this.writeLogLine(`[info] runtime=${dir}`)
      const spawnFn = this.deps.spawnFn ?? spawn
      const child = spawnFn('cmd.exe', ['/c', 'launcher-user.bat', qqPath], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          QCE_LOG_DIR: join(this.deps.userDataPath, 'logs'),
          QCE_LOG_FILE: log
        }
      }) as unknown as SpawnedChild
      if (child.pid) this.launchedPid = child.pid
      const stream = (child as unknown as { stdout?: NodeJS.ReadableStream }).stdout
      stream?.on?.('data', (chunk: Buffer) => this.writeLogLine(`[stdout] ${String(chunk).trimEnd()}`))
      const errorStream = (child as unknown as { stderr?: NodeJS.ReadableStream }).stderr
      errorStream?.on?.('data', (chunk: Buffer) => this.writeLogLine(`[stderr] ${String(chunk).trimEnd()}`))
      child.once('exit', (code) => {
        this.writeLogLine(`[info] launcher exit code=${code ?? 'null'}`)
        if (code !== 0 && code !== null && this.launchedAt !== null) {
          this.failedCode = 'E_LAUNCH_FAILED'
          this.lastDetail = `启动器退出码 ${code}，详见日志`
        }
      })
      this.launchedAt = this.now
      await this.sleep(800)
    } catch (error) {
      return this.fail('E_LAUNCH_FAILED', error instanceof Error ? error.message : String(error))
    }
    return this.status()
  }

  /** 退出登录：结束由我们启动的进程树，以及已注入的 QQ */
  async logout(): Promise<QceRuntimeStatus> {
    if (this.launchedPid) {
      this.killTree(this.launchedPid)
      this.launchedPid = null
    }
    for (const pid of this.qqPids()) this.killTree(pid)
    const owner = this.portOwnerPid()
    if (owner) this.killTree(owner)
    await this.sleep(900)
    this.launchedAt = null
    this.failedCode = null
    this.lastDetail = null
    this.writeLogLine('[info] logout')
    this.dispose()
    return this.status()
  }

  /** 结束日志流（退出登录或应用退出时调用） */
  dispose(): void {
    this.logStream?.end()
    this.logStream = null
  }

  /** 手动选择 QQ.exe 后写入 config/qq_path.txt，供内置 launcher 复用 */
  setQqPath(qqPath: string): void {
    const dir = this.qceDir()
    if (!dir) return
    const target = join(dir, 'config')
    try {
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'qq_path.txt'), qqPath, 'utf8')
    } catch {
      /* 忽略：下次启动仍会走自动探测 */
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async fail(code: string, detail?: string): Promise<QceRuntimeStatus> {
    this.failedCode = code
    this.lastDetail = detail ?? CODE_DETAIL[code] ?? PHASE_DETAIL.error
    const dir = this.qceDir()
    return {
      phase: 'error',
      detail: this.lastDetail,
      code,
      baseUrl: this.baseUrl,
      qceDir: dir,
      qqPath: this.qqPath(dir),
      runtimeVersion: this.runtimeVersion(dir),
      qqRunning: this.qqPids().length > 0,
      tokenFound: (this.deps.tokenReader ?? (() => readQceToken()))() !== null,
      online: false,
      mode: null,
      launchedAt: this.launchedAt ? new Date(this.launchedAt).toISOString() : null,
      logPath: this.logPath
    }
  }
}
