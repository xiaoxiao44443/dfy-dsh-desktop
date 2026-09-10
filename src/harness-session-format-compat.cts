import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

/** These released DFY blocks contain resource identities, never event offsets. */
export function assertDfyHistoryBlock(value: unknown): boolean {
  const object = (item: unknown): Record<string, unknown> => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('expected an object')
    return item as Record<string, unknown>
  }
  const block = object(value)
  if (block.type !== 'dfy-media' && block.type !== 'dfy-session-image') return false
  const fields = (item: Record<string, unknown>, required: string[], optional: string[] = []): void => {
    if (required.some((key) => !Object.hasOwn(item, key))
      || Object.keys(item).some((key) => !required.includes(key) && !optional.includes(key))) {
      throw new Error('unsupported fields')
    }
  }
  const string = (item: unknown): void => { if (typeof item !== 'string') throw new Error('expected a string') }
  const positive = (item: unknown): void => {
    if (!Number.isSafeInteger(item) || Number(item) <= 0) throw new Error('expected a positive integer')
  }
  const image = (item: Record<string, unknown>): void => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.mediaType))) throw new Error('unsupported image media type')
    if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0) throw new Error('invalid image size')
    positive(item.width)
    positive(item.height)
    if (item.name !== undefined) string(item.name)
  }
  try {
    if (block.version !== 1 || typeof block.ref === 'string' && block.ref.length === 0) throw new Error('unsupported block version or reference')
    if (block.type === 'dfy-media') {
      fields(block, ['type', 'version', 'resource'], ['presentation'])
      const resource = object(block.resource)
      fields(resource, ['kind', 'ref', 'attachment'])
      if (resource.kind !== 'image' || typeof resource.ref !== 'string' || resource.ref.length === 0) throw new Error('unsupported media resource')
      const attachment = object(resource.attachment)
      fields(attachment, ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], ['name', 'originalDimensions'])
      if (typeof attachment.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(attachment.attachmentId)) throw new Error('invalid attachment identity')
      image(attachment)
      if (attachment.originalDimensions !== undefined) {
        const dimensions = object(attachment.originalDimensions)
        fields(dimensions, ['width', 'height'])
        positive(dimensions.width)
        positive(dimensions.height)
      }
      if (block.presentation !== undefined) {
        const presentation = object(block.presentation)
        fields(presentation, [], ['name', 'caption', 'renderer'])
        for (const item of Object.values(presentation)) string(item)
      }
    } else {
      fields(block, ['type', 'version', 'ref', 'image'])
      if (typeof block.ref !== 'string' || block.ref.length === 0) throw new Error('invalid image reference')
      const reference = object(block.image)
      fields(reference, ['kind', 'version', 'sessionId', 'imageId', 'mediaType', 'bytes', 'width', 'height'], ['name'])
      if (reference.kind !== 'dsh-session-image' || reference.version !== 1
        || typeof reference.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(reference.sessionId)
        || typeof reference.imageId !== 'string' || !/^[a-f0-9]{64}$/.test(reference.imageId)) throw new Error('invalid session image identity')
      image(reference)
    }
  } catch (error) {
    throw new Error(`Unsupported ${String(block.type)} history block: ${error instanceof Error ? error.message : String(error)}`)
  }
  return true
}

/** Patch only the audited alpha.1/alpha.2/rc.1 admission boundary; leave all transformations intact. */
export function withDfyHistoryAdmission(source: string): string {
  const kinds = 'const CONTENT_KINDS = new Set(['
  const admission = 'function assertContentBlock(value, label) {\n\tconst block = record(value, label);'
  if (source.split(kinds).length !== 2 || source.split(admission).length !== 2) {
    throw new Error('DSH 0.1.5 history compatibility: unsupported migration module layout')
  }
  return source.replace(kinds, `${kinds}\n\t"dfy-media",\n\t"dfy-session-image",`)
    .replace(admission, `${assertDfyHistoryBlock.toString()}\n${admission}\n\tif (assertDfyHistoryBlock(block)) return;`)
}

/** Install before Harness imports its immutable, build-static migration catalog. */
export function registerDfySessionFormatCompatibility(): void {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (!url.startsWith('file:') || !url.endsWith('/@deepseek-ai/dsh-session-format-v2-to-v3/lib/index.js')) return loaded
      const pkg = JSON.parse(readFileSync(new URL('../package.json', url), 'utf8')) as { version?: string }
      if (!['0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1'].includes(pkg.version ?? '')
        || loaded.source === null || loaded.source === undefined) return loaded
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source as Uint8Array).toString('utf8')
      return { ...loaded, source: withDfyHistoryAdmission(source) }
    },
  })
}
