import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import semver from 'semver'
import type { DesktopUpdateState } from '../shared/contracts.js'

const RELEASES_API_URL = 'https://api.github.com/repos/xiaoxiao44443/dfy-dsh-desktop/releases?per_page=20'
const RELEASES_PAGE_URL = 'https://github.com/xiaoxiao44443/dfy-dsh-desktop/releases'
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_CHECKSUM_FILE_BYTES = 1024 * 1024
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024
const PENDING_FILE = 'pending.json'

interface GitHubReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

interface GitHubRelease {
  tag_name: string
  html_url: string
  published_at?: string | null
  draft: boolean
  prerelease: boolean
  assets: GitHubReleaseAsset[]
}

interface DesktopReleaseCandidate {
  version: string
  publishedAt?: string
  releaseUrl: string
  installer: GitHubReleaseAsset
  checksums: GitHubReleaseAsset
}

interface PendingDesktopUpdate {
  version: string
  assetName: string
  downloadedAt: string
  releaseUrl?: string
}

export interface DesktopUpdateOptions {
  updatesRoot: string
  currentVersion: string
  platform?: NodeJS.Platform
  arch?: string
  fetcher?: typeof globalThis.fetch
  releasesApiUrl?: string
  releasesPageUrl?: string
  allowLoopbackHttp?: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function releaseVersion(tag: string): string | undefined {
  const normalized = tag.trim().replace(/^v/u, '')
  return semver.valid(normalized) ?? undefined
}

function safeAssetName(name: string): boolean {
  return name.length > 0 && name.length <= 240 && basename(name) === name && !/[\0\r\n]/u.test(name)
}

function installerAssetName(platform: NodeJS.Platform, arch: string, version: string): string | undefined {
  if (platform === 'darwin' && arch === 'x64') return `DFY-DSH-Desktop-${version}-macos-x64.dmg`
  if (platform === 'win32' && arch === 'x64') return `DFY-DSH-Desktop-${version}-x64.exe`
  return undefined
}

function isSafeRemoteUrl(value: string, allowLoopbackHttp: boolean): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    return allowLoopbackHttp
      && url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

function isReleaseAsset(value: unknown, allowLoopbackHttp: boolean): value is GitHubReleaseAsset {
  if (value === null || typeof value !== 'object') return false
  const asset = value as Partial<GitHubReleaseAsset>
  return typeof asset.name === 'string'
    && typeof asset.browser_download_url === 'string'
    && isSafeRemoteUrl(asset.browser_download_url, allowLoopbackHttp)
    && typeof asset.size === 'number'
    && Number.isSafeInteger(asset.size)
}

function parseChecksumFile(contents: string, assetName: string): string | undefined {
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line.trim())
    if (match?.[2] === assetName) return match[1]?.toLowerCase()
  }
  return undefined
}

export class DesktopUpdateService extends EventEmitter {
  private view: DesktopUpdateState = { status: 'idle' }
  private candidate: DesktopReleaseCandidate | undefined
  private pending: PendingDesktopUpdate | undefined
  private checkPromise: Promise<void> | undefined
  private downloadPromise: Promise<void> | undefined
  private updateTimer: NodeJS.Timeout | undefined
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly fetcher: typeof globalThis.fetch
  private readonly releasesApiUrl: string
  private readonly releasesPageUrl: string
  private readonly allowLoopbackHttp: boolean

  constructor(private readonly options: DesktopUpdateOptions) {
    super()
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.fetcher = options.fetcher ?? globalThis.fetch
    this.allowLoopbackHttp = options.allowLoopbackHttp === true
    this.releasesApiUrl = options.releasesApiUrl ?? RELEASES_API_URL
    this.releasesPageUrl = options.releasesPageUrl ?? RELEASES_PAGE_URL
    if (semver.valid(options.currentVersion) === null) {
      throw new Error(`桌面端版本号无效：${options.currentVersion}`)
    }
    if (!isSafeRemoteUrl(this.releasesApiUrl, this.allowLoopbackHttp)
      || !isSafeRemoteUrl(this.releasesPageUrl, this.allowLoopbackHttp)) {
      throw new Error('桌面端更新地址必须使用 HTTPS；开发演示仅允许本机回环 HTTP。')
    }
  }

  get state(): DesktopUpdateState {
    return { ...this.view }
  }

  get releasesUrl(): string {
    return this.view.releaseUrl ?? this.releasesPageUrl
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.updatesRoot, { recursive: true })
    const pending = await this.readPending()
    if (pending === undefined) await rm(join(this.options.updatesRoot, PENDING_FILE), { force: true })
    if (pending !== undefined && semver.gte(this.options.currentVersion, pending.version)) {
      await this.removePending(pending)
    } else if (pending !== undefined) {
      const path = this.pendingInstallerPath(pending)
      try {
        await access(path)
        this.pending = pending
        this.setState({
          status: 'ready',
          version: pending.version,
          ...(pending.releaseUrl === undefined ? {} : { releaseUrl: pending.releaseUrl }),
          message: '安装包已下载，可以退出桌面端后覆盖安装。',
        })
      } catch {
        await this.removePending(pending)
      }
    }
    await this.cleanupUpdateDirectories(this.pending?.version)
  }

  scheduleAutomaticChecks(initialDelayMs = 5_000): void {
    this.stopAutomaticChecks()
    const run = (): void => {
      if (this.view.status !== 'ready' && this.view.status !== 'downloading') {
        void this.checkForUpdates().catch(() => undefined)
      }
      this.updateTimer = setTimeout(run, UPDATE_INTERVAL_MS)
      this.updateTimer.unref()
    }
    this.updateTimer = setTimeout(run, initialDelayMs)
    this.updateTimer.unref()
  }

  stopAutomaticChecks(): void {
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer)
    this.updateTimer = undefined
  }

  checkForUpdates(): Promise<void> {
    if (this.checkPromise !== undefined) return this.checkPromise
    this.checkPromise = this.performUpdateCheck().finally(() => {
      this.checkPromise = undefined
    })
    return this.checkPromise
  }

  downloadUpdate(): Promise<void> {
    if (this.downloadPromise !== undefined) return this.downloadPromise
    this.downloadPromise = this.performDownload().finally(() => {
      this.downloadPromise = undefined
    })
    return this.downloadPromise
  }

  async installerPath(): Promise<string> {
    if (this.view.status !== 'ready' || this.pending === undefined) {
      throw new Error('桌面端安装包尚未准备完成。')
    }
    const path = this.pendingInstallerPath(this.pending)
    await access(path)
    return path
  }

  private async performUpdateCheck(): Promise<void> {
    if (this.downloadPromise !== undefined) return
    this.setState({ status: 'checking', message: '正在检查桌面端版本…' })
    try {
      if (installerAssetName(this.platform, this.arch, this.options.currentVersion) === undefined) {
        throw new Error(`暂不支持 ${this.platform}/${this.arch} 的覆盖安装。`)
      }
      const response = await this.fetcher(this.releasesApiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'DFY-DSH-Desktop',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      if (!response.ok) throw new Error(`GitHub Release 查询失败（HTTP ${response.status}）。`)
      const payload = await response.json() as unknown
      if (!Array.isArray(payload)) throw new Error('GitHub Release 返回了无法识别的数据。')
      const currentIsPrerelease = semver.prerelease(this.options.currentVersion) !== null
      const releases = payload.filter((value): value is GitHubRelease => {
        if (value === null || typeof value !== 'object') return false
        const release = value as Partial<GitHubRelease>
        return typeof release.tag_name === 'string'
          && typeof release.html_url === 'string'
          && typeof release.draft === 'boolean'
          && typeof release.prerelease === 'boolean'
          && Array.isArray(release.assets)
      })
      const release = releases
        .map((entry) => ({ entry, version: releaseVersion(entry.tag_name) }))
        .filter((entry): entry is { entry: GitHubRelease; version: string } => entry.version !== undefined)
        .filter(({ entry, version }) => !entry.draft
          && (currentIsPrerelease || !entry.prerelease)
          && semver.gt(version, this.options.currentVersion))
        .sort((left, right) => semver.rcompare(left.version, right.version))[0]
      if (release === undefined) {
        this.candidate = undefined
        this.setState({ status: 'current', message: '当前桌面端已经是最新版本。' })
        return
      }
      const expectedInstallerName = installerAssetName(this.platform, this.arch, release.version) as string
      const assets = release.entry.assets.filter((asset) => isReleaseAsset(asset, this.allowLoopbackHttp))
      const installer = assets.find((asset) => safeAssetName(asset.name)
        && asset.name === expectedInstallerName
        && asset.size > 0
        && asset.size <= MAX_INSTALLER_BYTES)
      const checksums = assets.find((asset) => asset.name === 'SHA256SUMS.txt'
        && asset.size > 0
        && asset.size <= MAX_CHECKSUM_FILE_BYTES)
      if (installer === undefined || checksums === undefined) {
        throw new Error(`桌面端 ${release.version} 缺少适用于当前系统的安装包或校验文件。`)
      }
      this.candidate = {
        version: release.version,
        ...(release.entry.published_at === undefined || release.entry.published_at === null
          ? {}
          : { publishedAt: release.entry.published_at }),
        releaseUrl: release.entry.html_url,
        installer,
        checksums,
      }
      this.setState({
        status: 'available',
        version: release.version,
        ...(this.candidate.publishedAt === undefined ? {} : { publishedAt: this.candidate.publishedAt }),
        releaseUrl: release.entry.html_url,
        message: '发现新的桌面端版本，点击后才会下载安装包。',
      })
    } catch (error) {
      this.setState({ status: 'error', message: errorMessage(error) })
      throw error
    }
  }

  private async performDownload(): Promise<void> {
    const candidate = this.candidate
    if (candidate === undefined || this.view.status !== 'available') {
      throw new Error('请先检查桌面端更新。')
    }
    const versionRoot = join(this.options.updatesRoot, candidate.version)
    const finalPath = join(versionRoot, candidate.installer.name)
    const partialPath = `${finalPath}.part`
    this.setState({
      status: 'downloading',
      version: candidate.version,
      ...(candidate.publishedAt === undefined ? {} : { publishedAt: candidate.publishedAt }),
      releaseUrl: candidate.releaseUrl,
      progress: 0,
      message: '正在读取安装包校验信息…',
    })
    try {
      if (this.pending !== undefined) await this.removePending(this.pending)
      await this.cleanupUpdateDirectories()
      await mkdir(versionRoot, { recursive: true })
      const checksumResponse = await this.fetcher(candidate.checksums.browser_download_url)
      if (!checksumResponse.ok) throw new Error(`安装包校验信息下载失败（HTTP ${checksumResponse.status}）。`)
      const checksumContents = await checksumResponse.text()
      if (Buffer.byteLength(checksumContents) > MAX_CHECKSUM_FILE_BYTES) throw new Error('安装包校验文件过大。')
      const expectedChecksum = parseChecksumFile(checksumContents, candidate.installer.name)
      if (expectedChecksum === undefined) throw new Error('校验文件中没有当前安装包的 SHA-256。')

      const response = await this.fetcher(candidate.installer.browser_download_url)
      if (!response.ok || response.body === null) throw new Error(`桌面端安装包下载失败（HTTP ${response.status}）。`)
      const handle = await open(partialPath, 'w', 0o600)
      const digest = createHash('sha256')
      let downloaded = 0
      let lastProgress = -1
      try {
        const reader = response.body.getReader()
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          downloaded += chunk.value.byteLength
          if (downloaded > MAX_INSTALLER_BYTES) throw new Error('桌面端安装包超过允许的大小。')
          digest.update(chunk.value)
          let offset = 0
          while (offset < chunk.value.byteLength) {
            const { bytesWritten } = await handle.write(chunk.value, offset, chunk.value.byteLength - offset, null)
            if (bytesWritten < 1) throw new Error('桌面端安装包写入失败。')
            offset += bytesWritten
          }
          const progress = Math.min(100, Math.floor((downloaded / candidate.installer.size) * 100))
          if (progress !== lastProgress) {
            lastProgress = progress
            this.setState({ ...this.view, progress, message: '正在下载桌面端安装包…' })
          }
        }
      } finally {
        await handle.close()
      }
      if (downloaded !== candidate.installer.size) throw new Error('桌面端安装包大小与 Release 信息不一致。')
      if (digest.digest('hex') !== expectedChecksum) throw new Error('桌面端安装包 SHA-256 校验失败。')
      await rm(finalPath, { force: true })
      await rename(partialPath, finalPath)
      const pending: PendingDesktopUpdate = {
        version: candidate.version,
        assetName: candidate.installer.name,
        downloadedAt: new Date().toISOString(),
        releaseUrl: candidate.releaseUrl,
      }
      await this.writePending(pending)
      this.pending = pending
      this.setState({
        status: 'ready',
        version: candidate.version,
        ...(candidate.publishedAt === undefined ? {} : { publishedAt: candidate.publishedAt }),
        releaseUrl: candidate.releaseUrl,
        progress: 100,
        message: '安装包已下载，退出桌面端后即可覆盖安装。',
      })
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined)
      await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined)
      this.setState({
        status: 'error',
        version: candidate.version,
        releaseUrl: candidate.releaseUrl,
        message: errorMessage(error),
      })
      throw error
    }
  }

  private pendingInstallerPath(pending: PendingDesktopUpdate): string {
    return join(this.options.updatesRoot, pending.version, pending.assetName)
  }

  private async readPending(): Promise<PendingDesktopUpdate | undefined> {
    try {
      const value = JSON.parse(await readFile(join(this.options.updatesRoot, PENDING_FILE), 'utf8')) as Partial<PendingDesktopUpdate>
      if (typeof value.version !== 'string'
        || semver.valid(value.version) === null
        || typeof value.assetName !== 'string'
        || !safeAssetName(value.assetName)
        || typeof value.downloadedAt !== 'string'
        || (value.releaseUrl !== undefined && typeof value.releaseUrl !== 'string')) return undefined
      return {
        version: value.version,
        assetName: value.assetName,
        downloadedAt: value.downloadedAt,
        ...(value.releaseUrl === undefined ? {} : { releaseUrl: value.releaseUrl }),
      }
    } catch {
      return undefined
    }
  }

  private async writePending(pending: PendingDesktopUpdate): Promise<void> {
    const path = join(this.options.updatesRoot, PENDING_FILE)
    const temporaryPath = `${path}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 })
    await rm(path, { force: true })
    await rename(temporaryPath, path)
  }

  private async removePending(pending: PendingDesktopUpdate): Promise<void> {
    await rm(join(this.options.updatesRoot, pending.version), { recursive: true, force: true })
    await rm(join(this.options.updatesRoot, PENDING_FILE), { force: true })
    this.pending = undefined
  }

  private async cleanupUpdateDirectories(keepVersion?: string): Promise<void> {
    const entries = await readdir(this.options.updatesRoot, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      if (entry.name === PENDING_FILE || entry.name === `${PENDING_FILE}.tmp`) return
      if (entry.isDirectory() && entry.name === keepVersion) return
      await rm(join(this.options.updatesRoot, entry.name), { recursive: true, force: true })
    }))
  }

  private setState(state: DesktopUpdateState): void {
    this.view = state
    this.emit('state', this.state)
  }
}
