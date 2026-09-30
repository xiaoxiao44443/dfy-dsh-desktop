import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'

const SAMPLE_BYTES = 512 * 1024
const PROBE_TIMEOUT_MS = 8_000
const DOWNLOAD_IDLE_TIMEOUT_MS = 15_000
const RANKING_TTL_MS = 30 * 60 * 1000

export interface DownloadSource {
  name: string
  url: string
}

export interface DownloadProgress {
  source: string
  downloaded: number
  bytesPerSecond: number
  verifying: boolean
}

export interface DesktopDownloadRequest {
  url: string
  size: number
  checksum: string
  partialPath: string
  onProgress: (progress: DownloadProgress) => void
  onTesting: () => void
  onFallback: (source: string) => void
}

/** Only our public GitHub release assets are forwarded to third-party proxies. */
export function desktopDownloadSources(original: string): DownloadSource[] {
  const url = new URL(original)
  const direct = { name: 'GitHub 直连', url: original }
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith('/xiaoxiao44443/dfy-dsh-desktop/releases/download/')) {
    return [{ name: '原始下载源', url: original }]
  }
  return [direct, ...['gh-proxy.com', 'ghproxy.net', 'ghfast.top'].map((host) => ({
    name: host,
    url: `https://${host}/${original}`,
  }))]
}

/** Bound the operation even when a custom fetcher or stream ignores cancellation. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(signal.reason)
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function validateResponse(response: Response, requestedUrl: string): void {
  if (response.url && new URL(response.url).protocol !== 'https:') {
    // Loopback HTTP is used only by the desktop updater's local test/demo mode.
    const url = new URL(response.url)
    if (new URL(requestedUrl).protocol !== 'http:' || url.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('下载线路跳转到了不安全的地址。')
    }
  }
  if (/text\/html|application\/(?:json|xhtml\+xml)/iu.test(response.headers.get('content-type') ?? '')) {
    throw new Error('下载线路返回了网页，未返回安装包。')
  }
  if (response.body === null) throw new Error('下载线路没有返回文件内容。')
}

class DownloadSourceError extends Error {}

export class DesktopInstallerDownloader {
  private ranking: { key: string; at: number; sources: DownloadSource[] } | undefined

  constructor(private readonly fetcher: typeof globalThis.fetch = globalThis.fetch) {}

  private async probe(source: DownloadSource, size: number): Promise<number> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('下载线路测速超时。')), PROBE_TIMEOUT_MS)
    const sampleSize = Math.min(size, SAMPLE_BYTES)
    const started = performance.now()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await abortable(this.fetcher(source.url, {
        headers: { Range: `bytes=0-${sampleSize - 1}`, 'User-Agent': 'DFY-DSH-Desktop' },
        signal: controller.signal,
      }), controller.signal)
      validateResponse(response, source.url)
      if (response.status !== 200 && response.status !== 206) throw new Error(`HTTP ${response.status}`)
      if (response.status === 206) {
        const range = /^bytes 0-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '')
        if (!range || Number(range[1]) !== sampleSize - 1 || Number(range[2]) !== size) {
          throw new Error('下载线路的分段信息与安装包不一致。')
        }
      }
      reader = response.body!.getReader()
      let bytes = 0
      while (bytes < sampleSize) {
        const chunk = await abortable(reader.read(), controller.signal)
        if (chunk.done) throw new Error('下载线路的测速数据不完整。')
        bytes += Math.min(chunk.value.byteLength, sampleSize - bytes)
      }
      // Include DNS, TLS and first-byte latency, not just transfer time.
      return sampleSize / Math.max(1, performance.now() - started)
    } finally {
      clearTimeout(timeout)
      controller.abort()
      void reader?.cancel().catch(() => undefined)
    }
  }

  async rankedSources(url: string, size: number, onTesting: () => void): Promise<DownloadSource[]> {
    const sources = desktopDownloadSources(url)
    if (sources.length === 1) return sources
    const key = `${url}\n${size}`
    if (this.ranking?.key === key && Date.now() - this.ranking.at < RANKING_TTL_MS) {
      return [...this.ranking.sources]
    }
    onTesting()
    const probes = await Promise.allSettled(sources.map(async (source) => ({ source, speed: await this.probe(source, size) })))
    const ranked = probes.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      .sort((a, b) => b.speed - a.speed).map(({ source }) => source)
    if (ranked.length === 0) throw new Error('所有下载线路测速失败，请检查网络后重试。')
    this.ranking = { key, at: Date.now(), sources: ranked }
    return [...ranked]
  }

  async download(request: DesktopDownloadRequest): Promise<void> {
    const sources = await this.rankedSources(request.url, request.size, request.onTesting)
    const failures: string[] = []
    for (const [index, source] of sources.entries()) {
      if (index > 0) request.onFallback(source.name)
      try {
        await this.downloadFrom(source, request)
        return
      } catch (error) {
        await rm(request.partialPath, { force: true })
        // Local disk failures cannot be fixed by another network route.
        if (!(error instanceof DownloadSourceError)) throw error
        this.ranking = undefined
        failures.push(`${source.name}：${error.message}`)
      }
    }
    throw new Error(`安装包下载失败，已尝试所有可用线路。${failures.join('；')}`)
  }

  private async downloadFrom(source: DownloadSource, request: DesktopDownloadRequest): Promise<void> {
    const controller = new AbortController()
    let idle: NodeJS.Timeout | undefined
    const resetIdle = (): void => {
      if (idle !== undefined) clearTimeout(idle)
      idle = setTimeout(() => controller.abort(new Error('下载线路超过 15 秒没有响应。')), DOWNLOAD_IDLE_TIMEOUT_MS)
    }
    const network = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await abortable(operation(), controller.signal) }
      catch (error) { throw new DownloadSourceError(error instanceof Error ? error.message : String(error)) }
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      request.onProgress({ source: source.name, downloaded: 0, bytesPerSecond: 0, verifying: false })
      resetIdle()
      const response = await network(() => this.fetcher(source.url, {
        headers: { 'User-Agent': 'DFY-DSH-Desktop' }, signal: controller.signal,
      }))
      try {
        validateResponse(response, source.url)
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
        const length = response.headers.get('content-length')
        if (length !== null && Number(length) !== request.size) throw new Error('安装包大小与 Release 信息不一致。')
      } catch (error) {
        throw new DownloadSourceError(error instanceof Error ? error.message : String(error))
      }
      reader = response.body!.getReader()
      handle = await open(request.partialPath, 'w', 0o600)
      const digest = createHash('sha256')
      let downloaded = 0
      let lastReported = performance.now()
      let lastBytes = 0
      while (true) {
        resetIdle()
        const chunk = await network(() => reader!.read())
        if (chunk.done) break
        if (chunk.value.byteLength === 0) continue
        downloaded += chunk.value.byteLength
        if (downloaded > request.size) throw new DownloadSourceError('安装包大小超过 Release 声明的大小。')
        digest.update(chunk.value)
        let offset = 0
        while (offset < chunk.value.byteLength) {
          const { bytesWritten } = await handle.write(chunk.value, offset, chunk.value.byteLength - offset, null)
          if (bytesWritten < 1) throw new Error('桌面端安装包写入失败。')
          offset += bytesWritten
        }
        const now = performance.now()
        if (now - lastReported >= 500 || downloaded === request.size) {
          request.onProgress({ source: source.name, downloaded,
            bytesPerSecond: (downloaded - lastBytes) * 1000 / Math.max(1, now - lastReported), verifying: false })
          lastReported = now
          lastBytes = downloaded
        }
      }
      request.onProgress({ source: source.name, downloaded, bytesPerSecond: 0, verifying: true })
      if (downloaded !== request.size) throw new DownloadSourceError('安装包大小与 Release 信息不一致。')
      if (digest.digest('hex') !== request.checksum) throw new DownloadSourceError('桌面端安装包 SHA-256 校验失败。')
    } finally {
      if (idle !== undefined) clearTimeout(idle)
      controller.abort()
      void reader?.cancel().catch(() => undefined)
      await handle?.close()
    }
  }
}

/** Legacy releases have no API digest; read their checksum from the original URL. */
export async function fetchDesktopChecksums(fetcher: typeof globalThis.fetch, url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('安装包校验信息下载超时。')), DOWNLOAD_IDLE_TIMEOUT_MS)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await abortable(fetcher(url, { signal: controller.signal }), controller.signal)
    if (!response.ok || response.body === null) throw new Error(`安装包校验信息下载失败（HTTP ${response.status}）。`)
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const chunk = await abortable(reader.read(), controller.signal)
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 1024 * 1024) throw new Error('安装包校验文件过大。')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    clearTimeout(timer)
    controller.abort()
    void reader?.cancel().catch(() => undefined)
  }
}
