import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopUpdateService } from '../src/main/desktop-update.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function updateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dfy-desktop-update-'))
  roots.push(root)
  return root
}

function releasePayload(version: string, installer: Buffer, prerelease = true): unknown[] {
  const installerName = `DFY-DSH-Desktop-${version}-macos-x64.dmg`
  return [{
    tag_name: `v${version}`,
    html_url: `https://github.com/xiaoxiao44443/dfy-dsh-desktop/releases/tag/v${version}`,
    published_at: '2026-08-31T00:00:00Z',
    draft: false,
    prerelease,
    assets: [
      {
        name: installerName,
        browser_download_url: `https://downloads.example/${installerName}`,
        size: installer.byteLength,
      },
      {
        name: 'SHA256SUMS.txt',
        browser_download_url: 'https://downloads.example/SHA256SUMS.txt',
        size: 100,
      },
    ],
  }]
}

describe('DesktopUpdateService', () => {
  it('checks GitHub metadata without downloading an installer', async () => {
    const installer = Buffer.from('desktop installer')
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('api.github.com/repos/xiaoxiao44443/dfy-dsh-desktop/releases')
      return new Response(JSON.stringify(releasePayload('0.1.2-alpha.3', installer)), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const service = new DesktopUpdateService({
      updatesRoot: await updateRoot(),
      currentVersion: '0.1.2-alpha.2',
      platform: 'darwin',
      arch: 'x64',
      fetcher: fetcher as typeof fetch,
    })
    await service.initialize()
    await service.checkForUpdates()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(service.state).toMatchObject({
      status: 'available',
      version: '0.1.2-alpha.3',
    })
  })

  it('downloads into the desktop data directory, verifies SHA-256, and cleans it after upgrade', async () => {
    const root = await updateRoot()
    const version = '0.1.2-alpha.3'
    const installerName = `DFY-DSH-Desktop-${version}-macos-x64.dmg`
    const installer = Buffer.from('verified desktop installer')
    const checksum = createHash('sha256').update(installer).digest('hex')
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify(releasePayload(version, installer)), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('SHA256SUMS.txt')) return new Response(`${checksum}  ${installerName}\n`)
      if (url.endsWith('.dmg')) return new Response(installer)
      return new Response('not found', { status: 404 })
    })
    const service = new DesktopUpdateService({
      updatesRoot: root,
      currentVersion: '0.1.2-alpha.2',
      platform: 'darwin',
      arch: 'x64',
      fetcher: fetcher as typeof fetch,
    })
    await service.initialize()
    await service.checkForUpdates()
    await service.downloadUpdate()

    expect(service.state).toMatchObject({ status: 'ready', version, progress: 100 })
    expect(await readFile(join(root, version, installerName))).toEqual(installer)
    expect(JSON.parse(await readFile(join(root, 'pending.json'), 'utf8'))).toMatchObject({ version, assetName: installerName })

    const upgraded = new DesktopUpdateService({
      updatesRoot: root,
      currentVersion: version,
      platform: 'darwin',
      arch: 'x64',
      fetcher: fetcher as typeof fetch,
    })
    await upgraded.initialize()
    expect(await readdir(root)).toEqual([])
  })

  it('does not offer prerelease builds to a stable desktop version', async () => {
    const installer = Buffer.from('alpha installer')
    const fetcher = vi.fn(async () => new Response(JSON.stringify(releasePayload('0.1.2-alpha.3', installer)), {
      headers: { 'content-type': 'application/json' },
    }))
    const service = new DesktopUpdateService({
      updatesRoot: await updateRoot(),
      currentVersion: '0.1.1',
      platform: 'darwin',
      arch: 'x64',
      fetcher: fetcher as typeof fetch,
    })
    await service.initialize()
    await service.checkForUpdates()
    expect(service.state.status).toBe('current')
  })
})
