import { describe, expect, it, vi } from 'vitest'

// Reproduce macOS path classification on every CI host without touching files.
vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>()
  return { ...path, isAbsolute: path.posix.isAbsolute }
})

import { normalizeBrowserAddress } from '../src/main/desktop-browser-utils.js'

describe('browser addresses with POSIX path semantics', () => {
  it.each(['\\\\server\\share\\index.html', '//server/share/index.html'])(
    'rejects network-share paths instead of sending them to web search: %s', (path) => {
      expect(() => normalizeBrowserAddress(path)).toThrow()
      expect(() => normalizeBrowserAddress(path, false)).toThrow()
    },
  )
})
