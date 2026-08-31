import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const RENDERER_HOST = '127.0.0.1'

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
})

/**
 * Serves the packaged desktop shell from loopback HTTP. DSH 0.1.2 protects its
 * browser session with a SameSite=Strict cookie, so a file:// parent cannot
 * embed the authenticated Harness page. A loopback parent remains same-site
 * across ports without weakening Harness authentication.
 */
export class DesktopRendererHost {
  private server: Server | undefined
  private entryUrl: string | undefined
  private readonly rootPath: string

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath)
  }

  async start(): Promise<string> {
    if (this.entryUrl !== undefined) return this.entryUrl
    const entryPath = resolve(this.rootPath, 'index.html')
    if (!(await stat(entryPath)).isFile()) throw new Error('Desktop renderer entry is unavailable')

    const server = createServer((request, response) => {
      void this.handleRequest(request.method, request.url, response).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
    this.server = server
    await new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolveStart()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, RENDERER_HOST)
    })

    const address = server.address()
    if (address === null || typeof address === 'string') {
      await this.stop()
      throw new Error('Desktop renderer did not bind a TCP port')
    }
    this.entryUrl = `http://${RENDERER_HOST}:${address.port}/index.html`
    return this.entryUrl
  }

  async stop(): Promise<void> {
    this.entryUrl = undefined
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>((resolveStop) => server.close(() => resolveStop()))
  }

  private async handleRequest(
    method: string | undefined,
    requestUrl: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }

    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(requestUrl ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      response.writeHead(400).end()
      return
    }
    const relativePath = pathname === '/' ? 'index.html' : `.${pathname}`
    const filePath = resolve(this.rootPath, relativePath)
    if (filePath !== this.rootPath && !filePath.startsWith(`${this.rootPath}${sep}`)) {
      response.writeHead(404).end()
      return
    }

    let fileSize: number
    try {
      const file = await stat(filePath)
      if (!file.isFile()) throw new Error('Not a file')
      fileSize = file.size
    } catch {
      response.writeHead(404).end()
      return
    }

    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': String(fileSize),
      'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    })
    if (method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(filePath)
      .once('error', () => response.destroy())
      .pipe(response)
  }
}
