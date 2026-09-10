import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix, resolve, win32 } from 'node:path'

export const BROWSER_SCREENSHOT_MIME_TYPE = 'image/png' as const
export const MAX_BROWSER_SCREENSHOT_EDGE = 8_192
export const MAX_BROWSER_SCREENSHOT_PIXELS = 32 * 1_024 * 1_024
export const MAX_BROWSER_SCREENSHOT_BYTES = 32 * 1_024 * 1_024
export const DEFAULT_BROWSER_SCREENSHOT_CACHE_BYTES = 256 * 1_024 * 1_024
export const DEFAULT_BROWSER_SCREENSHOT_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const DEFAULT_BROWSER_SCREENSHOT_RESOURCE_AGE_MS = 60 * 60 * 1_000
const MAX_REGISTERED_SCREENSHOT_BYTES = 128 * 1_024 * 1_024
const SCREENSHOT_FILE_PATTERN = /^browser-[0-9a-z]+-[a-f0-9]{16}\.png$/u
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export interface CssScreenshotRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserScreenshotMetadata {
  width: number
  height: number
  sourceUrl: string
  capturedAt: string
  kind: 'viewport' | 'rect' | 'element'
  rect?: CssScreenshotRect
  scrollX: number
  scrollY: number
  viewportWidth?: number
  viewportHeight?: number
  coordinateMapping?: {
    originX: number
    originY: number
    cssPixelsPerImagePixelX: number
    cssPixelsPerImagePixelY: number
  }
}

export interface BrowserScreenshotResource extends BrowserScreenshotMetadata {
  id: string
  path: string
  mimeType: typeof BROWSER_SCREENSHOT_MIME_TYPE
  bytes: number
  data: Buffer
  expiresAt: number
}

export interface BrowserScreenshotResult extends BrowserScreenshotMetadata {
  resourceId: string
  path: string
  mimeType: typeof BROWSER_SCREENSHOT_MIME_TYPE
  bytes: number
}

export interface BrowserScreenshotCacheStats {
  path: string
  files: number
  bytes: number
}

export interface ScreenshotCacheEntry {
  name: string
  bytes: number
  modifiedAt: number
}

export interface BrowserScreenshotStoreOptions {
  maxCacheBytes?: number
  maxCacheAgeMs?: number
  maxResourceAgeMs?: number
  now?: () => number
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是大于 0 的有限数值。`)
  return value
}

export function clipCssScreenshotRect(
  rect: CssScreenshotRect,
  viewport: { width: number; height: number },
): CssScreenshotRect {
  const viewportWidth = finitePositive(viewport.width, 'viewport.width')
  const viewportHeight = finitePositive(viewport.height, 'viewport.height')
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error('截图区域必须使用有限的 CSS 像素坐标。')
  if (rect.width <= 0 || rect.height <= 0) throw new Error('截图区域的 width 和 height 必须大于 0。')
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(viewportWidth, rect.x + rect.width)
  const bottom = Math.min(viewportHeight, rect.y + rect.height)
  if (right <= left || bottom <= top) throw new Error('截图区域位于当前视口之外。')
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function cssRectToImageCrop(
  rect: CssScreenshotRect,
  viewport: { width: number; height: number },
  image: { width: number; height: number },
): { rect: CssScreenshotRect; crop: CssScreenshotRect; scaleX: number; scaleY: number } {
  const clipped = clipCssScreenshotRect(rect, viewport)
  const imageWidth = finitePositive(image.width, 'image.width')
  const imageHeight = finitePositive(image.height, 'image.height')
  const scaleX = imageWidth / viewport.width
  const scaleY = imageHeight / viewport.height
  const left = Math.max(0, Math.floor(clipped.x * scaleX))
  const top = Math.max(0, Math.floor(clipped.y * scaleY))
  const right = Math.min(imageWidth, Math.ceil((clipped.x + clipped.width) * scaleX))
  const bottom = Math.min(imageHeight, Math.ceil((clipped.y + clipped.height) * scaleY))
  if (right <= left || bottom <= top) throw new Error('截图区域映射到实际图像后为空。')
  return {
    rect: clipped,
    crop: { x: left, y: top, width: right - left, height: bottom - top },
    scaleX,
    scaleY,
  }
}

export function pathIsInside(root: string, target: string, platform: 'posix' | 'win32' = process.platform === 'win32' ? 'win32' : 'posix'): boolean {
  const api = platform === 'win32' ? win32 : posix
  const rootPath = api.resolve(root)
  const targetPath = api.resolve(target)
  const child = api.relative(rootPath, targetPath)
  return child.length > 0 && child !== '..' && !child.startsWith(`..${api.sep}`) && !api.isAbsolute(child)
}

export function selectScreenshotCacheRemovals(
  entries: readonly ScreenshotCacheEntry[],
  now: number,
  maxAgeMs: number,
  maxBytes: number,
): string[] {
  const removals = new Set(entries
    .filter((entry) => now - entry.modifiedAt > maxAgeMs)
    .map((entry) => entry.name))
  let retainedBytes = entries.reduce((total, entry) => removals.has(entry.name) ? total : total + entry.bytes, 0)
  for (const entry of [...entries].filter((item) => !removals.has(item.name)).sort((left, right) => left.modifiedAt - right.modifiedAt)) {
    if (retainedBytes <= maxBytes) break
    removals.add(entry.name)
    retainedBytes -= entry.bytes
  }
  return [...removals]
}

function assertPng(data: Buffer): void {
  if (data.byteLength === 0 || data.byteLength > MAX_BROWSER_SCREENSHOT_BYTES) {
    throw new Error(`截图 PNG 必须小于等于 ${String(MAX_BROWSER_SCREENSHOT_BYTES)} 字节。`)
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (data.byteLength < signature.length || signature.some((value, index) => data[index] !== value)) {
    throw new Error('截图结果不是有效的 PNG 数据。')
  }
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width > MAX_BROWSER_SCREENSHOT_EDGE || height > MAX_BROWSER_SCREENSHOT_EDGE
    || width * height > MAX_BROWSER_SCREENSHOT_PIXELS) {
    throw new Error(`截图尺寸无效或超过限制：${String(width)}×${String(height)}。`)
  }
}

export class BrowserScreenshotStore {
  readonly #resources = new Map<string, BrowserScreenshotResource>()
  readonly #maxCacheBytes: number
  readonly #maxCacheAgeMs: number
  readonly #maxResourceAgeMs: number
  readonly #now: () => number

  constructor(readonly rootPath: string, options: BrowserScreenshotStoreOptions = {}) {
    if (!isAbsolute(rootPath)) throw new Error('浏览器截图缓存路径必须是绝对路径。')
    this.rootPath = resolve(rootPath)
    this.#maxCacheBytes = options.maxCacheBytes ?? DEFAULT_BROWSER_SCREENSHOT_CACHE_BYTES
    this.#maxCacheAgeMs = options.maxCacheAgeMs ?? DEFAULT_BROWSER_SCREENSHOT_CACHE_AGE_MS
    this.#maxResourceAgeMs = options.maxResourceAgeMs ?? DEFAULT_BROWSER_SCREENSHOT_RESOURCE_AGE_MS
    this.#now = options.now ?? Date.now
  }

  async initialize(): Promise<void> {
    await this.#ensureRoot()
    await this.prune()
  }

  async save(data: Buffer, metadata: BrowserScreenshotMetadata): Promise<BrowserScreenshotResult> {
    assertPng(data)
    assertDimensions(metadata.width, metadata.height)
    const timestamp = this.#now()
    const id = randomBytes(32).toString('base64url')
    const path = join(this.rootPath, `browser-${timestamp.toString(36)}-${randomBytes(8).toString('hex')}.png`)
    if (!pathIsInside(this.rootPath, path)) throw new Error('浏览器截图路径越界。')
    await this.#ensureRoot()
    await writeFile(path, data, { flag: 'wx', mode: 0o600 })
    const resource: BrowserScreenshotResource = {
      ...metadata,
      id,
      path,
      mimeType: BROWSER_SCREENSHOT_MIME_TYPE,
      bytes: data.byteLength,
      data,
      expiresAt: timestamp + this.#maxResourceAgeMs,
    }
    this.#resources.set(id, resource)
    this.#pruneResources(timestamp)
    await this.prune(timestamp)
    return {
      ...metadata,
      resourceId: id,
      path,
      mimeType: BROWSER_SCREENSHOT_MIME_TYPE,
      bytes: data.byteLength,
    }
  }

  get(resourceId: string): BrowserScreenshotResource | undefined {
    if (!RESOURCE_ID_PATTERN.test(resourceId)) return undefined
    const resource = this.#resources.get(resourceId)
    if (resource === undefined) return undefined
    if (resource.expiresAt <= this.#now() || !pathIsInside(this.rootPath, resource.path)) {
      this.#resources.delete(resourceId)
      return undefined
    }
    return resource
  }

  async clear(): Promise<BrowserScreenshotCacheStats> {
    this.#resources.clear()
    await this.#ensureRoot()
    for (const entry of await readdir(this.rootPath, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const path = join(this.rootPath, entry.name)
      if (pathIsInside(this.rootPath, path)) await unlink(path).catch(() => undefined)
    }
    return await this.stats()
  }

  async stats(): Promise<BrowserScreenshotCacheStats> {
    await this.#ensureRoot()
    let files = 0
    let bytes = 0
    for (const entry of await readdir(this.rootPath, { withFileTypes: true })) {
      if (!entry.isFile() || !SCREENSHOT_FILE_PATTERN.test(entry.name)) continue
      const info = await stat(join(this.rootPath, entry.name)).catch(() => undefined)
      if (info === undefined || !info.isFile()) continue
      files += 1
      bytes += info.size
    }
    return { path: this.rootPath, files, bytes }
  }

  async prune(now = this.#now()): Promise<void> {
    await this.#ensureRoot()
    const entries: ScreenshotCacheEntry[] = []
    for (const entry of await readdir(this.rootPath, { withFileTypes: true })) {
      if (!SCREENSHOT_FILE_PATTERN.test(entry.name)) continue
      const path = join(this.rootPath, entry.name)
      const info = await lstat(path).catch(() => undefined)
      if (info === undefined) continue
      if (info.isSymbolicLink()) {
        await unlink(path).catch(() => undefined)
        continue
      }
      if (info.isFile()) entries.push({ name: entry.name, bytes: info.size, modifiedAt: info.mtimeMs })
    }
    const removals = new Set(selectScreenshotCacheRemovals(entries, now, this.#maxCacheAgeMs, this.#maxCacheBytes))
    for (const name of removals) await unlink(join(this.rootPath, name)).catch(() => undefined)
    for (const [id, resource] of this.#resources) {
      if (removals.has(resource.path.split(/[\\/]/u).at(-1) ?? '')) this.#resources.delete(id)
    }
    this.#pruneResources(now)
  }

  #pruneResources(now: number): void {
    let total = 0
    for (const [id, resource] of this.#resources) {
      if (resource.expiresAt <= now) this.#resources.delete(id)
      else total += resource.bytes
    }
    for (const [id, resource] of this.#resources) {
      if (total <= MAX_REGISTERED_SCREENSHOT_BYTES) break
      this.#resources.delete(id)
      total -= resource.bytes
    }
  }

  async #ensureRoot(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true })
    const info = await lstat(this.rootPath)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('浏览器截图缓存目录不安全。')
  }
}
