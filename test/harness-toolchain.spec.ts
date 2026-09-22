import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
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

    const manager = new HarnessToolchainManager(join(root, 'user-data'), join(root, 'Desktop', 'electron.exe'), 'win32')
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
    const loader = await readFile(join(toolchain.binPath, 'dsh-cli.cjs'), 'utf8')
    expect(loader).toContain(JSON.stringify(entryPath))
    expect(loader).toContain('harness-bootstrap.cjs')
    expect(dsh).toContain('%~dp0dsh-cli.cjs')
    expect(pnpm).toContain('%~dp0pnpm-runtime\\pnpm.cjs')
    expect(await realpath(join(toolchain.binPath, 'pnpm-runtime'))).toBe(await realpath(join(pnpmEntry, '..')))
    for (const source of [dsh, pnpm, node]) {
      expect(source).toMatch(/^[\x00-\x7f]*$/u)
      expect(source).not.toContain('chcp')
    }
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

  const windowsTest = process.platform === 'win32' ? it : it.skip
  windowsTest('runs Unicode paths without changing code page 936, arguments, exit status or caller environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-toolchain-cjk-'))
    temporaryRoots.push(root)
    const executable = join(root, '中文 工具链', 'node.exe')
    const entryPath = join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const pnpmEntry = join(root, 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    await Promise.all([mkdir(join(executable, '..'), { recursive: true }), mkdir(join(entryPath, '..'), { recursive: true }), mkdir(join(pnpmEntry, '..'), { recursive: true })])
    await Promise.all([copyFile(process.execPath, executable), writeFile(entryPath, ''), writeFile(pnpmEntry, '')])
    const manager = new HarnessToolchainManager(join(root, '中文 用户'), executable, 'win32')
    const toolchain = await manager.prepare({ version: '1.2.3', entryPath, source: 'managed', pending: false })
    const probe = join(root, 'probe.cjs')
    await writeFile(probe, 'console.log(JSON.stringify({argv:process.argv.slice(2),nodeMode:process.env.ELECTRON_RUN_AS_NODE})); process.exitCode=7;')
    const caller = join(root, 'caller.cmd')
    await writeFile(caller, [
      '@echo off', 'chcp 936 >nul', 'set "ELECTRON_RUN_AS_NODE=caller-value"',
      'call "%DFY_TEST_NODE_COMMAND%" "%DFY_TEST_PROBE%" "two words"',
      'set "RESULT=%ERRORLEVEL%"', 'chcp', 'echo CALLER_NODE_MODE=%ELECTRON_RUN_AS_NODE%',
      'exit /b %RESULT%', '',
    ].join('\r\n'))
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult) => {
      execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', caller], {
        windowsHide: true, timeout: 10_000,
        env: { ...process.env, DFY_TEST_NODE_COMMAND: toolchain.nodeCommand, DFY_TEST_PROBE: probe },
      }, (error, stdout, stderr) => {
        resolveResult({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
      })
    })
    expect(result.code).toBe(7)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('{"argv":["two words"],"nodeMode":"1"}')
    expect(result.stdout).toMatch(/936\s*\r?\n/u)
    expect(result.stdout).toContain('CALLER_NODE_MODE=caller-value')

    // Pipe capture cannot detect ConPTY redraws erasing earlier output. Replay
    // a real console session and assert that both the old text and version stay.
    const runtimeRequire = createRequire(await realpath(resolve('node_modules/@deepseek-ai/dsh/package.json')))
    const terminalProbe = join(root, 'terminal-probe.cjs')
    await writeFile(terminalProbe, `
      const pty = require(${JSON.stringify(runtimeRequire.resolve('node-pty'))});
      const { Terminal } = require(${JSON.stringify(runtimeRequire.resolve('@xterm/headless'))});
      const shell = process.env.SystemRoot + '\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe';
      const child = pty.spawn(shell, ['-NoLogo', '-NoProfile', '-Command',
        "& $env:ComSpec /d /c 'chcp 936 >nul'; Write-Output 'BEFORE_VERSION'; & $env:DFY_TEST_NODE_COMMAND -v; Write-Output 'AFTER_VERSION'"],
        { cols: 120, rows: 30, env: process.env });
      let raw = '';
      const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 8000);
      child.onData(data => { raw += data; if (data.includes('\\x1b[6n')) child.write('\\x1b[1;1R'); });
      child.onExit(({ exitCode }) => {
        clearTimeout(deadline);
        const terminal = new Terminal({ cols: 120, rows: 30, allowProposedApi: true });
        terminal.write(raw, () => {
          const screen = Array.from({ length: terminal.buffer.active.length }, (_, i) => terminal.buffer.active.getLine(i)?.translateToString(true)).join('\\n');
          process.stdout.write(JSON.stringify({ exitCode, screen }), () => process.exit(0));
        });
      });
    `)
    const terminalOutput = await new Promise<string>((resolveOutput, reject) => {
      execFile(process.execPath, [terminalProbe], {
        windowsHide: true, timeout: 12_000,
        env: { ...process.env, DFY_TEST_NODE_COMMAND: toolchain.nodeCommand },
      }, (error, stdout) => error ? reject(error) : resolveOutput(stdout))
    })
    const terminal = JSON.parse(terminalOutput) as { exitCode: number, screen: string }
    expect(terminal.exitCode).toBe(0)
    expect(terminal.screen).toContain('BEFORE_VERSION')
    expect(terminal.screen).toContain(process.version)
    expect(terminal.screen).toContain('AFTER_VERSION')
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
