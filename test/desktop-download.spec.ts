import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopInstallerDownloader, desktopDownloadSources, fetchDesktopChecksums } from '../src/main/desktop-download.js'

const url = 'https://github.com/xiaoxiao44443/dfy-dsh-desktop/releases/download/v0.2.0-rc.2/app.dmg'
const payload = Buffer.from('verified desktop installer')
const checksum = createHash('sha256').update(payload).digest('hex')
const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function request() {
  const root = await mkdtemp(join(tmpdir(), 'dfy-download-test-'))
  roots.push(root)
  return { url, size: payload.length, checksum, partialPath: join(root, 'installer.part'),
    onProgress: vi.fn(), onTesting: vi.fn(), onFallback: vi.fn() }
}

function sample(body = payload): Response {
  return new Response(body, { status: 206, headers: {
    'content-range': `bytes 0-${payload.length - 1}/${payload.length}`, 'content-type': 'application/octet-stream',
  } })
}

function isProbe(init?: RequestInit): boolean { return new Headers(init?.headers).has('range') }

describe('desktop download routes', () => {
  it('includes all four routes only for public assets from our repository', () => {
    expect(desktopDownloadSources(url).map(source => source.name)).toEqual(['GitHub 直连', 'gh-proxy.com', 'ghproxy.net', 'ghfast.top'])
    for (const other of ['http://127.0.0.1:1234/app.dmg', 'https://downloads.example/app.dmg',
      'https://github.com/private/repository/releases/download/v1/app.dmg', `${url}?token=private`,
      url.replace('github.com', 'user:secret@github.com'), url.replace('github.com', 'github.com.evil.example')]) {
      expect(desktopDownloadSources(other)).toEqual([{ name: '原始下载源', url: other }])
    }
  })

  it('ranks actual body transfer including latency, caches results, and downloads only the winner', async () => {
    const input = await request()
    const full: string[] = []
    const fetcher = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const address = String(value)
      if (isProbe(init)) {
        const delay = address.startsWith('https://ghproxy.net/') ? 5 : 70
        return new Response(new ReadableStream({
          start(controller) { setTimeout(() => { controller.enqueue(payload); controller.close() }, delay) },
        }), { status: 206, headers: { 'content-range': `bytes 0-${payload.length - 1}/${payload.length}` } })
      }
      full.push(address)
      return new Response(payload)
    })
    const downloader = new DesktopInstallerDownloader(fetcher)
    await downloader.download(input)
    expect(full).toEqual([`https://ghproxy.net/${url}`])
    expect(await readFile(input.partialPath)).toEqual(payload)
    expect(fetcher).toHaveBeenCalledTimes(5)
    await downloader.rankedSources(url, payload.length, input.onTesting)
    expect(input.onTesting).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(input.onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'ghproxy.net', verifying: true }))
  })

  it('rejects HTML, wrong Content-Range and truncated samples', async () => {
    const fetcher = vi.fn(async (value: string | URL | Request) => {
      const address = String(value)
      if (address.startsWith('https://gh-proxy.com/')) return new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } })
      if (address.startsWith('https://ghproxy.net/')) return new Response(payload, { status: 206, headers: { 'content-range': 'bytes 5-10/123' } })
      if (address.startsWith('https://ghfast.top/')) return sample(payload.subarray(0, 5))
      return sample()
    })
    const ranked = await new DesktopInstallerDownloader(fetcher).rankedSources(url, payload.length, vi.fn())
    expect(ranked.map(source => source.name)).toEqual(['GitHub 直连'])
  })

  it('bounds samples and cancels every body even when a server ignores Range', async () => {
    const cancelled = vi.fn()
    const signals: AbortSignal[] = []
    const fetcher = vi.fn(async (_value: string | URL | Request, init?: RequestInit) => {
      signals.push(init!.signal!)
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-524287')
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(512 * 1024)) }, cancel: cancelled,
      }))
    })
    const ranked = await new DesktopInstallerDownloader(fetcher).rankedSources(url, 4 * 1024 * 1024, vi.fn())
    expect(ranked).toHaveLength(4)
    expect(cancelled).toHaveBeenCalledTimes(4)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })

  it('times out stalled probes without hanging or starting a full download', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(() => new Promise<Response>(() => {}))
    const result = new DesktopInstallerDownloader(fetcher).rankedSources(url, payload.length, vi.fn())
    const assertion = expect(result).rejects.toThrow('所有下载线路测速失败')
    await vi.advanceTimersByTimeAsync(8_001)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(4)
    for (const [, init] of fetcher.mock.calls as unknown as Array<[unknown, RequestInit]>) expect(init.signal?.aborted).toBe(true)
  })

  it('restarts from byte zero on a verified fallback after hash failure', async () => {
    const input = await request()
    const full: string[] = []
    const fetcher = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      if (isProbe(init)) return sample()
      full.push(String(value))
      return new Response(full.length === 1 ? Buffer.alloc(payload.length, 120) : payload)
    })
    const downloader = new DesktopInstallerDownloader(fetcher)
    await downloader.download(input)
    expect(full).toHaveLength(2)
    expect(input.onFallback).toHaveBeenCalledTimes(1)
    expect(await readFile(input.partialPath)).toEqual(payload)
    await downloader.rankedSources(url, payload.length, input.onTesting)
    expect(input.onTesting).toHaveBeenCalledTimes(2)
  })

  it('switches away from a stalled download and cancels its stream', async () => {
    const input = await request()
    let full = 0
    const cancelled = vi.fn()
    const fetcher = vi.fn(async (_value: string | URL | Request, init?: RequestInit) => {
      if (isProbe(init)) return sample()
      full++
      return full === 1 ? new Response(new ReadableStream({ cancel: cancelled })) : new Response(payload)
    })
    const downloader = new DesktopInstallerDownloader(fetcher)
    await downloader.rankedSources(url, payload.length, input.onTesting)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const download = downloader.download(input)
    await vi.waitFor(() => expect(full).toBe(1))
    await vi.advanceTimersByTimeAsync(15_001)
    await download
    expect(full).toBe(2)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(input.onFallback).toHaveBeenCalledOnce()
    expect(await readFile(input.partialPath)).toEqual(payload)
  })

  it('rejects corrupt files on every route and removes partial downloads', async () => {
    const input = await request()
    const fetcher = vi.fn(async (_value: string | URL | Request, init?: RequestInit) => isProbe(init)
      ? sample() : new Response(Buffer.alloc(payload.length, 120)))
    await expect(new DesktopInstallerDownloader(fetcher).download(input)).rejects.toThrow('SHA-256 校验失败')
    expect(await readdir(roots.at(-1)!)).toEqual([])
    expect(input.onFallback).toHaveBeenCalledTimes(3)
  })

  it('does not try other routes on a local file error', async () => {
    const input = await request()
    input.partialPath = join(input.partialPath, 'missing-parent', 'installer.part')
    const fetcher = vi.fn(async (_value: string | URL | Request, init?: RequestInit) => isProbe(init) ? sample() : new Response(payload))
    await expect(new DesktopInstallerDownloader(fetcher).download(input)).rejects.toThrow('ENOENT')
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(input.onFallback).not.toHaveBeenCalled()
  })

  it('bounds legacy checksum responses', async () => {
    const cancel = vi.fn()
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel,
    })))
    await expect(fetchDesktopChecksums(fetcher, 'https://github.com/SHA256SUMS.txt')).rejects.toThrow('校验文件过大')
    expect(cancel).toHaveBeenCalledOnce()
  })
})
