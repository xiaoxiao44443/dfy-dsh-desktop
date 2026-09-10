import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

let root: string
let assertDfyHistoryBlock: (value: unknown) => boolean
let withDfyHistoryAdmission: (source: string) => string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-history-admission-'))
  const require = createRequire(import.meta.url)
  const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
  await promisify(execFile)(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2024', '--module', 'NodeNext',
    '--skipLibCheck', '--types', 'node', '--outDir', root, resolve('src/harness-session-format-compat.cts')])
  ;({ assertDfyHistoryBlock, withDfyHistoryAdmission } = require(join(root, 'harness-session-format-compat.cjs')))
}, 20_000)
afterAll(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }) })

const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 12, width: 1, height: 1 }
const media = { type: 'dfy-media', version: 1, resource: { kind: 'image', ref: 'image-ref', attachment }, presentation: { name: 'image.png' } }
const generated = { type: 'dfy-session-image', version: 1, ref: 'session-image-ref', image: {
  kind: 'dsh-session-image', version: 1, sessionId: 'session-fixture', imageId: 'b'.repeat(64), mediaType: 'image/png', bytes: 12, width: 1, height: 1,
} }

describe('DFY historical content admission', () => {
  it.each(['0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1'])('installs the admission hook for audited runtime %s', async (version) => {
    const moduleRoot = join(root, version, 'node_modules', '@deepseek-ai', 'dsh-session-format-v2-to-v3')
    const entry = join(moduleRoot, 'lib', 'index.js')
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(join(moduleRoot, 'package.json'), JSON.stringify({ type: 'module', version }))
    await writeFile(entry, `const CONTENT_KINDS = new Set(["text"]);
function record(value) { return value; }
function assertContentBlock(value, label) {
\tconst block = record(value, label);
  if (!CONTENT_KINDS.has(block.type)) throw new Error('unknown content');
}
export { assertContentBlock };
`)
    const script = `
      const assert = require('node:assert/strict');
      require(${JSON.stringify(join(root, 'harness-session-format-compat.cjs'))}).registerDfySessionFormatCompatibility();
      (async () => {
        const { assertContentBlock } = await import(${JSON.stringify(pathToFileURL(entry).href)});
        assertContentBlock(${JSON.stringify(media)}, 'fixture');
        assertContentBlock(${JSON.stringify(generated)}, 'fixture');
        assert.throws(() => assertContentBlock({ ...${JSON.stringify(media)}, sourceSeq: 1 }, 'fixture'), /unsupported fields/);
        assert.throws(() => assertContentBlock({ type: 'unknown-plugin' }, 'fixture'), /unknown content/);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `
    await expect(promisify(execFile)(process.execPath, ['-e', script])).resolves.toBeDefined()
  })

  it.each([media, generated])('preserves the released $type block without dropping references', (block) => {
    const before = structuredClone(block)
    expect(assertDfyHistoryBlock(block)).toBe(true)
    expect(block).toEqual(before)
  })

  it.each([
    { ...media, version: 2 },
    { ...media, sourceSeq: 10 },
    { ...media, resource: { ...media.resource, kind: 'future-media' } },
    { ...media, resource: { ...media.resource, attachment: { ...attachment, width: 0 } } },
    { ...media, presentation: { ...media.presentation, eventSeq: 1 } },
    { ...generated, image: { ...generated.image, imageId: '../image' } },
  ])('refuses unaudited data instead of guessing its event references', (block) => {
    expect(() => assertDfyHistoryBlock(block)).toThrow(/Unsupported .* history block/)
  })

  it('leaves built-in and other plugin block admission to Harness', () => {
    expect(assertDfyHistoryBlock({ type: 'text', text: 'hello' })).toBe(false)
    expect(assertDfyHistoryBlock({ type: 'another-plugin', seq: 10 })).toBe(false)
  })

  it('does not silently modify a changed upstream migration layout', () => {
    expect(() => withDfyHistoryAdmission('export const changed = true')).toThrow(/unsupported migration module layout/)
  })
})
