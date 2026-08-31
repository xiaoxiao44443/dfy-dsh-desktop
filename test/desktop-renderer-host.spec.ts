import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopRendererHost } from '../src/main/desktop-renderer-host.js'

const hosts: DesktopRendererHost[] = []
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (host) => await host.stop()))
  await Promise.all(temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

describe('DesktopRendererHost', () => {
  it('serves the desktop shell from loopback HTTP without exposing parent paths', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'dsh-desktop-renderer-'))
    temporaryPaths.push(rootPath)
    await writeFile(join(rootPath, 'index.html'), '<!doctype html><title>Desktop shell</title>', 'utf8')
    await writeFile(join(rootPath, 'main.js'), 'globalThis.desktopShell = true', 'utf8')

    const host = new DesktopRendererHost(rootPath)
    hosts.push(host)
    const entryUrl = await host.start()

    expect(new URL(entryUrl).hostname).toBe('127.0.0.1')
    const entry = await fetch(entryUrl)
    expect(entry.status).toBe(200)
    expect(entry.headers.get('content-type')).toBe('text/html; charset=utf-8')
    await expect(entry.text()).resolves.toContain('Desktop shell')

    const script = await fetch(new URL('/main.js', entryUrl))
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')

    const missing = await fetch(new URL('/missing.js', entryUrl))
    expect(missing.status).toBe(404)
    const traversal = await fetch(`${new URL(entryUrl).origin}/%2e%2e/package.json`)
    expect(traversal.status).toBe(404)
  })
})
