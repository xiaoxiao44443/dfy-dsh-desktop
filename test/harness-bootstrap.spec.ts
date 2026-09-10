import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
let root: string
let bootstrap: string
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-cli-entry-')))
  const compiler = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
  await execute(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2024', '--module', 'NodeNext',
    '--skipLibCheck', '--types', 'node', '--outDir', root, resolve('src/harness-bootstrap.cts')])
  bootstrap = join(root, 'harness-bootstrap.cjs')
  await mkdir(join(root, 'node_modules/koffi'), { recursive: true })
  await writeFile(join(root, 'node_modules/koffi/index.js'), `
    exports.load = () => ({ func: () => () => 1 });
  `)
}, 20_000)
afterAll(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }) })

describe('Harness CLI entry compatibility', () => {
  it.each(['legacy', 'explicit'])('runs the %s entry once with the original arguments', async (kind) => {
    const entry = join(root, `${kind}.mjs`)
    const body = `console.log(JSON.stringify({ args: process.argv.slice(2), nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null }))`
    await writeFile(entry, kind === 'legacy' ? body : `export async function runCli() { ${body} }\nif (import.meta.main) await runCli()`)
    const { stdout } = await execute(process.execPath, [bootstrap, entry, '--version'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(JSON.parse(stdout)).toEqual({ args: ['--version'], nodeMode: null })
  })

  it('propagates an explicit CLI startup failure', async () => {
    const entry = join(root, 'failure.mjs')
    await writeFile(entry, 'export async function runCli() { throw new Error("CLI startup failed") }')
    await expect(execute(process.execPath, [bootstrap, entry])).rejects.toMatchObject({ code: 1 })
  })
})

describe('Harness background worker launch compatibility', () => {
  async function captureLaunches(platform: string) {
    const capture = join(root, `capture-${platform}.cjs`)
    const entry = join(root, `launch-${platform}.mjs`)
    await writeFile(capture, `
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      globalThis.launches = [];
      const cp = require('node:child_process');
      for (const method of ['spawn', 'fork']) {
        cp[method] = (...args) => globalThis.launches.push({ method, args });
      }
    `)
    await writeFile(entry, `
      import { spawn, fork } from 'node:child_process';
      const ordinary = ['C:', 'DSH', 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'runner.js'].join(String.fromCharCode(92));
      const acl = '/runtime/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js';
      const picker = '/runtime/node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs';
      const agent = '/runtime/node_modules/node-pty/lib/conpty_console_list_agent';
      const options = { cwd: '/workspace', env: { MARKER: 'kept', ELECTRON_NO_ATTACH_CONSOLE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe', 'pipe', 'pipe'] };
      spawn(process.execPath, [ordinary, '--', 'cmd.exe', '/c', 'echo ok'], options);
      spawn(process.execPath, [acl, '--mode', 'workspace-write'], options);
      spawn(process.execPath, [picker], options);
      spawn('Code.exe', [ordinary], { env: { MARKER: 'external' }, windowsHide: false });
      fork(agent, ['123'], options);
      fork(agent + '.js', { ...options, execPath: 'node.exe' });
      fork('/other/worker.js', ['456'], { env: { MARKER: 'other' } });
      console.log(JSON.stringify(globalThis.launches.map(({ method, args }) => {
        const opts = Array.isArray(args[1]) ? args[2] : args[1];
        if (opts?.env) opts.env = Object.fromEntries(Object.entries(opts.env).filter(([key]) =>
          ['MARKER', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'].includes(key)));
        return { method, args };
      })));
    `)
    const { stdout } = await execute(process.execPath, ['--require', capture, bootstrap, entry])
    return JSON.parse(stdout) as { method: string, args: [string, string[], Record<string, unknown>] }[]
  }

  it('hides ordinary and ACL runners while preserving arguments, pipes and sandbox console attachment', async () => {
    const calls = await captureLaunches('win32')
    for (const call of calls.slice(0, 2)) {
      expect(call.args[1].slice(0, 2)).toEqual(['--require', join(root, 'windows-runner-console.cjs')])
      expect(call.args[2]).toEqual({
        cwd: '/workspace', windowsHide: true,
        env: { MARKER: 'kept', ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe', 'pipe', 'pipe'],
      })
    }
    expect(calls[0]!.args[1].slice(3)).toEqual(['--', 'cmd.exe', '/c', 'echo ok'])
    expect(calls[1]!.args[1].slice(3)).toEqual(['--mode', 'workspace-write'])
    expect(calls[2]!.args[1][0]).toBe(join(root, 'directory-picker-worker.cjs'))
    expect(calls[2]!.args[2]).not.toHaveProperty('windowsHide')
    expect(calls[3]!.args[2]).toEqual({ env: { MARKER: 'external' }, windowsHide: false })
  })

  it('hides node-pty cleanup forks and supplies Node mode only when using Electron', async () => {
    const calls = await captureLaunches('win32')
    expect(calls[4]).toMatchObject({ method: 'fork', args: [
      '/runtime/node_modules/node-pty/lib/conpty_console_list_agent', ['123'], {
        windowsHide: true, env: { MARKER: 'kept', ELECTRON_RUN_AS_NODE: '1' },
      },
    ] })
    expect(calls[5]!.args[1]).toEqual([])
    expect(calls[5]!.args[2]).toMatchObject({ windowsHide: true, execPath: 'node.exe' })
    expect(calls[5]!.args[2].env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(calls[6]!.args[2]).toEqual({ env: { MARKER: 'other' } })
  })

  it.each(['darwin', 'linux'])('does not alter console or fork options on %s', async (platform) => {
    const calls = await captureLaunches(platform)
    expect(calls[0]!.args[1][0]).not.toBe('--require')
    expect(calls[0]!.args[2]).not.toHaveProperty('windowsHide')
    expect(calls[4]!.args[2]).not.toHaveProperty('windowsHide')
    expect(calls[4]!.args[2].env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })
})
