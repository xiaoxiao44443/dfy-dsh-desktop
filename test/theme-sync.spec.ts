import { describe, expect, it } from 'vitest'
import { readHarnessThemeMessage, THEME_SYNC_TRANSPORT_KEY } from '../src/shared/theme-sync.js'

describe('Harness theme message boundary', () => {
  const frame = {}
  const url = 'http://127.0.0.1:45678/'
  const event = { source: frame, origin: new URL(url).origin,
    data: { type: THEME_SYNC_TRANSPORT_KEY, preference: 'dark' } }

  it.each(['dark', 'light', 'system'])('accepts %s only from the current Harness iframe', (preference) => {
    expect(readHarnessThemeMessage({ ...event, data: { ...event.data, preference } }, frame, url)).toBe(preference)
  })

  it('ignores other frames, replaced origins and malformed messages', () => {
    expect(readHarnessThemeMessage({ ...event, source: {} }, frame, url)).toBeUndefined()
    expect(readHarnessThemeMessage(event, undefined, url)).toBeUndefined()
    expect(readHarnessThemeMessage(event, frame, 'http://127.0.0.1:45679/')).toBeUndefined()
    expect(readHarnessThemeMessage(event, frame, '')).toBeUndefined()
    for (const data of [null, {}, { type: 'other', preference: 'dark' },
      { type: THEME_SYNC_TRANSPORT_KEY, preference: 'auto' }]) {
      expect(readHarnessThemeMessage({ ...event, data }, frame, url)).toBeUndefined()
    }
  })
})
