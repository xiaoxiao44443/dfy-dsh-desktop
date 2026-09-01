import { EventEmitter } from 'node:events'
import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { access, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import semver from 'semver'
import { x as extractTar } from 'tar'
import type { HarnessReleaseVersion, HarnessUpdateStatus } from '../shared/contracts.js'
import { readRuntimeState, writeRuntimeState, type HarnessRuntimeState } from './runtime-state.js'
import { applyHarnessRuntimeCompatibility } from './runtime-compat.js'
import { prependToolchainToPath } from './harness-toolchain.js'

const require = createRequire(import.meta.url)
const HARNESS_PACKAGE = '@deepseek-ai/dsh'
export const DESKTOP_PNPM_VERSION = '11.19.0'
export const DESKTOP_KOFFI_VERSION = '3.1.6'
const PNPM_MINIMUM_RELEASE_AGE_CONFIG = '--config.minimum-release-age=0'
const BUNDLED_RUNTIME_POLICY_VERSION = 6
const REGISTRY_METADATA = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const RECENT_HARNESS_VERSION_LIMIT = 6
export const RUNTIME_PREPARATION_PROGRESS_EVENT = 'prepare-progress'
const INSTALL_SCRIPT_POLICY = {
  '@deepseek-ai/dsh-subprocess-local': true,
  '@google/genai': true,
  koffi: true,
  'node-pty': true,
  protobufjs: true,
} as const

export interface HarnessRuntimeCandidate {
  version: string
  entryPath: string
  source: 'bundled' | 'managed'
  pending: boolean
}

export interface RuntimeUpdateView {
  status: HarnessUpdateStatus
  version?: string
  latestVersion?: string
  versions: HarnessReleaseVersion[]
  progress?: number
  message?: string
}

interface RegistryMetadata {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, unknown>
  time?: Record<string, string>
}

interface RegistryCatalog {
  latestVersion: string
  versions: HarnessReleaseVersion[]
}

export function bundledArchiveProgress(bytesRead: number, totalBytes: number): number {
  if (!Number.isFinite(bytesRead) || !Number.isFinite(totalBytes) || totalBytes <= 0) return 0
  return Math.min(99, Math.max(0, Math.floor((bytesRead / totalBytes) * 100)))
}

export function pnpmInstallProgress(output: string): number | undefined {
  const packageMatches = [...output.matchAll(/Packages:\s+\+(\d+)/gu)]
  const progressMatches = [...output.matchAll(/Progress:[^\r\n]*\badded\s+(\d+)/gu)]
  const total = Number(packageMatches.at(-1)?.[1])
  const added = Number(progressMatches.at(-1)?.[1])
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(added) || added < 0) return undefined
  return 18 + Math.floor((Math.min(added, total) / total) * 62)
}

export function runtimeCommandErrorDetail(stdout: string, stderr: string): string {
  const clean = (output: string): string[] => {
    const lines = output
      .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/gu, '')
      .split(/[\r\n]+/u)
      .map((line) => line.trim())
      .filter((line) => (
        line.length > 0
        && !/^Progress:/u.test(line)
        && !/^Packages:\s+\+\d+/u.test(line)
        && !/^\+{10,}$/u.test(line)
        && !/^Packages are copied from /u.test(line)
        && !/^Content-addressable store is at:/u.test(line)
        && !/^Virtual store is at:/u.test(line)
      ))
    return lines.filter((line, index) => line !== lines[index - 1])
  }

  const stderrLines = clean(stderr)
  const detailLines = stderrLines.length > 0 ? stderrLines : clean(stdout)
  if (detailLines.length === 0) return '命令异常退出，未返回具体错误；请重试。'
  return detailLines.slice(-12).join('\n').slice(-2_000)
}

/**
 * npm tar archives do not retain Windows' directory-symlink flag. pnpm's
 * package links therefore come back as file symlinks after extraction and
 * Node fails to realpath them with EPERM. Convert every in-tree package link
 * to a directory junction after the runtime reaches its final path. Junctions
 * need no Developer Mode permission and survive normal application launches.
 */
export async function repairWindowsPnpmArchiveLinks(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  if (platform !== 'win32') return 0
  const runtimeRoot = resolve(root)
  const directories = [runtimeRoot]
  const links: string[] = []

  while (directories.length > 0) {
    const directory = directories.pop() as string
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      if (entry.isSymbolicLink()) links.push(entryPath)
      else if (entry.isDirectory()) directories.push(entryPath)
    }
  }

  for (const linkPath of links) {
    const targetPath = resolve(dirname(linkPath), await readlink(linkPath))
    const targetRelativePath = relative(runtimeRoot, targetPath)
    if (
      targetRelativePath === '..'
      || targetRelativePath.startsWith(`..${sep}`)
      || isAbsolute(targetRelativePath)
    ) throw new Error(`Bundled runtime link escapes its root: ${linkPath}`)
    if (!(await stat(targetPath)).isDirectory()) {
      throw new Error(`Bundled runtime link is not a package directory: ${linkPath}`)
    }
    await rm(linkPath, { force: true })
    await symlink(targetPath, linkPath, 'junction')
  }

  return links.length
}

export class HarnessRuntimeManager extends EventEmitter {
  private readonly runtimeRoot: string
  private readonly bundledVersionsRoot: string
  private readonly versionsRoot: string
  private readonly stagingRoot: string
  private readonly statePath: string
  private readonly packageStore: string
  private readonly legacyNpmCache: string
  private readonly toolchainBinPath: string
  private state: HarnessRuntimeState | undefined
  private bundled: HarnessRuntimeCandidate | undefined
  private updateView: RuntimeUpdateView = { status: 'idle', versions: [] }
  private updatePromise: Promise<void> | undefined
  private downloadRequested = false
  private updateTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly userDataPath: string,
    private readonly electronExecutable: string,
    private readonly bundledRuntimeRoot?: string,
    private readonly bundledArchivePath?: string,
    private readonly packagedPnpmCli?: string,
  ) {
    super()
    this.runtimeRoot = join(userDataPath, 'harness-runtime')
    this.bundledVersionsRoot = join(this.runtimeRoot, 'bundled')
    this.versionsRoot = join(this.runtimeRoot, 'versions')
    this.stagingRoot = join(this.runtimeRoot, 'staging')
    this.statePath = join(this.runtimeRoot, 'state.json')
    this.packageStore = join(this.runtimeRoot, 'package-store')
    this.legacyNpmCache = join(this.runtimeRoot, 'npm-cache')
    this.toolchainBinPath = join(userDataPath, 'harness-toolchain', 'bin')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.versionsRoot, { recursive: true }),
      mkdir(this.stagingRoot, { recursive: true }),
    ])
    this.state = await readRuntimeState(this.statePath)
    await this.ensureBundledRuntimeExtracted()
    this.bundled = await this.resolveBundledRuntime()
    await this.cleanupRuntimeStorage()
  }

  get harnessHome(): string {
    const configuredHome = process.env.DSH_HOME?.trim()
    return configuredHome === undefined || configuredHome.length === 0
      ? join(homedir(), '.dsh')
      : configuredHome
  }

  get updateState(): RuntimeUpdateView {
    return { ...this.updateView, versions: this.updateView.versions.map((entry) => ({ ...entry })) }
  }

  async launchCandidates(): Promise<HarnessRuntimeCandidate[]> {
    const state = this.mustState()
    const bundled = this.mustBundled()
    const candidates: HarnessRuntimeCandidate[] = []

    if (state.pendingVersion !== undefined && state.badVersions[state.pendingVersion] === undefined) {
      const pending = this.managedCandidate(state.pendingVersion, true)
      if (await this.isCandidatePresent(pending)) candidates.push(pending)
    }

    if (state.activeVersion !== undefined && state.badVersions[state.activeVersion] === undefined) {
      const active = this.managedCandidate(state.activeVersion, false)
      if (
        await this.isCandidatePresent(active)
        && !candidates.some((candidate) => candidate.version === active.version)
      ) {
        candidates.push(active)
      }
    }

    candidates.push(bundled)
    for (const candidate of candidates) {
      // Apply the narrowly-scoped rc.6 fix to every launch candidate. In
      // development the bundled candidate lives in the project pnpm store,
      // while packaged and managed candidates live under userData.
      await applyHarnessRuntimeCompatibility(candidate.entryPath)
    }
    return candidates
  }

  async markHealthy(candidate: HarnessRuntimeCandidate): Promise<void> {
    if (candidate.source === 'managed') {
      const state = this.mustState()
      state.activeVersion = candidate.version
      if (state.pendingVersion === candidate.version) delete state.pendingVersion
      delete state.badVersions[candidate.version]
      await this.persistState()
    }
    if (this.updateView.status === 'ready' && this.updateView.version === candidate.version) {
      this.setUpdateView({
        ...this.updateView,
        status: 'current',
        progress: 100,
        message: '当前正在使用这个版本',
      })
    }
  }

  async markFailed(candidate: HarnessRuntimeCandidate, reason: string): Promise<void> {
    if (candidate.source !== 'managed') return
    const state = this.mustState()
    state.badVersions[candidate.version] = {
      failedAt: new Date().toISOString(),
      reason: reason.slice(0, 1_000),
    }
    if (state.pendingVersion === candidate.version) delete state.pendingVersion
    if (state.activeVersion === candidate.version) delete state.activeVersion
    await this.persistState()
  }

  scheduleAutomaticChecks(initialDelayMs = 15_000): void {
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer)
    const run = (): void => {
      void this.checkForUpdates({ download: false }).finally(() => {
        this.updateTimer = setTimeout(run, UPDATE_INTERVAL_MS)
        this.updateTimer.unref()
      })
    }
    this.updateTimer = setTimeout(run, initialDelayMs)
    this.updateTimer.unref()
  }

  stopAutomaticChecks(): void {
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer)
    this.updateTimer = undefined
  }

  checkForUpdates(options: { download?: boolean } = { download: true }): Promise<void> {
    if (options.download !== false) this.downloadRequested = true
    if (this.updatePromise !== undefined) return this.updatePromise
    this.updatePromise = this.performUpdateCheck().finally(() => {
      this.updatePromise = undefined
      this.downloadRequested = false
    })
    return this.updatePromise
  }

  installHarnessVersion(version: string): Promise<void> {
    const normalizedVersion = semver.valid(version)
    if (normalizedVersion === null || normalizedVersion !== version) {
      return Promise.reject(new Error('请选择有效的 Harness 版本。'))
    }
    if (this.updatePromise !== undefined) {
      return Promise.reject(new Error('另一项 Harness 更新操作正在进行。'))
    }
    this.updatePromise = this.performVersionSelection(version).finally(() => {
      this.updatePromise = undefined
      this.downloadRequested = false
    })
    return this.updatePromise
  }

  private async performUpdateCheck(): Promise<void> {
    this.setUpdateView({ ...this.updateView, status: 'checking', progress: 0, message: '正在获取版本信息…' })
    try {
      const catalog = await this.fetchRegistryCatalog()
      const targetVersion = catalog.latestVersion

      const state = this.mustState()
      state.lastCheckAt = new Date().toISOString()
      const currentVersion = state.activeVersion ?? this.mustBundled().version

      if (this.downloadRequested) {
        await this.performVersionInstall(targetVersion, catalog)
        return
      }

      if (state.pendingVersion !== undefined) {
        await this.persistState()
        this.setUpdateView({
          status: 'ready',
          version: state.pendingVersion,
          latestVersion: targetVersion,
          versions: catalog.versions,
          progress: 100,
          message: '版本已准备好，重启 Harness 后生效',
        })
        return
      }

      if (!semver.gt(targetVersion, currentVersion)) {
        await this.persistState()
        this.setUpdateView({
          status: 'current',
          version: currentVersion,
          latestVersion: targetVersion,
          versions: catalog.versions,
          progress: 100,
          message: semver.gt(currentVersion, targetVersion) ? '当前版本高于 latest 版本' : '当前已是最新版本',
        })
        return
      }

      await this.persistState()
      this.setUpdateView({
        status: 'available',
        version: targetVersion,
        latestVersion: targetVersion,
        versions: catalog.versions,
        progress: 0,
        message: '发现新版本，可选择版本下载安装',
      })
    } catch (error) {
      this.setUpdateView({
        ...this.updateView,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async performVersionSelection(version: string): Promise<void> {
    let catalog: RegistryCatalog | undefined
    try {
      catalog = this.updateView.versions.some((entry) => entry.version === version)
        && this.updateView.latestVersion !== undefined
        ? { latestVersion: this.updateView.latestVersion, versions: this.updateView.versions }
        : await this.fetchRegistryCatalog()
      if (!catalog.versions.some((entry) => entry.version === version)) {
        throw new Error(`Harness ${version} 不在可安装的近期版本列表中。`)
      }
      await this.performVersionInstall(version, catalog)
    } catch (error) {
      this.setUpdateView({
        status: 'error',
        version,
        ...(catalog === undefined ? {} : { latestVersion: catalog.latestVersion }),
        versions: catalog?.versions ?? this.updateView.versions,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async performVersionInstall(version: string, catalog: RegistryCatalog): Promise<void> {
    const state = this.mustState()
    const currentVersion = state.activeVersion ?? this.mustBundled().version
    if (version === currentVersion && state.pendingVersion === undefined) {
      this.setUpdateView({
        status: 'current',
        version,
        latestVersion: catalog.latestVersion,
        versions: catalog.versions,
        progress: 100,
        message: '当前正在使用这个版本',
      })
      return
    }

    const publishProgress = (progress: number, message: string): void => {
      this.setUpdateView({
        status: 'downloading',
        version,
        latestVersion: catalog.latestVersion,
        versions: catalog.versions,
        progress,
        message,
      })
    }

    if (version === this.mustBundled().version) {
      publishProgress(90, '正在切换到桌面端内置版本…')
      delete state.activeVersion
      delete state.pendingVersion
    } else {
      await this.installVersion(version, publishProgress)
      state.pendingVersion = version
      delete state.badVersions[version]
    }
    await this.persistState()
    this.setUpdateView({
      status: 'ready',
      version,
      latestVersion: catalog.latestVersion,
      versions: catalog.versions,
      progress: 100,
      message: '版本已准备好，重启 Harness 后生效',
    })
  }

  private async fetchRegistryCatalog(): Promise<RegistryCatalog> {
    const response = await fetch(REGISTRY_METADATA, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`)
    const metadata = await response.json() as RegistryMetadata
    const latestVersion = metadata['dist-tags']?.latest
    if (latestVersion === undefined || semver.valid(latestVersion) === null) {
      throw new Error('npm registry did not return a valid latest version')
    }
    const distTagsByVersion = new Map<string, Set<string>>()
    for (const [rawTag, version] of Object.entries(metadata['dist-tags'] ?? {})) {
      const tag = rawTag.trim()
      if (tag.length === 0 || semver.valid(version) === null) continue
      const tags = distTagsByVersion.get(version) ?? new Set<string>()
      tags.add(tag)
      distTagsByVersion.set(version, tags)
    }
    const availableVersions = new Set(Object.keys(metadata.versions ?? {}).filter((version) => semver.valid(version) !== null))
    for (const version of distTagsByVersion.keys()) availableVersions.add(version)
    const versions = [...availableVersions]
      .sort((left, right) => {
        const leftTime = Date.parse(metadata.time?.[left] ?? '')
        const rightTime = Date.parse(metadata.time?.[right] ?? '')
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime
        return semver.rcompare(left, right)
      })
      .slice(0, RECENT_HARNESS_VERSION_LIMIT)
      .map((version) => {
        const distTags = [...(distTagsByVersion.get(version) ?? [])]
          .sort((left, right) => left === 'latest' ? -1 : right === 'latest' ? 1 : left.localeCompare(right))
        return {
          version,
          ...(metadata.time?.[version] === undefined ? {} : { publishedAt: metadata.time[version] }),
          ...(distTags.length === 0 ? {} : { distTags }),
        }
      })
    return { latestVersion, versions }
  }

  private async installVersion(version: string, onProgress: (progress: number, message: string) => void = () => undefined): Promise<void> {
    const finalPath = join(this.versionsRoot, version)
    if (await this.isCandidatePresent(this.managedCandidate(version, true))) {
      onProgress(88, '该版本已下载，正在准备切换…')
      return
    }

    const stagingPath = join(this.stagingRoot, `${version}-${Date.now()}-${process.pid}`)
    let installed = false
    onProgress(5, '正在准备下载目录…')
    await mkdir(stagingPath, { recursive: true })
    try {
      // Keep verified pnpm store entries after a failed attempt so a manual
      // retry only fetches missing packages. Startup cleanup and a successful
      // install still remove the temporary store.
      await mkdir(this.packageStore, { recursive: true })
      await writeFile(join(stagingPath, 'package.json'), `${JSON.stringify({
        name: 'dfy-dsh-desktop-managed-runtime',
        private: true,
        dependencies: {
          [HARNESS_PACKAGE]: version,
          koffi: DESKTOP_KOFFI_VERSION,
          pnpm: DESKTOP_PNPM_VERSION,
        },
      }, null, 2)}\n`, 'utf8')
      await writeFile(join(stagingPath, 'pnpm-workspace.yaml'), [
        'minimumReleaseAge: 0',
        'allowBuilds:',
        ...Object.entries(INSTALL_SCRIPT_POLICY).map(([name, allowed]) => `  ${JSON.stringify(name)}: ${String(allowed)}`),
        '',
      ].join('\n'), 'utf8')
      onProgress(18, '正在通过内置 pnpm 下载并安装…')
      let pnpmOutput = ''
      let reportedInstallProgress = 18
      const installArgs = [
        'install', PNPM_MINIMUM_RELEASE_AGE_CONFIG, '--dir', stagingPath, '--prod', '--no-lockfile', '--prefer-offline',
        '--store-dir', this.packageStore, '--package-import-method', 'copy',
        '--config.node-linker=hoisted',
      ]
      const captureInstallOutput = (chunk: string): void => {
        pnpmOutput = `${pnpmOutput}${chunk}`.slice(-16_000)
        const progress = pnpmInstallProgress(pnpmOutput)
        if (progress === undefined || progress <= reportedInstallProgress) return
        reportedInstallProgress = progress
        onProgress(progress, '正在通过内置 pnpm 下载并安装…')
      }
      try {
        await this.runNode(this.resolvePnpmCli(), installArgs, captureInstallOutput)
      } catch {
        onProgress(reportedInstallProgress, '下载中断，正在自动重试…')
        pnpmOutput = ''
        await this.runNode(this.resolvePnpmCli(), installArgs, captureInstallOutput)
      }
      onProgress(82, '下载完成，正在检查运行时文件…')
      const stagedEntry = join(stagingPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      const stagedPnpmEntry = join(stagingPath, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
      await Promise.all([access(stagedEntry), access(stagedPnpmEntry)])
      await applyHarnessRuntimeCompatibility(stagedEntry)
      onProgress(92, '正在验证 Harness 版本…')
      await this.runNode(stagedEntry, ['--version'])
      await rm(finalPath, { recursive: true, force: true })
      await rename(stagingPath, finalPath)
      installed = true
      onProgress(98, '正在保存已下载版本…')
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true })
      throw error
    } finally {
      if (installed) await this.removePath(this.packageStore)
    }
  }

  private runNode(entryPath: string, args: string[], onOutput: (chunk: string) => void = () => undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const environment = prependToolchainToPath(process.env, this.toolchainBinPath)
      const child = spawn(this.electronExecutable, [entryPath, ...args], {
        env: {
          ...environment,
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_NO_ATTACH_CONSOLE: '1',
          CI: 'true',
          npm_config_update_notifier: 'false',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const captureOutput = (source: 'stdout' | 'stderr', chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        if (source === 'stdout') stdout = `${stdout}${text}`.slice(-8_000)
        else stderr = `${stderr}${text}`.slice(-8_000)
        onOutput(text)
      }
      child.stdout?.on('data', (chunk: Buffer) => captureOutput('stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer) => captureOutput('stderr', chunk))
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0) resolve()
        else {
          const detail = runtimeCommandErrorDetail(stdout, stderr)
          reject(new Error(`runtime command failed (${String(code ?? signal)}):\n${detail}`))
        }
      })
    })
  }

  private resolvePnpmCli(): string {
    return this.packagedPnpmCli ?? join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs')
  }

  private async ensureBundledRuntimeExtracted(): Promise<void> {
    if (this.bundledRuntimeRoot === undefined || this.bundledArchivePath === undefined) return
    const entryPath = join(this.bundledRuntimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const pnpmEntryPath = join(this.bundledRuntimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    const receiptPath = join(this.bundledRuntimeRoot, '.desktop-runtime.json')
    try {
      const [, , receiptText] = await Promise.all([
        access(entryPath),
        access(pnpmEntryPath),
        readFile(receiptPath, 'utf8'),
      ])
      const receipt = JSON.parse(receiptText) as {
        pnpmVersion?: unknown
        koffiVersion?: unknown
        policyVersion?: unknown
      }
      if (
        receipt.pnpmVersion !== DESKTOP_PNPM_VERSION
        || receipt.koffiVersion !== DESKTOP_KOFFI_VERSION
        || receipt.policyVersion !== BUNDLED_RUNTIME_POLICY_VERSION
      ) throw new Error('Bundled runtime policy is stale')
      return
    } catch {
      // A runtime directory may predate a toolchain-policy change even when the
      // desktop version is unchanged. Re-extract instead of asking users to
      // delete userData manually.
    }

    const stagingPath = `${this.bundledRuntimeRoot}.staging-${process.pid}`
    await rm(stagingPath, { recursive: true, force: true })
    await mkdir(stagingPath, { recursive: true })
    let activated = false
    try {
      const archiveSize = (await stat(this.bundledArchivePath)).size
      let bytesRead = 0
      let lastProgress = 0
      this.emit(RUNTIME_PREPARATION_PROGRESS_EVENT, lastProgress)
      const archive = createReadStream(this.bundledArchivePath)
      archive.on('data', (chunk: string | Buffer) => {
        bytesRead += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        const progress = bundledArchiveProgress(bytesRead, archiveSize)
        if (progress === lastProgress) return
        lastProgress = progress
        this.emit(RUNTIME_PREPARATION_PROGRESS_EVENT, progress)
      })
      await pipeline(archive, extractTar({
        cwd: stagingPath,
        preservePaths: false,
        strict: true,
      }))
      await access(join(stagingPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      await access(join(stagingPath, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
      await rm(this.bundledRuntimeRoot, { recursive: true, force: true })
      await mkdir(dirname(this.bundledRuntimeRoot), { recursive: true })
      await rename(stagingPath, this.bundledRuntimeRoot)
      activated = true
      await repairWindowsPnpmArchiveLinks(this.bundledRuntimeRoot)
      await Promise.all([
        access(join(this.bundledRuntimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
        access(join(this.bundledRuntimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')),
      ])
      this.emit(RUNTIME_PREPARATION_PROGRESS_EVENT, 100)
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined)
      if (activated) await rm(this.bundledRuntimeRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async resolveBundledRuntime(): Promise<HarnessRuntimeCandidate> {
    const entryPath = this.bundledRuntimeRoot === undefined
      ? require.resolve('@deepseek-ai/dsh/lib/bin.js')
      : join(this.bundledRuntimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await access(entryPath)
    const manifest = JSON.parse(await readFile(join(dirname(dirname(entryPath)), 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof manifest.version !== 'string' || semver.valid(manifest.version) === null) {
      throw new Error('The bundled DeepSeek Harness has no valid version')
    }
    return { version: manifest.version, entryPath, source: 'bundled', pending: false }
  }

  private managedCandidate(version: string, pending: boolean): HarnessRuntimeCandidate {
    return {
      version,
      entryPath: join(this.versionsRoot, version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      source: 'managed',
      pending,
    }
  }

  private async isCandidatePresent(candidate: HarnessRuntimeCandidate): Promise<boolean> {
    try { await access(candidate.entryPath); return true } catch { return false }
  }

  private async cleanupRuntimeStorage(): Promise<void> {
    const state = this.mustState()
    const bundled = this.mustBundled()
    const managedVersionsToKeep = new Set<string>()
    let stateChanged = false

    for (const key of ['activeVersion', 'pendingVersion'] as const) {
      const version = state[key]
      if (version === undefined) continue
      const usableManagedRuntime = semver.valid(version) !== null
        && version !== bundled.version
        && state.badVersions[version] === undefined
        && await this.isCandidatePresent(this.managedCandidate(version, key === 'pendingVersion'))
      if (usableManagedRuntime) {
        managedVersionsToKeep.add(version)
      } else {
        delete state[key]
        stateChanged = true
      }
    }

    for (const version of Object.keys(state.badVersions)) {
      if (semver.valid(version) !== null && semver.lte(version, bundled.version)) {
        delete state.badVersions[version]
        stateChanged = true
      }
    }

    if (stateChanged) await this.persistState()

    await Promise.all([
      this.removeObsoleteBundledRuntimes(),
      this.removeObsoleteManagedRuntimes(managedVersionsToKeep),
      this.removePath(this.stagingRoot),
      this.removePath(this.packageStore),
      this.removePath(this.legacyNpmCache),
    ])
  }

  private async removeObsoleteBundledRuntimes(): Promise<void> {
    if (this.bundledRuntimeRoot === undefined) return
    const entries = await readdir(this.bundledVersionsRoot, { withFileTypes: true }).catch(() => [])
    const bundledRuntimeRoot = resolve(this.bundledRuntimeRoot)
    const bundledRuntimeIsManagedHere = pathsEqual(dirname(bundledRuntimeRoot), this.bundledVersionsRoot)
    await Promise.all(entries.map(async (entry) => {
      const entryPath = join(this.bundledVersionsRoot, entry.name)
      if (bundledRuntimeIsManagedHere && pathsEqual(entryPath, bundledRuntimeRoot)) return
      await this.removePath(entryPath)
    }))
  }

  private async removeObsoleteManagedRuntimes(versionsToKeep: ReadonlySet<string>): Promise<void> {
    const entries = await readdir(this.versionsRoot, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.map(async (entry) => {
      if (versionsToKeep.has(entry.name)) return
      await this.removePath(join(this.versionsRoot, entry.name))
    }))
  }

  private async removePath(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Runtime cleanup is best effort. A locked cache or stale version must not
      // prevent the known-good bundled Harness from starting.
    }
  }

  private mustState(): HarnessRuntimeState {
    if (this.state === undefined) throw new Error('HarnessRuntimeManager has not been initialized')
    return this.state
  }

  private mustBundled(): HarnessRuntimeCandidate {
    if (this.bundled === undefined) throw new Error('HarnessRuntimeManager has not been initialized')
    return this.bundled
  }

  private async persistState(): Promise<void> {
    await writeRuntimeState(this.statePath, this.mustState())
  }

  private setUpdateView(view: RuntimeUpdateView): void {
    this.updateView = { ...view, versions: view.versions.map((entry) => ({ ...entry })) }
    this.emit('update-state', this.updateState)
  }
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}
