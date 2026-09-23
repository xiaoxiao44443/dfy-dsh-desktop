import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createThemeClient } from './fixtures/theme-client.mjs'

const packagePath = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
const harnessRequire = createRequire(realpathSync(packagePath))
const { Config } = await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-client-ui-theme')).href)
const schema = Config.toJSON()
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

async function fixture(guarded = true) {
  let preference = 'light'
  let fontSize = 14
  let revision = 0
  const row = () => ({ ns: 'ui-theme', revision: String(revision), base: {}, user: { preference },
    value: { preference, fontSize }, schema })
  const pending: Array<{ field: string; value: string | number; resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  const mutate = vi.fn((_namespace: string, ops: Array<{ path: string[]; value: string | number }>) => new Promise((resolve, reject) => {
    pending.push({ field: ops[0]!.path[0]!, value: ops[0]!.value, resolve, reject })
  }))
  const client = await createThemeClient(packagePath, {
    describe: async () => ({ ok: true, value: { writable: true, namespaces: [row()] } }), mutate,
  })
  const disposeGuard = guarded ? client.guard() : () => {}
  const changes: string[] = []
  client.onChange((snapshot: { preference: string }) => changes.push(snapshot.preference))
  return { ...client, changes, mutate, pending,
    async external(value: string) { preference = value; revision++; await client.refresh() },
    async accept() {
      const write = pending.shift()!
      if (write.field === 'preference') preference = write.value as string
      else fontSize = write.value as number
      revision++
      write.resolve({ ok: true, value: row() })
      await tick()
    },
    async dispose() { disposeGuard(); await client.dispose() },
    disposeGuard,
  }
}

describe('official theme preference writes', () => {
  it('reproduces the upstream replay from a describe response between writes', async () => {
    const f = await fixture(false)
    try {
      f.theme.setTheme('dark')
      f.theme.setTheme('light')
      await tick()
      await f.external('dark')
      await f.accept()
      await f.accept()
      expect(f.changes).toEqual(['dark', 'light', 'dark', 'light'])
    } finally { await f.dispose() }
  })

  it('keeps the last click visible through stale refreshes without extra writes', async () => {
    const f = await fixture()
    try {
      for (const value of ['dark', 'light', 'dark', 'system']) f.theme.setTheme(value)
      await tick()
      for (const value of ['dark', 'light', 'dark', 'system']) {
        await f.external(value)
        expect(f.theme.getTheme().preference).toBe('system')
        await f.accept()
      }
      expect(f.changes).toEqual(['dark', 'light', 'dark', 'system'])
      expect(f.mutate).toHaveBeenCalledTimes(4)
      await f.external('light')
      expect(f.theme.getTheme().preference).toBe('light')
    } finally { await f.dispose() }
  })

  it.each(['refused', 'disconnected'])('recovers the accepted preference when saving is %s', async (failure) => {
    const f = await fixture()
    try {
      f.theme.setTheme('dark')
      await tick()
      const write = f.pending.shift()!
      if (failure === 'refused') write.resolve({ ok: false, error: { message: 'refused' } })
      else write.reject(new Error('disconnected'))
      await vi.waitFor(() => expect(f.theme.getTheme().preference).toBe('light'))
      expect(f.mutate).toHaveBeenCalledOnce()
    } finally { await f.dispose() }
  })

  it('keeps the new theme when a font-size write follows it in the same queue', async () => {
    const f = await fixture()
    try {
      f.theme.setTheme('dark')
      f.theme.setFontSize(15)
      await tick()
      await f.external('light')
      await f.accept()
      expect(f.theme.getTheme().preference).toBe('dark')
      await f.accept()
      expect(f.theme.getTheme()).toMatchObject({ preference: 'dark', fontSize: 15 })
      expect(f.mutate).toHaveBeenCalledTimes(2)
    } finally { await f.dispose() }
  })

  it('restores the original hooks when the bridge is disposed', async () => {
    const f = await fixture()
    try {
      f.disposeGuard()
      f.theme.setTheme('dark')
      await tick()
      await f.external('light')
      expect(f.theme.getTheme().preference).toBe('light')
      await f.accept()
    } finally { await f.dispose() }
  })
})

describe('native theme synchronization during startup', () => {
  it.each(['dark', 'light'])('waits for the saved %s preference and still follows later user changes', async (savedPreference) => {
    const description = Promise.withResolvers<unknown>()
    let preference = savedPreference
    let revision = 0
    const row = () => ({ ns: 'ui-theme', revision: String(revision), base: {}, user: { preference },
      value: { preference, fontSize: 14 }, schema })
    const mutate = vi.fn(async (_namespace: string, ops: Array<{ value: string }>) => {
      preference = ops[0]!.value
      revision++
      return { ok: true, value: row() }
    })
    const client = await createThemeClient(packagePath, {
      describe: () => description.promise, mutate,
    }, { initialize: false })
    const dispose = client.sync()
    try {
      expect(client.theme.getTheme().preference).toBe('system')
      expect(client.readPreference()).toBeUndefined()
      expect(client.messages).toEqual([])
      const loading = client.refresh()
      await tick()
      expect(client.readPreference()).toBeUndefined()
      expect(mutate).not.toHaveBeenCalled()
      description.resolve({ ok: true, value: { writable: true, namespaces: [row()] } })
      await loading
      expect(client.readPreference()).toBe(savedPreference)
      expect(client.messages.map((message: { preference: string }) => message.preference)).toEqual([savedPreference])
      // A real user choice after startup must not be held at the saved color.
      client.theme.setTheme('system')
      expect(client.readPreference()).toBe('system')
      expect(client.messages.at(-1)?.preference).toBe('system')
      await tick()
      expect(mutate).toHaveBeenCalledOnce()
      dispose()
      expect(client.readPreference()).toBeUndefined()
    } finally {
      dispose()
      description.resolve({ ok: true, value: { writable: true, namespaces: [row()] } })
      await client.dispose()
    }
  })

  it('pushes manual changes immediately, ignores stale saves and unsubscribes on disposal', async () => {
    const f = await fixture()
    const dispose = f.sync()
    const preferences = () => f.messages.map((message: { preference: string }) => message.preference)
    try {
      expect(preferences()).toEqual(['light'])
      f.theme.setTheme('dark')
      f.theme.setTheme('light')
      f.theme.setTheme('dark')
      // No timer or settings round trip is needed for the title bar notification.
      expect(preferences()).toEqual(['light', 'dark', 'light', 'dark'])
      await tick()
      await f.external('light')
      await f.accept()
      await f.accept()
      await f.accept()
      expect(preferences()).toEqual(['light', 'dark', 'light', 'dark'])
      f.theme.setFontSize(15)
      await tick()
      await f.accept()
      expect(preferences()).toHaveLength(4)
      dispose()
      f.theme.setTheme('system')
      await tick()
      await f.accept()
      expect(preferences()).toHaveLength(4)
    } finally { dispose(); await f.dispose() }
  })
})
