import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
let root: string
let preload: string
let entry: string
let workerEntry: string
const resolverSource = `
import { createRequire } from 'node:module';
function internalModules() {
  const addon = createRequire(import.meta.url)("node-addon-require-builtin");
  return addon.requireBuiltin('internal/modules/esm/loader');
}
export const available = typeof internalModules().getOrInitializeCascadedLoader === 'function';
`

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-node-internals-')))
  const compiler = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
  await execute(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2024', '--module', 'NodeNext',
    '--skipLibCheck', '--types', 'node', '--outDir', root, resolve('src/harness-node-internals.cts')])
  preload = join(root, 'harness-node-internals.cjs')
  const packageRoot = join(root, 'node_modules/@deepseek-ai/dsh-app-boot')
  entry = join(packageRoot, 'lib/index.js')
  workerEntry = join(packageRoot, 'lib/worker/profile-resolution-bootstrap.js')
  await mkdir(dirname(workerEntry), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}')
  await writeFile(entry, resolverSource)
  await writeFile(workerEntry, resolverSource)
  const addon = join(root, 'node_modules/node-addon-require-builtin/index.js')
  await mkdir(dirname(addon), { recursive: true })
  await writeFile(addon, 'throw new Error("native fingerprint rejected")')
}, 20_000)

afterAll(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }) })

describe('DSH internal module access', () => {
  it('uses actual Node internals without loading the fingerprint-specific addon', async () => {
    const result = await execute(process.execPath, ['--expose-internals', '--require', preload, '--input-type=module',
      '-e', `console.log((await import(${JSON.stringify(pathToFileURL(entry).href)})).available)`])
    expect(result.stdout.trim()).toBe('true')
  })

  it('does not substitute the addon without an explicit --expose-internals launch', async () => {
    await expect(execute(process.execPath, ['--require', preload, entry])).rejects.toMatchObject({
      stderr: expect.stringContaining('native fingerprint rejected'),
    })
  })

  it('does not modify an unrelated module containing the same source', async () => {
    const unrelated = join(root, 'unrelated.mjs')
    await writeFile(unrelated, resolverSource)
    await expect(execute(process.execPath, ['--expose-internals', '--require', preload, unrelated])).rejects.toMatchObject({
      stderr: expect.stringContaining('native fingerprint rejected'),
    })
  })

  it('carries access into DSH workers that clear execArgv and preserves their options', async () => {
    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      import(${JSON.stringify(pathToFileURL(workerEntry).href)}).then(({ available }) =>
        parentPort.postMessage({ available, workerData, execArgv: process.execArgv }));
    `
    const script = `
      const { Worker, setEnvironmentData } = require('node:worker_threads');
      setEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution', { resolution: {} });
      const worker = new Worker(${JSON.stringify(workerCode)}, {
        eval: true, execArgv: ['--no-warnings'], workerData: { kept: true }
      });
      worker.once('message', value => console.log(JSON.stringify(value)));
    `
    const result = await execute(process.execPath, ['--expose-internals', '--require', preload, '-e', script])
    expect(JSON.parse(result.stdout)).toEqual({
      available: true, workerData: { kept: true },
      execArgv: ['--no-warnings', '--expose-internals', '--require', preload],
    })
  })

  it('leaves worker arguments alone outside a Harness package resolution context', async () => {
    const script = `
      const { Worker } = require('node:worker_threads');
      new Worker('require("node:worker_threads").parentPort.postMessage(process.execArgv)', {
        eval: true, execArgv: []
      }).once('message', value => console.log(JSON.stringify(value)));
    `
    const result = await execute(process.execPath, ['--expose-internals', '--require', preload, '-e', script])
    expect(JSON.parse(result.stdout)).toEqual([])
  })
})
