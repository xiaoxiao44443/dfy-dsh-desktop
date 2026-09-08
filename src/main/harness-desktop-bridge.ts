import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { DesktopNotificationService } from './desktop-notifications.js'
import type { DesktopBrowserService } from './desktop-browser.js'

const CONTROL_HOST = '127.0.0.1'
const MAX_REQUEST_BYTES = 8 * 1_024 * 1_024
const DEFAULT_RESTART_DELAY_MS = 1_500

export interface HarnessDesktopBridgeLaunch {
  patchPath: string
  controlUrl: string
  controlToken: string
  profilePath: string
  pluginRootPath: string
  browserPluginRootPath: string
}

export interface HarnessDesktopBridgeOptions {
  userDataPath: string
  pluginName: string
  pluginRootPath: string
  browserPluginName: string
  browserPluginRootPath: string
  profilePath: string
  notifications: DesktopNotificationService
  browser: DesktopBrowserService
  openPath(path: string): Promise<string>
  revealPath(path: string): void
  restartHarness(reason: string): Promise<void>
  restartDelayMs?: number
}

/**
 * Owns the authenticated loopback seam used by the in-process DSH Host plugin.
 * The plugin can request a restart, but only the Electron parent owns the child
 * process and can perform it safely.
 */
export class HarnessDesktopBridgeHost {
  private server: Server | undefined
  private launch: HarnessDesktopBridgeLaunch | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private restartPending = false
  constructor(private readonly options: HarnessDesktopBridgeOptions) {}

  async start(): Promise<HarnessDesktopBridgeLaunch> {
    if (this.launch !== undefined) return { ...this.launch }
    if (!isAbsolute(this.options.pluginRootPath)) throw new Error('Desktop bridge plugin root path must be absolute')
    if (!isAbsolute(this.options.browserPluginRootPath)) throw new Error('Desktop browser plugin root path must be absolute')
    if (this.options.pluginName.trim().length === 0 || /[\r\n\0]/u.test(this.options.pluginName)) {
      throw new Error('Desktop bridge plugin name is invalid')
    }
    if (this.options.browserPluginName.trim().length === 0 || /[\r\n\0]/u.test(this.options.browserPluginName)) {
      throw new Error('Desktop browser plugin name is invalid')
    }

    const patchPath = join(this.options.userDataPath, 'desktop-bridge.patch.json')
    await mkdir(this.options.userDataPath, { recursive: true })
    await writeFile(patchPath, `${JSON.stringify([
      {
        insert: [
          { id: 'desktop-bridge', name: this.options.pluginName },
          { id: 'desktop-browser', name: this.options.browserPluginName },
        ],
      },
    ], null, 2)}\n`, 'utf8')

    const controlToken = randomBytes(32).toString('hex')
    const server = createServer((request, response) => {
      void this.handleRequest(request, response, controlToken).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        this.sendJson(response, 500, {
          accepted: false,
          message: error instanceof Error ? error.message : String(error),
        })
      })
    })
    this.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, CONTROL_HOST)
    })

    const address = server.address()
    if (address === null || typeof address === 'string') {
      await this.stop()
      throw new Error('Desktop bridge did not bind a TCP port')
    }
    this.launch = {
      patchPath,
      controlUrl: `http://${CONTROL_HOST}:${address.port}/v1/restart-harness`,
      controlToken,
      profilePath: this.options.profilePath,
      pluginRootPath: this.options.pluginRootPath,
      browserPluginRootPath: this.options.browserPluginRootPath,
    }
    return { ...this.launch }
  }

  async stop(): Promise<void> {
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.restartPending = false
    this.launch = undefined
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    controlToken: string,
  ): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const screenshotResource = /^\/v1\/browser\/screenshot-resources\/([A-Za-z0-9_-]{43})$/u.exec(pathname)
    const supported = pathname === '/v1/restart-harness'
      || pathname === '/v1/notifications/settings'
      || pathname === '/v1/notifications/show'
      || pathname === '/v1/shell/open'
      || pathname === '/v1/shell/reveal'
      || pathname === '/v1/browser/settings'
      || pathname === '/v1/browser/history'
      || pathname === '/v1/browser/clear-data'
      || pathname === '/v1/browser/screenshots'
      || pathname === '/v1/browser/screenshots/reveal'
      || pathname === '/v1/browser/agent-status'
      || pathname === '/v1/browser/action'
      || screenshotResource !== null
    if (!supported) {
      this.sendJson(response, 404, { accepted: false, message: 'Not found' })
      return
    }

    if (screenshotResource !== null) {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET')
        this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
        return
      }
      const resource = this.options.browser.getScreenshotResource(screenshotResource[1]!)
      if (resource === undefined) {
        this.sendJson(response, 404, { accepted: false, message: 'Screenshot resource is unavailable or expired' })
        return
      }
      response.statusCode = 200
      response.setHeader('content-type', resource.mimeType)
      response.setHeader('content-length', String(resource.bytes))
      response.setHeader('cache-control', 'no-store')
      response.setHeader('x-content-type-options', 'nosniff')
      response.end(resource.data)
      return
    }
    if (request.headers.authorization !== `Bearer ${controlToken}`) {
      this.sendJson(response, 401, { accepted: false, message: 'Unauthorized' })
      return
    }

    if (pathname === '/v1/notifications/settings') {
      if (request.method === 'GET') {
        this.sendJson(response, 200, { settings: this.options.notifications.currentSettings })
        return
      }
      if (request.method === 'PUT') {
        const settings = await this.options.notifications.updateSettings(await this.readJsonBody(request))
        this.sendJson(response, 200, { settings })
        return
      }
      response.setHeader('allow', 'GET, PUT')
      this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
      return
    }

    if (pathname === '/v1/notifications/show') {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
        return
      }
      const shown = await this.options.notifications.show(await this.readJsonBody(request))
      this.sendJson(response, 200, { shown })
      return
    }

    if (pathname === '/v1/shell/open' || pathname === '/v1/shell/reveal') {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
        return
      }
      const body = await this.readJsonBody(request)
      const path = typeof body.path === 'string' ? body.path.trim() : ''
      if (path.length === 0 || path.length > 4_096 || /[\r\n\0]/u.test(path) || !isAbsolute(path)) {
        this.sendJson(response, 400, { accepted: false, message: 'Path must be an absolute filesystem path' })
        return
      }
      if (pathname === '/v1/shell/open') {
        const message = await this.options.openPath(path)
        if (message.length > 0) {
          this.sendJson(response, 500, { opened: false, message })
          return
        }
        this.sendJson(response, 200, { opened: true })
        return
      }
      this.options.revealPath(path)
      this.sendJson(response, 200, { revealed: true })
      return
    }

    if (pathname === '/v1/browser/settings') {
      if (request.method === 'GET') {
        this.sendJson(response, 200, { settings: this.options.browser.state.settings })
        return
      }
      if (request.method === 'PUT') {
        const settings = await this.options.browser.updateSettings(await this.readJsonBody(request))
        this.sendJson(response, 200, { settings })
        return
      }
      response.setHeader('allow', 'GET, PUT')
      this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
      return
    }

    if (pathname === '/v1/browser/history') {
      if (request.method === 'GET') {
        this.sendJson(response, 200, { entries: this.options.browser.getHistory() })
        return
      }
      if (request.method === 'DELETE') {
        await this.options.browser.clearHistory()
        this.sendJson(response, 200, { cleared: true })
        return
      }
      response.setHeader('allow', 'GET, DELETE')
      this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
      return
    }

    if (pathname === '/v1/browser/clear-data') {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
        return
      }
      await this.options.browser.clearBrowsingData()
      this.sendJson(response, 200, { cleared: true })
      return
    }

    if (pathname === '/v1/browser/screenshots') {
      if (request.method === 'GET') {
        this.sendJson(response, 200, { cache: await this.options.browser.screenshotCacheStats() })
        return
      }
      if (request.method === 'DELETE') {
        this.sendJson(response, 200, { cleared: true, cache: await this.options.browser.clearScreenshotCache() })
        return
      }
      response.setHeader('allow', 'GET, DELETE')
      this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
      return
    }

    if (pathname === '/v1/browser/screenshots/reveal') {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
        return
      }
      await this.options.browser.revealScreenshotCache()
      this.sendJson(response, 200, { revealed: true })
      return
    }

    if (pathname === '/v1/browser/action') {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
        return
      }
      const result = await this.options.browser.handleAgentRequest(await this.readJsonBody(request))
      this.sendJson(response, 200, result)
      return
    }

    if (pathname === '/v1/browser/agent-status') {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
        return
      }
      this.options.browser.updateAgentStatus(await this.readJsonBody(request))
      this.sendJson(response, 200, { accepted: true })
      return
    }

    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      this.sendJson(response, 405, { accepted: false, message: 'Method not allowed' })
      return
    }

    const body = await this.readJsonBody(request)
    const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim().slice(0, 500)
      : '加载已变更的 Harness 插件配置'

    if (this.restartPending) {
      this.sendJson(response, 202, { accepted: true, message: 'Harness restart is already scheduled' })
      return
    }

    this.restartPending = true
    this.sendJson(response, 202, { accepted: true, message: 'Harness restart scheduled' })
    const delay = this.options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.options.restartHarness(reason)
        .catch(() => undefined)
        .finally(() => {
          this.restartPending = false
        })
    }, delay)
    this.restartTimer.unref()
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = ''
    for await (const chunk of request) {
      raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) throw new Error('Request body is too large')
    }
    if (raw.trim().length === 0) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }

  private sendJson(response: ServerResponse, status: number, value: Record<string, unknown>): void {
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(`${JSON.stringify(value)}\n`)
  }
}
