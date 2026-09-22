import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'

let root: string
let helper: string
let profile: string
const require = createRequire(import.meta.url)
const runtime = require.resolve('@deepseek-ai/dsh/package.json')
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'plugin-diagnostic-'))
  const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
  await promisify(execFile)(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2024', '--module', 'NodeNext', '--skipLibCheck', '--types', 'node', '--outDir', root, resolve('src/harness-plugin-diagnostics.cts')])
  helper = join(root, 'harness-plugin-diagnostics.cjs')
  profile = join(root, 'profile')
  for (const name of ['collection', 'member', 'standalone']) {
    const dir = join(profile, 'node_modules', name)
    await mkdir(join(dir, 'locale'), { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: './index.js', exports: { '.': './index.js', './package.json': './package.json', './locale/*.json': './locale/*.json' }, dsh: { bundle: { patch: ['./a.yml', './b.yml'] } } }))
    await writeFile(join(dir, 'index.js'), 'throw new Error("Metadata must not execute plugin code")')
    await writeFile(join(dir, 'locale', 'en.json'), JSON.stringify({ meta: { title: name } }))
    await writeFile(join(dir, 'locale', 'zh.json'), JSON.stringify({ meta: { title: name === 'collection' ? '测试组合包' : name === 'member' ? '测试组件' : '独立插件' } }))
    await writeFile(join(dir, 'a.yml'), JSON.stringify([{ insert: name === 'collection' ? [{ id: 'group', name: 'group', group: true, config: [{ id: 'broken', name: 'member' }] }] : [{ id: name, name }] }]))
    await writeFile(join(dir, 'b.yml'), '[]')
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['collection', 'standalone'] } } }))
}, 20_000)
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

it('resolves actual bundle rows and Chinese names, with standalone and missing-metadata fallbacks', async () => {
  const entries = [{ entryId: 'broken', pluginName: 'member' }, { entryId: 'standalone', pluginName: 'standalone' }, { entryId: 'unknown', pluginName: 'missing-package' }]
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-internals', helper, runtime, profile], { windowsHide: true })
    let stdout = '', stderr = ''
    child.on('error', reject)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)))
    child.stdin.end(JSON.stringify(entries))
  })
  expect(JSON.parse(output)).toEqual([
    { ...entries[0], displayName: '测试组件', bundleName: 'collection', bundleTitle: '测试组合包' },
    { ...entries[1], displayName: '独立插件' },
    entries[2],
  ])
})
