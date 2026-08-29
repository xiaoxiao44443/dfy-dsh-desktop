import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import type { HarnessRuntimeCandidate } from './harness-runtime.js'
import { HarnessToolchainManager, prependToolchainToPath } from './harness-toolchain.js'
import type { HarnessDesktopBridgeLaunch } from './harness-desktop-bridge.js'
import { parsePluginInitializationFailure, PluginInitializationError } from './plugin-recovery.js'

const URL_PATTERN = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/u
const START_TIMEOUT_MS = 90_000
const STARTUP_OUTPUT_DETAIL_LIMIT = 2_000
const HARNESS_BOOTSTRAP = fileURLToPath(new URL('../harness-bootstrap.cjs', import.meta.url))

export function withHarnessStartupOutput(error: unknown, startupOutput: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  const detail = startupOutput
    .replaceAll(/\u001b\[[0-9;]*m/gu, '')
    .trim()
    .slice(-STARTUP_OUTPUT_DETAIL_LIMIT)
  if (detail.length === 0 || message.includes(detail)) return error instanceof Error ? error : new Error(message)
  return new Error(`${message}\n启动输出：\n${detail}`)
}

export interface RunningHarness {
  candidate: HarnessRuntimeCandidate
  url: string
}

export interface HarnessLaunchOptions {
  patchPath?: string
}

export interface HarnessCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function buildHarnessArguments(
  desktopBridgePatchPath: string,
  pluginRecoveryPatchPath: string,
  options: HarnessLaunchOptions = {},
): string[] {
  // DSH rc.8 stops parsing launcher options after the first web-app option.
  // Keep every launcher-owned --patch before --no-open/--port so the overlay
  // is consumed by `dsh web` instead of being forwarded to the web app.
  const args = ['web', '--patch', desktopBridgePatchPath]
  if (options.patchPath !== undefined) args.push('--patch', options.patchPath)
  args.push('--patch', pluginRecoveryPatchPath, '--no-open', '--port', '0')
  return args
}

type HarnessChild = ChildProcessByStdio<null, Readable, Readable>

export class HarnessProcess extends EventEmitter {
  private child: HarnessChild | undefined
  private stopping = false
  private activeCandidate: HarnessRuntimeCandidate | undefined
  private activeEnvironment: NodeJS.ProcessEnv | undefined
  private activePnpmEntry: string | undefined

  constructor(
    private readonly electronExecutable: string,
    private readonly workspacePath: string,
    private readonly directoryPickerUrl: string,
    private readonly toolchainManager: HarnessToolchainManager,
    private readonly desktopBridge: HarnessDesktopBridgeLaunch,
    private readonly pluginRecoveryPatchPath: string,
  ) { super() }

  async start(candidate: HarnessRuntimeCandidate, options: HarnessLaunchOptions = {}): Promise<RunningHarness> {
    await this.stop()
    const toolchain = await this.toolchainManager.prepare(candidate)
    this.stopping = false
    const environment = prependToolchainToPath(process.env, toolchain.binPath)
    const harnessArgs = buildHarnessArguments(
      this.desktopBridge.patchPath,
      this.pluginRecoveryPatchPath,
      options,
    )
    const child = spawn(this.electronExecutable, [
      '--expose-internals', HARNESS_BOOTSTRAP, candidate.entryPath, ...harnessArgs,
    ], {
      cwd: this.workspacePath,
      env: {
        ...environment,
        DSH_DESKTOP: '1',
        DSH_DESKTOP_RUNTIME_VERSION: candidate.version,
        DSH_DESKTOP_DSH_COMMAND: toolchain.dshCommand,
        DSH_DESKTOP_PNPM_COMMAND: toolchain.pnpmCommand,
        DSH_DESKTOP_DIRECTORY_PICKER_URL: this.directoryPickerUrl,
        DSH_DESKTOP_CONTROL_URL: this.desktopBridge.controlUrl,
        DSH_DESKTOP_CONTROL_TOKEN: this.desktopBridge.controlToken,
        DSH_DESKTOP_PROFILE_PATH: this.desktopBridge.profilePath,
        DSH_DESKTOP_BRIDGE_ROOT: this.desktopBridge.pluginRootPath,
        DSH_DESKTOP_BROWSER_ROOT: this.desktopBridge.browserPluginRootPath,
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
        FORCE_COLOR: '0',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let startupOutput = ''
    const captureStartupOutput = (chunk: Buffer): void => {
      startupOutput = `${startupOutput}${chunk.toString('utf8')}`.slice(-64_000)
    }
    child.stdout.on('data', captureStartupOutput)
    child.stderr.on('data', captureStartupOutput)
    child.stdout.on('data', (chunk: Buffer) => this.emit('log', 'stdout', chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => this.emit('log', 'stderr', chunk.toString('utf8')))
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      this.emit('exit', { code, signal, expected: this.stopping })
    })
    try {
      const url = await this.waitForUrl(child)
      await this.waitForHealthy(url, child)
      this.activeCandidate = candidate
      this.activeEnvironment = environment
      this.activePnpmEntry = toolchain.pnpmEntry
      return { candidate, url }
    } catch (error) {
      const failure = parsePluginInitializationFailure(startupOutput)
      if (failure !== undefined) throw new PluginInitializationError(failure)
      throw withHarnessStartupOutput(error, startupOutput)
    } finally {
      child.stdout.off('data', captureStartupOutput)
      child.stderr.off('data', captureStartupOutput)
    }
  }

  async runPlugin(profile: string, args: string[]): Promise<HarnessCommandResult> {
    const candidate = this.activeCandidate
    const environment = this.activeEnvironment
    if (candidate === undefined || environment === undefined) throw new Error('Harness 尚未启动，无法运行 Plugin 命令。')
    return await this.runHarnessCommand(candidate, ['plugin', '--profile', profile, ...args], environment)
  }

  async runPnpm(profile: string, args: string[]): Promise<HarnessCommandResult> {
    const pnpmEntry = this.activePnpmEntry
    const environment = this.activeEnvironment
    if (pnpmEntry === undefined || environment === undefined) throw new Error('Harness 尚未启动，无法运行 pnpm。')
    const configuredHome = environment.DSH_HOME?.trim()
    const harnessHome = configuredHome === undefined || configuredHome.length === 0
      ? join(this.workspacePath, '.dsh')
      : configuredHome
    return await this.runElectronNodeCommand(
      pnpmEntry,
      ['--config.minimum-release-age=0', ...args],
      join(harnessHome, 'profiles', profile),
      environment,
    )
  }

  async stop(): Promise<void> {
    const child = this.child
    this.stopping = true
    this.child = undefined
    this.activeCandidate = undefined
    this.activeEnvironment = undefined
    this.activePnpmEntry = undefined
    if (child === undefined) return
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

  private runHarnessCommand(
    candidate: HarnessRuntimeCandidate,
    args: string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<HarnessCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.electronExecutable, [
        '--expose-internals', HARNESS_BOOTSTRAP, candidate.entryPath, ...args,
      ], {
        cwd: this.workspacePath,
        env: {
          ...environment,
          DSH_DESKTOP: '1',
          DSH_DESKTOP_DIRECTORY_PICKER_URL: this.directoryPickerUrl,
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_NO_ATTACH_CONSOLE: '1',
          FORCE_COLOR: '0',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-200_000) })
      child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-200_000) })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        resolve({ exitCode: code ?? (signal === null ? -1 : 1), stdout, stderr })
      })
    })
  }

  private runElectronNodeCommand(
    entryPath: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<HarnessCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.electronExecutable, [entryPath, ...args], {
        cwd,
        env: {
          ...environment,
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_NO_ATTACH_CONSOLE: '1',
          FORCE_COLOR: '0',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-200_000) })
      child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-200_000) })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        resolve({ exitCode: code ?? (signal === null ? -1 : 1), stdout, stderr })
      })
    })
  }

  private waitForUrl(child: HarnessChild): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(() => finish(new Error('Harness did not publish its local URL in time')), START_TIMEOUT_MS)
      const onData = (chunk: Buffer): void => {
        output = `${output}${chunk.toString('utf8')}`.slice(-32_000)
        const match = URL_PATTERN.exec(output)
        if (match?.[1] !== undefined) finish(undefined, match[1])
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => finish(new Error(`Harness exited before startup (${String(code ?? signal)})`))
      const onError = (error: Error): void => finish(error)
      const finish = (error?: Error, url?: string): void => {
        clearTimeout(timeout)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
        child.off('error', onError)
        if (error !== undefined) reject(error)
        else resolve(url as string)
      }
      child.stdout.on('data', onData)
      child.once('exit', onExit)
      child.once('error', onError)
    })
  }

  private async waitForHealthy(url: string, child: HarnessChild): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    let lastError = 'not ready'
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Harness exited during health check (${String(child.exitCode ?? child.signalCode)})`)
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
        if (response.ok) return
        lastError = `HTTP ${response.status}`
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`Harness health check timed out: ${lastError}`)
  }
}
