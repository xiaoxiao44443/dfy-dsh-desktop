import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
// Opt in on a logged-in desktop: this starts native windows and a real tray.
describe.skipIf(process.env.DFY_TEST_NATIVE_TRAY !== '1' || !['darwin', 'win32'].includes(process.platform))('native Electron tray close lifecycle', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dfy-tray-electron-'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
    await execute(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2024', '--module', 'NodeNext',
      '--skipLibCheck', '--types', 'node', '--outDir', root, resolve('src/main/desktop-tray.ts')])
  }, 20_000)
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

  it.each(['close-to-quit', 'close-to-hide'])('%s completes the native lifecycle', async (mode) => {
    const profile = join(root, mode)
    await mkdir(profile)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const { stdout } = await execute(require('electron') as string, [
      resolve('test/fixtures/tray-close-electron.mjs'), join(root, 'desktop-tray.js'), profile, resolve('resources/tray'), mode,
    ], { env, timeout: 18_000 }).catch((error) => {
      throw new Error(`Electron lifecycle failed (${error.code}): ${error.stdout}\n${error.stderr}`)
    })
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as { events: string[]; windows: number }
    expect(result.events).not.toContain('reentrant-before-quit')
    expect(result.events).not.toContain('timeout')
    expect(result.events.filter(event => event === 'before-quit')).toHaveLength(1)
    expect(result.events).toContain('closed')
    expect(result.windows).toBe(0)
    if (mode === 'close-to-hide') expect(result.events).toEqual(expect.arrayContaining(['hidden', 'restored']))
  }, 20_000)
})
