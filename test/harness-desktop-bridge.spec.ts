import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessDesktopBridgeHost } from '../src/main/harness-desktop-bridge.js'
import { apply, createRestartTool, STATIC_GUIDANCE } from '../resources/dsh-desktop-bridge/lib/index.js'

const hosts: HarnessDesktopBridgeHost[] = []
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (host) => await host.stop()))
  await Promise.all(temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

describe('HarnessDesktopBridgeHost', () => {
  it('writes a private patch and accepts only authenticated restart requests', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'dsh-desktop-bridge-'))
    temporaryPaths.push(userDataPath)
    const restartHarness = vi.fn(async () => undefined)
    const openPath = vi.fn(async () => '')
    const revealPath = vi.fn()
    const notifications = {
      currentSettings: { turnCompletion: 'unfocused', permissionRequests: true, questions: true },
      updateSettings: vi.fn(async (value: unknown) => value),
      show: vi.fn(async () => true),
    }
    const browser = {
      state: { settings: { enabled: true, agentOpenMode: 'background' } },
      updateSettings: vi.fn(async (value: unknown) => value),
      getHistory: vi.fn(() => []),
      clearHistory: vi.fn(async () => undefined),
      clearBrowsingData: vi.fn(async () => undefined),
      screenshotCacheStats: vi.fn(async () => ({ path: '/tmp/screenshots', files: 1, bytes: 8 })),
      clearScreenshotCache: vi.fn(async () => ({ path: '/tmp/screenshots', files: 0, bytes: 0 })),
      revealScreenshotCache: vi.fn(async () => undefined),
      getScreenshotResource: vi.fn((resourceId: string) => resourceId === 'a'.repeat(43) ? {
        mimeType: 'image/png',
        bytes: 8,
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      } : undefined),
      handleAgentRequest: vi.fn(async () => ({ ok: true })),
      updateAgentStatus: vi.fn(),
    }
    const host = new HarnessDesktopBridgeHost({
      userDataPath,
      pluginName: 'dsh-desktop-bridge',
      pluginRootPath: '/private/example/resources/dsh-desktop-bridge',
      browserPluginName: 'dsh-desktop-browser',
      browserPluginRootPath: '/private/example/resources/dsh-desktop-browser',
      profilePath: '/private/example/.dsh/profiles/web',
      notifications: notifications as never,
      browser: browser as never,
      openPath,
      revealPath,
      restartHarness,
      restartDelayMs: 5,
    })
    hosts.push(host)

    const launch = await host.start()
    const patch = JSON.parse(await readFile(launch.patchPath, 'utf8')) as Array<{
      insert: Array<{ id: string; name: string }>
    }>
    expect(patch).toEqual([{
      insert: [{
        id: 'desktop-bridge',
        name: 'dsh-desktop-bridge',
      }, {
        id: 'desktop-browser',
        name: 'dsh-desktop-browser',
      }],
    }])
    expect(launch.pluginRootPath).toBe('/private/example/resources/dsh-desktop-bridge')
    expect(launch.browserPluginRootPath).toBe('/private/example/resources/dsh-desktop-browser')

    const denied = await fetch(launch.controlUrl, { method: 'POST' })
    expect(denied.status).toBe(401)
    expect(restartHarness).not.toHaveBeenCalled()

    const accepted = await fetch(launch.controlUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${launch.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: '加载 greet' }),
    })
    expect(accepted.status).toBe(202)
    await vi.waitFor(() => expect(restartHarness).toHaveBeenCalledWith('加载 greet'))

    const controlOrigin = new URL(launch.controlUrl).origin
    const settings = await fetch(`${controlOrigin}/v1/notifications/settings`, {
      headers: { authorization: `Bearer ${launch.controlToken}` },
    })
    expect(settings.status).toBe(200)
    await expect(settings.json()).resolves.toEqual({ settings: notifications.currentSettings })

    const updated = await fetch(`${controlOrigin}/v1/notifications/settings`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${launch.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ turnCompletion: 'always', permissionRequests: false, questions: true }),
    })
    expect(updated.status).toBe(200)
    expect(notifications.updateSettings).toHaveBeenCalledWith({
      turnCompletion: 'always',
      permissionRequests: false,
      questions: true,
    })

    const shown = await fetch(`${controlOrigin}/v1/notifications/show`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${launch.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'question', sessionId: 'session-1' }),
    })
    expect(shown.status).toBe(200)
    expect(notifications.show).toHaveBeenCalledWith({ kind: 'question', sessionId: 'session-1' })

    const openedPath = join(userDataPath, 'folder')
    const opened = await fetch(`${controlOrigin}/v1/shell/open`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${launch.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: openedPath }),
    })
    expect(opened.status).toBe(200)
    expect(openPath).toHaveBeenCalledWith(openedPath)

    const revealedPath = join(userDataPath, 'artifact.txt')
    const revealed = await fetch(`${controlOrigin}/v1/shell/reveal`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${launch.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: revealedPath }),
    })
    expect(revealed.status).toBe(200)
    expect(revealPath).toHaveBeenCalledWith(revealedPath)

    const rejectedReveal = await fetch(`${controlOrigin}/v1/shell/reveal`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${launch.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: 'relative/artifact.txt' }),
    })
    expect(rejectedReveal.status).toBe(400)
    expect(revealPath).toHaveBeenCalledTimes(1)

    const browserSettings = await fetch(`${controlOrigin}/v1/browser/settings`, {
      headers: { authorization: `Bearer ${launch.controlToken}` },
    })
    expect(browserSettings.status).toBe(200)
    await expect(browserSettings.json()).resolves.toEqual({ settings: browser.state.settings })

    const browserAction = await fetch(`${controlOrigin}/v1/browser/action`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${launch.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'snapshot', sessionId: 'session-1' }),
    })
    expect(browserAction.status).toBe(200)
    expect(browser.handleAgentRequest).toHaveBeenCalledWith({ action: 'snapshot', sessionId: 'session-1' })

    const browserAgentStatus = await fetch(`${controlOrigin}/v1/browser/agent-status`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${launch.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 'session-1', status: 'running' }),
    })
    expect(browserAgentStatus.status).toBe(200)
    expect(browser.updateAgentStatus).toHaveBeenCalledWith({ sessionId: 'session-1', status: 'running' })

    const screenshotResource = await fetch(`${controlOrigin}/v1/browser/screenshot-resources/${'a'.repeat(43)}`, {
      headers: { authorization: `Bearer ${launch.controlToken}` },
    })
    expect(screenshotResource.status).toBe(200)
    expect(screenshotResource.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await screenshotResource.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const clearedScreenshots = await fetch(`${controlOrigin}/v1/browser/screenshots`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${launch.controlToken}` },
    })
    expect(clearedScreenshots.status).toBe(200)
    expect(browser.clearScreenshotCache).toHaveBeenCalledOnce()
    expect(browser.clearBrowsingData).not.toHaveBeenCalled()

  })
})

describe('dsh-desktop-bridge tool', () => {
  it('tells the model to call tools already present in the current request directly', () => {
    expect(STATIC_GUIDANCE).toContain('authoritative callable set for this same turn')
    expect(STATIC_GUIDANCE).toContain('call it directly now')
    expect(STATIC_GUIDANCE).toContain('do not inspect the registry first')
    expect(STATIC_GUIDANCE).toContain('first resumed user turn already receives the rebuilt callable set')
  })

  it('explains desktop Patch overlays without presenting them as plugin installation', () => {
    expect(STATIC_GUIDANCE).toContain('dsh web --patch <file>')
    expect(STATIC_GUIDANCE).toContain('not a separate debug runtime')
    expect(STATIC_GUIDANCE).toContain('does not install dependencies')
    expect(STATIC_GUIDANCE).toContain('dsh plugin --profile web add <package>')
  })

  it('requests the authenticated desktop restart and concludes the current turn', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }))
    const concludeTurn = vi.fn()
    const tool = createRestartTool('http://127.0.0.1:12345/v1/restart-harness', 'secret', fetchImpl)

    await expect(tool.execute({ reason: '加载 greet' }, { concludeTurn })).resolves.toContain('自动重新连接')
    expect(concludeTurn).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/v1/restart-harness',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer secret' }),
        body: JSON.stringify({ reason: '加载 greet' }),
      }),
    )
  })

  it('does not conclude the turn when the desktop rejects the request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      accepted: false,
      message: 'restart unavailable',
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }))
    const concludeTurn = vi.fn()
    const tool = createRestartTool('http://127.0.0.1:12345/v1/restart-harness', 'secret', fetchImpl)

    await expect(tool.execute({}, { concludeTurn })).rejects.toThrow('restart unavailable')
    expect(concludeTurn).not.toHaveBeenCalled()
  })

  it('publishes restart-required context after the active Profile changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-profile-'))
    temporaryPaths.push(root)
    const profilePath = join(root, 'profiles', 'web')
    await mkdir(profilePath, { recursive: true })
    await writeFile(join(profilePath, 'package.json'), '{"dependencies":{}}\n', 'utf8')

    const registeredContexts: Array<{ text: () => string }> = []
    const emit = vi.fn()
    const registerRoute = vi.fn()
    const cleanup = await apply({
      tools: { register: vi.fn() },
      webServer: { register: registerRoute },
      systemPrompt: {
        section: vi.fn(),
        context: vi.fn((context: { text: () => string }) => { registeredContexts.push(context) }),
      },
      on: vi.fn(),
      emit,
    }, {
      controlUrl: 'http://127.0.0.1:12345/v1/restart-harness',
      controlToken: 'secret',
      profilePath,
    })

    expect(registerRoute).toHaveBeenCalledTimes(4)
    expect(registerRoute.mock.calls.map(([route]) => route.path)).toEqual([
      '/api/dsh-desktop/notifications/settings',
      '/api/dsh-desktop/notifications/show',
      '/api/dsh-desktop/shell/open',
      '/api/dsh-desktop/shell/reveal',
    ])

    expect(registeredContexts[0]?.text()).toBe('')
    await writeFile(join(profilePath, 'package.json'), '{"dependencies":{"greet":"1.0.0"}}\n', 'utf8')
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('system-prompt/change'))
    expect(registeredContexts[0]?.text()).toContain('active web Profile changed')
    cleanup()
  })
})
