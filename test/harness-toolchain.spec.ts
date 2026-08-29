import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HarnessToolchainManager,
  prependToolchainToPath,
  runtimeNodeModulesRoot,
} from '../src/main/harness-toolchain.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })))
})

describe('HarnessToolchainManager', () => {
  it('derives the node_modules root from a Harness entry', () => {
    const nodeModules = resolve('runtime', 'node_modules')
    const entryPath = join(nodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    expect(runtimeNodeModulesRoot(entryPath)).toBe(nodeModules)
  })

  it('publishes dsh, pnpm, and node shims tied to the selected runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-toolchain-'))
    temporaryRoots.push(root)
    const entryPath = join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const pnpmEntry = join(root, 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    await Promise.all([
      mkdir(join(entryPath, '..'), { recursive: true }),
      mkdir(join(pnpmEntry, '..'), { recursive: true }),
    ])
    await Promise.all([writeFile(entryPath, ''), writeFile(pnpmEntry, '')])

    const manager = new HarnessToolchainManager(join(root, 'user-data'), 'C:\\Desktop\\electron.exe', 'win32')
    const toolchain = await manager.prepare({
      version: '1.2.3',
      entryPath,
      source: 'managed',
      pending: false,
    })

    const [dsh, pnpm, node] = await Promise.all([
      readFile(toolchain.dshCommand, 'utf8'),
      readFile(toolchain.pnpmCommand, 'utf8'),
      readFile(toolchain.nodeCommand, 'utf8'),
    ])
    expect(toolchain.pnpmEntry).toBe(pnpmEntry)
    expect(dsh).toContain(entryPath)
    expect(dsh).toContain('harness-bootstrap.cjs')
    expect(pnpm).toContain(pnpmEntry)
    expect(pnpm).toContain('--config.minimum-release-age=0')
    expect(node).toContain('electron.exe')
    expect(dsh).toContain('ELECTRON_RUN_AS_NODE=1')
  })

  it('publishes executable POSIX shims for macOS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-toolchain-mac-'))
    temporaryRoots.push(root)
    const entryPath = join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const pnpmEntry = join(root, 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    await Promise.all([
      mkdir(join(entryPath, '..'), { recursive: true }),
      mkdir(join(pnpmEntry, '..'), { recursive: true }),
    ])
    await Promise.all([writeFile(entryPath, ''), writeFile(pnpmEntry, '')])

    const manager = new HarnessToolchainManager(
      join(root, 'user-data'),
      "/Applications/DFY DSH Desktop.app/Contents/MacOS/DFY DSH Desktop",
      'darwin',
    )
    const toolchain = await manager.prepare({
      version: '1.2.3',
      entryPath,
      source: 'managed',
      pending: false,
    })

    expect(toolchain.dshCommand.endsWith('.cmd')).toBe(false)
    const [dsh, pnpm, node] = await Promise.all([
      readFile(toolchain.dshCommand, 'utf8'),
      readFile(toolchain.pnpmCommand, 'utf8'),
      readFile(toolchain.nodeCommand, 'utf8'),
    ])
    expect(dsh).toMatch(/^#!\/bin\/bash/u)
    expect(dsh).toContain("'/Applications/DFY DSH Desktop.app/Contents/MacOS/DFY DSH Desktop'")
    expect(dsh).toContain('"$@"')
    expect(dsh).toContain('codesign_util.cc:')
    expect(dsh).toContain('task_name_for_pid: (os/kern) failure (5)')
    expect(dsh).toContain('status=${PIPESTATUS[0]}')
    expect(pnpm).toContain(pnpmEntry)
    expect(pnpm).toContain('--config.minimum-release-age=0')
    expect(node).toContain('ELECTRON_RUN_AS_NODE=1')
  })

  const posixTest = process.platform === 'win32' ? it.skip : it
  posixTest('filters only the sandboxed-parent codesign diagnostic on macOS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-toolchain-filter-'))
    temporaryRoots.push(root)
    const entryPath = join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const pnpmEntry = join(root, 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    const fakeElectron = join(root, 'Fake Electron')
    await Promise.all([
      mkdir(join(entryPath, '..'), { recursive: true }),
      mkdir(join(pnpmEntry, '..'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(entryPath, ''),
      writeFile(pnpmEntry, ''),
      writeFile(fakeElectron, [
        '#!/bin/sh',
        "printf '[test:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)\\n' >&2",
        "printf 'real error\\n' >&2",
        "printf 'command output\\n'",
        'exit 7',
        '',
      ].join('\n')),
    ])
    await chmod(fakeElectron, 0o755)

    const manager = new HarnessToolchainManager(join(root, 'user-data'), fakeElectron, 'darwin')
    const toolchain = await manager.prepare({
      version: '1.2.3',
      entryPath,
      source: 'managed',
      pending: false,
    })
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(toolchain.dshCommand, [], (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === 'number' ? error.code : 0,
          stdout,
          stderr,
        })
      })
    })

    expect(result).toEqual({
      code: 7,
      stdout: 'command output\n',
      stderr: 'real error\n',
    })
  })

  it('prepends the private bin without keeping duplicate Path keys', () => {
    const environment = prependToolchainToPath({ Path: 'C:\\Windows', PATH: 'duplicate' }, 'C:\\private-bin', ';')
    expect(environment.Path).toBe('C:\\private-bin;C:\\Windows')
    expect(environment.PATH).toBeUndefined()
  })

  it('uses the POSIX path delimiter on macOS', () => {
    const environment = prependToolchainToPath({ PATH: '/usr/bin' }, '/private/bin', ':')
    expect(environment.PATH).toBe('/private/bin:/usr/bin')
  })
})
