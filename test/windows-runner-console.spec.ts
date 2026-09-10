import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
let root: string
let preload: string
let platform: string
let entry: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-runner-console-'))
  const compiler = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
  await execute(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2024', '--module', 'NodeNext',
    '--skipLibCheck', '--types', 'node', '--outDir', root, resolve('src/windows-runner-console.cts')])
  preload = join(root, 'windows-runner-console.cjs')
  platform = join(root, 'platform.cjs')
  entry = join(root, 'runner.mjs')
  await writeFile(platform, `Object.defineProperty(process, 'platform', { value: 'win32' }); globalThis.consoleCalls = [];`)
  await mkdir(join(root, 'node_modules/koffi'), { recursive: true })
  await writeFile(join(root, 'node_modules/koffi/index.js'), `
    let attempts = 0;
    exports.load = () => ({ func: declaration => (...args) => {
      const name = declaration.match(/(\\w+)\\(/)[1];
      globalThis.consoleCalls.push([name, ...args]);
      switch (name) {
        case 'GetConsoleWindow': return process.env.CONSOLE_CASE === 'attached' ? 1 : null;
        case 'AttachConsole': return process.env.CONSOLE_CASE === 'attach'
          || (process.env.CONSOLE_CASE === 'conpty' && ++attempts > 1);
        case 'GetLastError': return process.env.CONSOLE_CASE === 'failed' ? 6 : 5;
        case 'FreeConsole': return true;
        default: throw new Error('Unexpected API: ' + name);
      }
    } });
  `)
  await writeFile(entry, `
    if (!import.meta.main) throw new Error('Runner must remain the main module');
    const result = { calls: globalThis.consoleCalls, args: process.argv.slice(2) };
    if (process.send) process.once('message', request => process.send({ request, ...result }, () => process.disconnect()));
    else console.log(JSON.stringify(result));
  `)
}, 20_000)
afterAll(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }) })

describe('Windows runner console preload', () => {
  it.each([
    ['attached', [['GetConsoleWindow']]],
    ['attach', [['GetConsoleWindow'], ['AttachConsole', 0xffffffff]]],
    ['conpty', [['GetConsoleWindow'], ['AttachConsole', 0xffffffff], ['GetLastError'], ['FreeConsole'], ['AttachConsole', 0xffffffff]]],
  ])('preserves the runner entry and joins the host console (%s)', async (kind, calls) => {
    const { stdout } = await execute(process.execPath, ['--require', platform, '--require', preload, entry, '--', 'cmd.exe', '/c', 'echo ok'], {
      env: { ...process.env, CONSOLE_CASE: kind as string },
    })
    expect(JSON.parse(stdout)).toEqual({ calls, args: ['--', 'cmd.exe', '/c', 'echo ok'] })
  })

  it('stops before launching commands when the required host console cannot be attached', async () => {
    await expect(execute(process.execPath, ['--require', platform, '--require', preload, entry], {
      env: { ...process.env, CONSOLE_CASE: 'failed' },
    })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('AttachConsole failed (Win32 6)') })
  })

  it('preserves the parent IPC channel for command requests and results', async () => {
    const child = spawn(process.execPath, ['--require', platform, '--require', preload, entry, '--', 'cmd.exe'], {
      env: { ...process.env, CONSOLE_CASE: 'attach' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    })
    const messages: unknown[] = []
    const result = await new Promise<{ code: number | null, stderr: string }>((resolveExit, reject) => {
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('message', (message) => messages.push(message))
      child.once('error', reject)
      child.once('close', (code) => resolveExit({ code, stderr }))
      child.send({ type: 'start' })
    })
    expect(result).toEqual({ code: 0, stderr: '' })
    expect(messages).toEqual([{
      request: { type: 'start' }, calls: [['GetConsoleWindow'], ['AttachConsole', 0xffffffff]], args: ['--', 'cmd.exe'],
    }])
  })
})
