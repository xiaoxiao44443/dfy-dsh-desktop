import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  root = await mkdtemp(join(tmpdir(), 'dsh-cli-entry-'))
  const compiler = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
  await execute(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2024', '--module', 'NodeNext',
    '--skipLibCheck', '--types', 'node', '--outDir', root, resolve('src/harness-bootstrap.cts')])
  bootstrap = join(root, 'harness-bootstrap.cjs')
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

describe('Harness bootstrap console compatibility', () => {
  it('keeps Electron Node workers attached to the hidden Harness console', async () => {
    const source = await readFile(new URL('../src/harness-bootstrap.cts', import.meta.url), 'utf8')

    expect(source).toContain('freeConsole()')
    expect(source.indexOf('freeConsole()')).toBeLessThan(source.indexOf('allocConsole()'))
    expect(source).toContain('delete childEnvironment.ELECTRON_NO_ATTACH_CONSOLE')
    expect(source).not.toContain("ELECTRON_NO_ATTACH_CONSOLE: '1',")
    expect(source).toContain("workerArgs = [windowsAclRunnerWorkerShim, args[0], ...args.slice(1)]")
  })
})
