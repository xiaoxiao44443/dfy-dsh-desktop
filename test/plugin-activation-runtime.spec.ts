import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('preserves official activation and rc.2 admission decisions through the desktop Client Gateway', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfy-plugin-admission-'))
  try {
    const require = createRequire(import.meta.url)
    const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc')
    await promisify(execFile)(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2024', '--module', 'NodeNext',
      '--skipLibCheck', '--types', 'node', '--outDir', root, resolve('src/harness-node-internals.cts')], { windowsHide: true })
    const result = await promisify(execFile)(process.execPath, ['--expose-internals', '--require', join(root, 'harness-node-internals.cjs'),
      resolve('test/fixtures/plugin-activation-017.mjs'), require.resolve('@deepseek-ai/dsh/package.json')], { windowsHide: true })
    expect(result.stdout.match(/PASS official Client Gateway/gu)).toHaveLength(2)
    expect(result.stdout.match(/PASS rc.2 typed compatibility refusal/gu)).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
