import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { imageCopyFilename, imageFile, MAX_IMAGE_FILE_BYTES, resolveImageRevealPath } from '../src/main/image-files.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==', 'base64')
const NOW = new Date(2026, 8, 9, 19, 23, 54)
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Every cleanup target is an absolute mkdtemp result below the intended temp directory.
    const rel = relative(tmpdir(), root)
    if (!rel.startsWith('dfy-image-files-') || rel.includes('..')) throw new Error('Unexpected temporary directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dfy-image-files-'))
  roots.push(root)
  return {
    root,
    options: { sourceUrl: 'blob:http://localhost/example', harnessHome: join(root, 'harness') },
  }
}

describe('image file data and copy names', () => {
  it('detects real encoded image formats and retains the original bytes', () => {
    for (const [data, extension] of [[PNG, 'png'], [JPEG, 'jpg'], [GIF, 'gif'], [WEBP, 'webp']] as const) {
      const result = imageFile(data)
      expect(result.extension).toBe(extension)
      expect(result.data).toBe(data)
    }
  })

  it('rejects HTML, unsupported data, truncated files, damaged structure and oversized files', () => {
    for (const data of [Buffer.alloc(0), Buffer.from('<html><img src="photo.png"></html>'), Buffer.from('image/png'),
      PNG.subarray(0, 8), PNG.subarray(0, PNG.length - 1), JPEG.subarray(0, JPEG.length - 2), GIF.subarray(0, 20), WEBP.subarray(0, 20),
      Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1)]) expect(() => imageFile(data)).toThrow()
    const malformed = Buffer.from(PNG)
    malformed.writeUInt32BE(0xffffffff, 8)
    expect(() => imageFile(malformed)).toThrow()
  })

  it('uses the requested Chinese local date format and pads only the time', () => {
    expect(imageCopyFilename('png', NOW)).toBe('DFY DSH 图像 2026年9月9日 19_23_54.png')
    expect(imageCopyFilename('jpg', new Date(2026, 0, 2, 3, 4, 5))).toBe('DFY DSH 图像 2026年1月2日 03_04_05.jpg')
    expect(() => imageCopyFilename('../file', NOW)).toThrow()
    expect(() => imageCopyFilename('png', new Date('invalid'))).toThrow()
  })
})

describe('image file reveal locations', () => {
  it('reveals an existing local source only when its bytes match', async () => {
    const { root, options } = await fixture()
    const source = join(root, '原图 #100%.png')
    await writeFile(source, PNG)
    const sourceUrl = pathToFileURL(source).href
    expect(await resolveImageRevealPath(imageFile(PNG), { ...options, sourceUrl })).toBe(source)
    expect(await readdir(root)).toEqual(['原图 #100%.png'])
    await writeFile(source, GIF)
    expect(await resolveImageRevealPath(imageFile(PNG), { ...options, sourceUrl })).toBeUndefined()
    expect(await readFile(source)).toEqual(GIF)
    expect(await readdir(root)).toEqual(['原图 #100%.png'])
  })

  it('locates the original DFY session image by digest without changing logs or image names', async () => {
    const { options } = await fixture()
    const digest = createHash('sha256').update(PNG).digest('hex')
    const session = join(options.harnessHome, 'sessions', '--project--', 'session-one')
    const directory = join(session, 'artifacts', 'images', digest)
    const original = join(directory, 'image.png')
    await mkdir(directory, { recursive: true })
    await writeFile(original, PNG)
    await writeFile(join(session, 'session.jsonl'), 'this is deliberately not a JSON session log')
    const before = await readdir(directory)
    expect(await resolveImageRevealPath(imageFile(PNG), options)).toBe(original)
    expect(await readFile(original)).toEqual(PNG)
    expect(await readdir(directory)).toEqual(before)
    expect(await readFile(join(session, 'session.jsonl'), 'utf8')).toBe('this is deliberately not a JSON session log')
  })

  it('verifies the official attachment object and returns no path if stored bytes differ', async () => {
    const { options } = await fixture()
    const digest = createHash('sha256').update(PNG).digest('hex')
    const directory = join(options.harnessHome, 'attachments', 'v1', 'objects', digest.slice(0, 2))
    const original = join(directory, digest)
    await mkdir(directory, { recursive: true })
    await writeFile(original, PNG)
    expect(await resolveImageRevealPath(imageFile(PNG), options)).toBe(original)
    await writeFile(original, Buffer.alloc(PNG.length))
    expect(await resolveImageRevealPath(imageFile(PNG), options)).toBeUndefined()
    expect(await readFile(original)).toEqual(Buffer.alloc(PNG.length))
    expect(await readdir(directory)).toEqual([digest])
  })

  it('returns no path for memory-only images without creating any files or directories', async () => {
    const { root, options } = await fixture()
    for (const sourceUrl of ['blob:http://localhost/example', `data:image/png;base64,${PNG.toString('base64')}`, '']) {
      expect(await resolveImageRevealPath(imageFile(PNG), { ...options, sourceUrl })).toBeUndefined()
    }
    expect(await readdir(root)).toEqual([])
  })

  it('does not follow network file URLs when resolving a local image', async () => {
    const { root, options } = await fixture()
    for (const sourceUrl of ['file://example.invalid/share/image.png', 'file:////example.invalid/share/image.png']) {
      expect(await resolveImageRevealPath(imageFile(PNG), { ...options, sourceUrl })).toBeUndefined()
    }
    expect(await readdir(root)).toEqual([])
  })
})
