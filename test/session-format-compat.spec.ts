import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSessionFormatCompatible, storedSessionFormat } from '../src/main/session-format-compat.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(format: number) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-format-compat-'))
  roots.push(root)
  const session = join(root, 'sessions', 'project', 'session-test')
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-session')
  await mkdir(session, { recursive: true })
  await mkdir(pkg, { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ main: 'index.js' }))
  await writeFile(join(pkg, 'index.js'), `const SESSION_FORMAT_VERSION = ${format};`)
  return { root, session, entry: join(root, 'cli.js') }
}

describe('session format downgrade protection', () => {
  it('allows empty profiles and legacy logs', async () => {
    const { root, session, entry } = await fixture(0)
    await expect(storedSessionFormat(join(root, 'absent'))).resolves.toBe(0)
    await writeFile(join(session, 'session.jsonl.zstd'), 'original')
    await expect(assertSessionFormatCompatible(root, entry, '0.1.2-rc.1')).resolves.toBeUndefined()
  })

  it('blocks an old runtime once a committed V3 generation exists', async () => {
    const { root, session, entry } = await fixture(0)
    await writeFile(join(session, 'session.v3.jsonl.zstd'), 'new generation')
    await expect(assertSessionFormatCompatible(root, entry, '0.1.2-rc.1')).rejects.toThrow('仅支持 V0')
  })

  it('accepts matching formats and ignores temporary and noncanonical names', async () => {
    const { root, session, entry } = await fixture(3)
    for (const name of ['session.v3.jsonl', 'session.v9.jsonl.tmp', 'session.v04.jsonl.zstd']) {
      await writeFile(join(session, name), '')
    }
    await expect(storedSessionFormat(root)).resolves.toBe(3)
    await expect(assertSessionFormatCompatible(root, entry, '0.1.5-alpha.1')).resolves.toBeUndefined()
    await rm(join(root, 'node_modules'), { recursive: true })
    await expect(assertSessionFormatCompatible(root, entry, 'unknown')).rejects.toThrow('无法确认支持')
  })
})
