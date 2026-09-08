import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessProcess } from '../src/main/harness-process.js'
import { DesktopPluginLinkError } from '../src/main/harness-plugin-links.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const roots: string[] = []
const harnesses: HarnessProcess[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(spawn).mockReset()
})

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: string | null = null
  kill(signal: string) {
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-process-links-'))
  roots.push(root)
  const profilePath = join(root, '.dsh', 'profiles', 'web')
  const pluginRootPath = join(root, 'resources', 'dsh-desktop-bridge')
  const browserPluginRootPath = join(root, 'resources', 'dsh-desktop-browser')
  for (const [name, target] of [['dsh-desktop-bridge', pluginRootPath], ['dsh-desktop-browser', browserPluginRootPath]]) {
    await mkdir(join(target!, 'lib'), { recursive: true })
    await writeFile(join(target!, 'package.json'), JSON.stringify({ name, version: '0.1.0' }))
    await writeFile(join(target!, 'lib', 'index.js'), '')
    await writeFile(join(target!, 'lib', 'client.js'), '')
  }
  const candidate = { entryPath: join(root, 'runtime', 'bin.js'), version: '0.1.2-rc.1', source: 'bundled' as const, pending: false }
  const harness = new HarnessProcess(process.execPath, root, 'http://localhost/picker', {
    prepare: async () => ({ binPath: join(root, 'bin'), pnpmEntry: join(root, 'pnpm.cjs'), dshCommand: 'dsh', pnpmCommand: 'pnpm' }),
  } as never, {
    profilePath, pluginRootPath, browserPluginRootPath,
    patchPath: join(root, 'desktop.patch.json'), controlUrl: 'http://localhost/control', controlToken: 'test-token',
  }, join(root, 'recovery.patch.json'))
  harnesses.push(harness)
  vi.mocked(spawn).mockImplementation(() => {
    const child = new FakeChild()
    queueMicrotask(() => child.stdout.write('dsh web: http://127.0.0.1:32100/\n'))
    return child as never
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })))
  return {
    harness, candidate, profilePath, pluginRootPath,
    link: join(profilePath, 'node_modules', 'dsh-desktop-bridge'),
  }
}

describe('desktop links across the Harness lifecycle', () => {
  it('repairs links before launch, after Profile bootstrap, and when switching runtime', async () => {
    const f = await fixture()
    vi.stubGlobal('fetch', vi.fn(async () => {
      // Model the first-start dependency install pruning a pre-existing link.
      expect(await realpath(f.link)).toBe(await realpath(f.pluginRootPath))
      await unlink(f.link)
      return { status: 200 }
    }))
    await f.harness.start(f.candidate)
    expect(await realpath(f.link)).toBe(await realpath(f.pluginRootPath))
    await unlink(f.link)
    await f.harness.start({ ...f.candidate, source: 'managed', version: '0.1.2-alpha.3' })
    expect(await realpath(f.link)).toBe(await realpath(f.pluginRootPath))
  })

  it.each(['plugin', 'pnpm'])('repairs links even after a failing %s command', async (command) => {
    const f = await fixture()
    await f.harness.start(f.candidate)
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new FakeChild()
      void unlink(f.link).then(() => {
        child.exitCode = 1
        child.stderr.write('fixture install failed')
        child.emit('exit', 1, null)
      })
      return child as never
    })
    const result = command === 'plugin'
      ? await f.harness.runPlugin('web', ['add', 'fixture'])
      : await f.harness.runPnpm('web', ['add', 'fixture'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('fixture install failed')
    expect(await realpath(f.link)).toBe(await realpath(f.pluginRootPath))
  })

  it('reports link conflicts as a desktop error before spawning a runtime', async () => {
    const f = await fixture()
    await mkdir(f.link, { recursive: true })
    await expect(f.harness.start(f.candidate)).rejects.toBeInstanceOf(DesktopPluginLinkError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('preserves the error type and stops the child if bootstrap creates a conflicting directory', async () => {
    const f = await fixture()
    const exits: Array<{ expected: boolean }> = []
    f.harness.on('exit', (event) => exits.push(event))
    vi.stubGlobal('fetch', vi.fn(async () => {
      await unlink(f.link)
      await mkdir(f.link)
      return { status: 200 }
    }))
    await expect(f.harness.start(f.candidate)).rejects.toBeInstanceOf(DesktopPluginLinkError)
    expect(exits).toEqual([{ code: null, signal: 'SIGTERM', expected: true }])
  })
})
