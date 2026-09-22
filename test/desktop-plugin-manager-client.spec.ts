import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopPluginClient } from './fixtures/desktop-plugin-client.mjs'

const dshPackagePath = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')

describe('desktop plugin switches through the real DSH Client Gateway', () => {
  it('enables and disables bundles from the bridge plugin context and unwraps Remote answers', async () => {
    const packageName = '@dfy-plugins/dsh-bundle'
    const outcome = { target: packageName, changed: true, application: 'applied' }
    const call = vi.fn(async () => ({ ok: true, value: outcome }))
    const client = await createDesktopPluginClient(dshPackagePath, call)
    try {
      for (const enabled of [true, false]) {
        await expect(client.transport.setBundleEnabled(packageName, enabled)).resolves.toEqual(outcome)
        expect(call).toHaveBeenLastCalledWith('/api', 'pluginManager/setBundleEnabled',
          { args: { name: packageName, enabled } }, expect.any(AbortSignal))
      }
      expect(call).toHaveBeenCalledTimes(2)
    } finally {
      await client.dispose()
    }
    expect(Reflect.get(client.window, Symbol.for('dsh.desktop.plugin-manager.transport.v1'))).toBeUndefined()
  })

  it('rejects refused Remote answers with their diagnostic instead of an invalid-result error', async () => {
    const call = vi.fn(async () => ({ ok: false, error: { code: 'gateway/internal', message: '插件启用失败：权限不足' } }))
    const client = await createDesktopPluginClient(dshPackagePath, call)
    try {
      await expect(client.transport.setBundleEnabled('@dfy-plugins/dsh-bundle', true))
        .rejects.toThrow('插件启用失败：权限不足')
    } finally {
      await client.dispose()
    }
  })
})
