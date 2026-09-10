import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const notificationMocks = vi.hoisted(() => ({
  supported: true,
  failure: undefined as string | undefined,
  removeHistory: vi.fn<(_id: string, _group: string) => Promise<void>>(async () => undefined),
  instances: [] as Array<EventEmitter & { options: Record<string, unknown>; show: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
}))

vi.mock('../src/main/windows-notification-history.js', () => ({
  removeWindowsNotification: notificationMocks.removeHistory,
}))

vi.mock('electron', async () => {
  const { EventEmitter: MockEventEmitter } = await import('node:events')
  class MockNotification extends MockEventEmitter {
    static isSupported(): boolean { return notificationMocks.supported }
    show = vi.fn(() => queueMicrotask(() => {
      if (notificationMocks.failure === undefined) this.emit('show', {})
      else this.emit('failed', {}, notificationMocks.failure)
    }))
    close = vi.fn(() => this.emit('close', { reason: 'applicationHidden' }))
    constructor(readonly options: Record<string, unknown>) {
      super()
      notificationMocks.instances.push(this)
    }
  }
  return { Notification: MockNotification }
})

import {
  DEFAULT_DESKTOP_NOTIFICATION_SETTINGS,
  DesktopNotificationService,
  readDesktopNotificationSettings,
} from '../src/main/desktop-notifications.js'

const temporaryPaths: string[] = []
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(async () => {
  notificationMocks.supported = true
  notificationMocks.failure = undefined
  notificationMocks.instances.length = 0
  notificationMocks.removeHistory.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.restoreAllMocks()
  await Promise.all(temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

const capability = { token: '12345678-1234-4123-8123-123456789abc', interactionKey: 'approval:tool-1' }

function approvalFixture(platform: NodeJS.Platform = 'win32', answerApproval = vi.fn<(_request: unknown, _decision: unknown) => Promise<'answered' | 'expired'>>(async () => 'answered'), protocolScheme?: string | null) {
  Object.defineProperty(process, 'platform', { value: platform })
  const openSession = vi.fn()
  const service = new DesktopNotificationService('/unused-notification-settings.json', {
    getWindow: () => undefined,
    openSession,
    answerApproval,
  }, protocolScheme)
  return { service, answerApproval, openSession }
}

describe('native approval notification actions', () => {
  it.each([
    ['win32', 0, 'allowed-once'], ['win32', 1, 'rejected'],
    ['darwin', 0, 'allowed-once'], ['darwin', 1, 'rejected'],
  ] as const)('handles %s button %s as %s using event details', async (platform, index, decision) => {
    const { service, answerApproval, openSession } = approvalFixture(platform)
    await expect(service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })).resolves.toBe(true)
    const notification = notificationMocks.instances[0]!
    expect(notification.options.actions).toEqual([
      { type: 'button', text: '允许一次' }, { type: 'button', text: '拒绝' },
    ])
    expect(answerApproval).not.toHaveBeenCalled()
    notification.emit('action', { actionIndex: index }, index === 0 ? 1 : 0)
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(answerApproval).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...capability }, decision)
    expect(openSession).not.toHaveBeenCalled()
    if (platform === 'win32') {
      expect(notificationMocks.removeHistory).toHaveBeenCalledExactlyOnceWith(notification.options.id, 'Notifications')
    } else {
      expect(notificationMocks.removeHistory).not.toHaveBeenCalled()
    }
  })

  it('supports the legacy index, ignores malformed indices and consumes only one native action', async () => {
    let resolve!: (value: 'answered') => void
    const answer = vi.fn<(_request: unknown, _decision: unknown) => Promise<'answered' | 'expired'>>(() => new Promise((finish) => { resolve = finish }))
    const { service, openSession } = approvalFixture('win32', answer)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    notification.emit('action', { actionIndex: 99 }, 0)
    notification.emit('action', { actionIndex: '0' }, 0)
    notification.emit('action', {}, -1)
    expect(answer).not.toHaveBeenCalled()
    notification.emit('action', {}, 1)
    notification.emit('action', { actionIndex: 0 })
    notification.emit('click')
    expect(answer).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...capability }, 'rejected')
    expect(openSession).not.toHaveBeenCalled()
    resolve('answered')
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
  })

  it('opens the session from the body without approving or rejecting', async () => {
    const { service, answerApproval, openSession } = approvalFixture()
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    notificationMocks.instances[0]!.emit('click')
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(answerApproval).not.toHaveBeenCalled()
  })

  it.each(['timedOut', undefined])('keeps approval actions alive after banner close reason %s', async (reason) => {
    const { service, answerApproval } = approvalFixture()
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    notification.emit('close', { reason })
    expect(answerApproval).not.toHaveBeenCalled()
    notification.emit('action', { actionIndex: 0 })
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(answerApproval).toHaveBeenCalledOnce()
  })

  it.each(['userCanceled', 'applicationHidden'])('dismissal %s never answers and releases the notification', async (reason) => {
    const { service, answerApproval } = approvalFixture()
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    notification.emit('close', { reason })
    notification.emit('action', { actionIndex: 1 })
    expect(answerApproval).not.toHaveBeenCalled()
  })

  it('only closes an expired approval without opening the session', async () => {
    const { service, answerApproval, openSession } = approvalFixture('darwin', vi.fn(async () => 'expired' as const))
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    notification.emit('action', { actionIndex: 0 })
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(answerApproval).toHaveBeenCalledOnce()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('logs an answer failure and opens the owning session without retrying', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { service, answerApproval, openSession } = approvalFixture('win32', vi.fn(async () => { throw new Error('gateway unavailable') }))
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    notification.emit('action', { actionIndex: 0 })
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gateway unavailable'))
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1')
    notification.emit('action', { actionIndex: 1 })
    expect(answerApproval).toHaveBeenCalledOnce()
  })

  it.each([
    null, {}, { ...capability, token: 'not-a-uuid' }, { ...capability, interactionKey: '' },
    { ...capability, interactionKey: ' ' }, { ...capability, interactionKey: 'bad\nkey' },
    { ...capability, interactionKey: 'x'.repeat(501) },
  ])('keeps malformed approval capability %o as a plain notification', async (approval) => {
    const { service, answerApproval } = approvalFixture()
    await expect(service.show({ kind: 'approval', sessionId: 'session-1', approval })).resolves.toBe(true)
    const notification = notificationMocks.instances[0]!
    expect(notification.options.actions).toBeUndefined()
    notification.emit('action', { actionIndex: 0 })
    expect(answerApproval).not.toHaveBeenCalled()
  })

  it.each(['question', 'turn-complete', 'plan-review'])('does not expose approval actions for %s', async (kind) => {
    const { service, answerApproval } = approvalFixture()
    await service.show({ kind, sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    expect(notification.options.actions).toBeUndefined()
    notification.emit('action', { actionIndex: 0 })
    expect(answerApproval).not.toHaveBeenCalled()
  })

  it('omits actions on unsupported platforms or without a callback', async () => {
    const { service, answerApproval } = approvalFixture('linux')
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const withoutCallback = new DesktopNotificationService('/unused.json', { getWindow: () => undefined, openSession: vi.fn() })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await withoutCallback.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    for (const notification of notificationMocks.instances) {
      expect(notification.options.actions).toBeUndefined()
      notification.emit('action', { actionIndex: 0 })
    }
    expect(answerApproval).not.toHaveBeenCalled()
  })

  it('rejects invalid requests and unsupported native notification delivery', async () => {
    const { service } = approvalFixture()
    await expect(service.show({ kind: 'approval', sessionId: 'bad\nvalue', approval: capability })).resolves.toBe(false)
    await expect(service.show({ kind: 'unknown', sessionId: 'session-1', approval: capability })).resolves.toBe(false)
    notificationMocks.supported = false
    await expect(service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })).resolves.toBe(false)
    expect(notificationMocks.instances).toHaveLength(0)
  })

  it('bounds retained native instances and closes the oldest without answering', async () => {
    const { service, answerApproval } = approvalFixture()
    for (let index = 0; index < 129; index += 1) {
      await service.show({ kind: 'approval', sessionId: `session-${index}`, approval: capability })
      notificationMocks.instances[index]!.emit('close', { reason: 'timedOut' })
    }
    expect(notificationMocks.instances[0]!.close).toHaveBeenCalledOnce()
    expect(notificationMocks.instances[128]!.close).not.toHaveBeenCalled()
    expect(notificationMocks.removeHistory).toHaveBeenCalledExactlyOnceWith(notificationMocks.instances[0]!.options.id, 'Notifications')
    notificationMocks.instances[0]!.emit('action', { actionIndex: 0 })
    expect(answerApproval).not.toHaveBeenCalled()
  })
})

const notificationScheme = 'dfy-dsh-notification-dev'

function protocolLinks(notification = notificationMocks.instances.at(-1)!) {
  const xml = notification.options.toastXml as string
  expect(typeof xml).toBe('string')
  return {
    xml,
    open: / launch="([^"]+)"/u.exec(xml)![1]!,
    actions: [...xml.matchAll(/<action activationType="protocol" arguments="([^"]+)"/gu)].map((match) => match[1]!),
    dismiss: [...xml.matchAll(/<action activationType="system" arguments="([^"]+)" content="([^"]+)"\/>/gu)]
      .map((match) => ({ arguments: match[1]!, content: match[2]! })),
  }
}

describe('Windows protocol notification actions', () => {
  it('uses distinct opaque nonces and escapes the full toast XML', async () => {
    const { service } = approvalFixture('win32', undefined, notificationScheme)
    await service.show({
      kind: 'approval', sessionId: 'private-session', approval: capability,
      sessionTitle: '<title x="\'"> & 😀\u0001', summary: '命令 "x" & \'y\'\u0002',
    })
    const notification = notificationMocks.instances[0]!
    const { xml, open, actions } = protocolLinks(notification)
    expect(notification.options.actions).toBeUndefined()
    expect(new Set([open, ...actions]).size).toBe(3)
    for (const link of [open, ...actions]) {
      expect(link).toMatch(/^dfy-dsh-notification-dev:\/\/action\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    }
    expect(xml).toBe(`<toast activationType="protocol" launch="${open}">`
      + '<visual><binding template="ToastGeneric"><text>&lt;title x=&quot;&apos;&quot;&gt; &amp; 😀</text>'
      + '<text>审批 · 命令 &quot;x&quot; &amp; &apos;y&apos;</text></binding></visual>'
      + `<actions><action activationType="protocol" arguments="${actions[0]}" content="允许一次"/>`
      + `<action activationType="protocol" arguments="${actions[1]}" content="拒绝"/></actions></toast>`)
    expect(xml).not.toContain('private-session')
    expect(xml).not.toContain(capability.token)
    expect(xml).not.toContain(capability.interactionKey)
  })

  it.each([[0, 'allowed-once'], [1, 'rejected']] as const)('handles protocol button %s as %s', async (index, decision) => {
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    const { actions } = protocolLinks(notification)
    expect(service.handleProtocolActivation(actions[index]!)).toBe(true)
    expect(answerApproval).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...capability }, decision)
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(openSession).not.toHaveBeenCalled()
  })

  it.each(['userCanceled', 'applicationHidden', 'timedOut', undefined])('keeps protocol actions alive when close %s precedes activation', async (reason) => {
    const { service, answerApproval } = approvalFixture('win32', undefined, notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    const { actions } = protocolLinks(notification)
    notification.emit('close', { reason })
    expect(answerApproval).not.toHaveBeenCalled()
    expect(service.handleProtocolActivation(actions[0]!)).toBe(true)
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(answerApproval).toHaveBeenCalledOnce()
  })

  it('opens the body only once while retaining its approval buttons', async () => {
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    const { open, actions } = protocolLinks(notification)
    notification.emit('close', { reason: 'userCanceled' })
    expect(service.handleProtocolActivation(open)).toBe(true)
    expect(service.handleProtocolActivation(open)).toBe(true)
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(answerApproval).not.toHaveBeenCalled()
    expect(service.handleProtocolActivation(actions[1]!)).toBe(true)
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(answerApproval).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...capability }, 'rejected')
  })

  it('consumes every sibling nonce synchronously before an asynchronous answer completes', async () => {
    let resolve!: (value: 'answered') => void
    const answer = vi.fn<(_request: unknown, _decision: unknown) => Promise<'answered' | 'expired'>>(() => new Promise((finish) => { resolve = finish }))
    const { service, openSession } = approvalFixture('win32', answer, notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    const { open, actions } = protocolLinks(notification)
    service.handleProtocolActivation(actions[0]!)
    for (const link of [actions[0]!, actions[1]!, open]) expect(service.handleProtocolActivation(link)).toBe(true)
    notification.emit('click')
    notification.emit('action', { actionIndex: 1 })
    expect(answer).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...capability }, 'allowed-once')
    expect(openSession).not.toHaveBeenCalled()
    resolve('answered')
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(service.handleProtocolActivation(actions[1]!)).toBe(true)
    expect(answer).toHaveBeenCalledOnce()
  })

  it('keeps native activation events from taking the wrong protocol action', async () => {
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    notification.emit('click')
    notification.emit('action', { actionIndex: 0 })
    expect(answerApproval).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('recognizes expired or unknown nonces without approving or opening a session', async () => {
    const { service, answerApproval, openSession } = approvalFixture('win32', vi.fn(async () => 'expired' as const), notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    const { open, actions } = protocolLinks(notification)
    expect(service.handleProtocolActivation(`${notificationScheme}://action/${capability.token}`)).toBe(true)
    expect(answerApproval).not.toHaveBeenCalled()
    service.handleProtocolActivation(actions[0]!)
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(service.handleProtocolActivation(open)).toBe(true)
    expect(service.handleProtocolActivation(actions[1]!)).toBe(true)
    expect(answerApproval).toHaveBeenCalledOnce()
    expect(openSession).not.toHaveBeenCalled()
    const restarted = approvalFixture('win32', undefined, notificationScheme)
    expect(restarted.service.handleProtocolActivation(actions[0]!)).toBe(true)
    expect(restarted.answerApproval).not.toHaveBeenCalled()
  })

  it('rejects altered schemes, hosts, paths, credentials, ports, encodings, queries and fragments', async () => {
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const link = protocolLinks().actions[0]!
    const nonce = link.slice(link.lastIndexOf('/') + 1)
    for (const invalid of [
      link.replace(notificationScheme, 'https'), link.replace(notificationScheme, 'dfy-dsh-notification'),
      link.replace('://action/', '://other/'), link.replace('://action/', '://user@action/'),
      link.replace('://action/', '://action:42/'), link.replace('://action/', ':///action/'),
      link.replace('://action/', '://action/../action/'), link.replace('://action/', '://action//'),
      link.replace('://action/', ':\\\\action\\'), `${notificationScheme}://action/%${nonce.charCodeAt(0).toString(16)}${nonce.slice(1)}`,
      `${link}/`, `${link}/extra`, `${link}?`, `${link}?a=1`, `${link}#`, `${link}#hash`,
      `${link}\n`, `${link}\0`, ` ${link}`, `${notificationScheme}://action/not-a-uuid`,
      `${notificationScheme}://action/12345678-1234-1123-8123-123456789abc`,
    ]) expect(service.handleProtocolActivation(invalid), invalid).toBe(false)
    expect(answerApproval).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
    service.handleProtocolActivation(link)
    await vi.waitFor(() => expect(answerApproval).toHaveBeenCalledOnce())
  })

  it('preserves native macOS actions even when a Windows protocol scheme is supplied', async () => {
    const { service, answerApproval } = approvalFixture('darwin', undefined, notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    expect(notification.options.toastXml).toBeUndefined()
    expect(notification.options.actions).toHaveLength(2)
    expect(service.handleProtocolActivation(`${notificationScheme}://action/${capability.token}`)).toBe(false)
    notification.emit('action', { actionIndex: 1 })
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(answerApproval).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...capability }, 'rejected')
  })

  it.each([undefined, 'invalid scheme', 'bad"scheme'])('uses the native fallback without a valid registered scheme: %s', async (scheme) => {
    const { service } = approvalFixture('win32', undefined, scheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    expect(notificationMocks.instances[0]!.options.toastXml).toBeUndefined()
    expect(notificationMocks.instances[0]!.options.actions).toHaveLength(2)
  })

  it('disables Windows approval buttons explicitly when protocol registration fails', async () => {
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, null)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    expect(notification.options.toastXml).toContain('<action activationType="system" arguments="dismiss" content="关闭"/>')
    expect(notification.options.toastXml).not.toContain('activationType="protocol"')
    expect(notification.options.toastXml).not.toContain('允许一次')
    expect(notification.options.toastXml).not.toContain('拒绝')
    expect(notification.options.actions).toBeUndefined()
    notification.emit('action', { actionIndex: 0 })
    expect(answerApproval).not.toHaveBeenCalled()
    notification.emit('click')
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1')
  })

  it('retains macOS native approval buttons with an explicitly unavailable Windows protocol', async () => {
    const { service, answerApproval } = approvalFixture('darwin', undefined, null)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    expect(notification.options.toastXml).toBeUndefined()
    expect(notification.options.actions).toHaveLength(2)
    notification.emit('action', { actionIndex: 0 })
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(answerApproval).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...capability }, 'allowed-once')
  })

  it('offers a protocol body link and system dismissal without valid approval capability', async () => {
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, notificationScheme)
    for (const kind of ['approval', 'question', 'plan-review', 'turn-complete']) {
      await service.show({ kind, sessionId: 'session-1' })
      const { open, actions, dismiss } = protocolLinks()
      expect(actions).toHaveLength(0)
      expect(dismiss).toEqual([{ arguments: 'dismiss', content: '关闭' }])
      expect(service.handleProtocolActivation('dismiss')).toBe(false)
      expect(service.handleProtocolActivation(open)).toBe(true)
    }
    expect(answerApproval).not.toHaveBeenCalled()
    expect(openSession).toHaveBeenCalledTimes(4)
  })

  it('discards all evicted notification nonces while leaving other notifications actionable', async () => {
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, notificationScheme)
    for (let index = 0; index < 129; index += 1) {
      await service.show({ kind: 'approval', sessionId: `session-${index}`, approval: capability })
      notificationMocks.instances[index]!.emit('close', { reason: 'userCanceled' })
    }
    const first = protocolLinks(notificationMocks.instances[0]!)
    for (const link of [first.open, ...first.actions]) expect(service.handleProtocolActivation(link)).toBe(true)
    expect(notificationMocks.instances[0]!.close).toHaveBeenCalledOnce()
    expect(answerApproval).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
    service.handleProtocolActivation(protocolLinks(notificationMocks.instances[128]!).actions[1]!)
    await vi.waitFor(() => expect(notificationMocks.instances[128]!.close).toHaveBeenCalledOnce())
    expect(answerApproval).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-128', ...capability }, 'rejected')
  })

  it('clears nonces when native delivery fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, notificationScheme)
    notificationMocks.failure = 'native delivery unavailable'
    await expect(service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })).resolves.toBe(false)
    expect(notificationMocks.removeHistory).toHaveBeenCalledExactlyOnceWith(notificationMocks.instances[0]!.options.id, 'Notifications')
    const { open, actions } = protocolLinks()
    for (const link of [open, ...actions]) expect(service.handleProtocolActivation(link)).toBe(true)
    expect(answerApproval).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('logs a protocol answer failure and opens only its owning session without retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { service, answerApproval, openSession } = approvalFixture('win32', vi.fn(async () => { throw new Error('gateway unavailable') }), notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    const { actions } = protocolLinks(notification)
    service.handleProtocolActivation(actions[0]!)
    await vi.waitFor(() => expect(notification.close).toHaveBeenCalledOnce())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gateway unavailable'))
    expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(service.handleProtocolActivation(actions[1]!)).toBe(true)
    expect(answerApproval).toHaveBeenCalledOnce()
  })
})

describe('Windows notification history cleanup', () => {
  it.each([
    [0, 'allowed-once', 'answered'], [1, 'rejected', 'answered'],
    [0, 'allowed-once', 'expired'], [1, 'rejected', 'expired'],
    [0, 'allowed-once', 'throws'], [1, 'rejected', 'throws'],
  ] as const)('removes only the consumed notification for button %s with outcome %s / %s', async (index, decision, outcome) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const answer = vi.fn(async (): Promise<'answered' | 'expired'> => {
      if (outcome === 'throws') throw new Error('gateway unavailable')
      return outcome
    })
    const { service, openSession } = approvalFixture('win32', answer, notificationScheme)
    for (const sessionId of ['session-1', 'session-2']) {
      await service.show({ kind: 'approval', sessionId, key: 'same-display-key', approval: capability })
    }
    const [first, other] = notificationMocks.instances
    const firstLinks = protocolLinks(first!)
    const otherLinks = protocolLinks(other!)
    for (const notification of [first!, other!]) {
      expect(notification.options.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
      expect(notification.options.groupId).toBe('Notifications')
      expect(notification.options).not.toHaveProperty('tag')
    }
    expect(first!.options.id).not.toBe(other!.options.id)
    first!.emit('close', { reason: 'userCanceled' })
    expect(notificationMocks.removeHistory).not.toHaveBeenCalled()

    expect(service.handleProtocolActivation(firstLinks.actions[index]!)).toBe(true)
    await vi.waitFor(() => expect(notificationMocks.removeHistory)
      .toHaveBeenCalledExactlyOnceWith(first!.options.id, 'Notifications'))
    expect(first!.close).toHaveBeenCalledOnce()
    expect(other!.close).not.toHaveBeenCalled()
    expect(answer).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...capability }, decision)
    if (outcome === 'throws') expect(openSession).toHaveBeenCalledExactlyOnceWith('session-1')
    else expect(openSession).not.toHaveBeenCalled()

    for (const link of [firstLinks.open, ...firstLinks.actions]) service.handleProtocolActivation(link)
    first!.emit('action', { actionIndex: 1 })
    first!.emit('click')
    expect(answer).toHaveBeenCalledOnce()
    expect(first!.close).toHaveBeenCalledOnce()
    expect(notificationMocks.removeHistory).toHaveBeenCalledOnce()

    service.handleProtocolActivation(otherLinks.actions[1]!)
    await vi.waitFor(() => expect(notificationMocks.removeHistory).toHaveBeenCalledTimes(2))
    expect(notificationMocks.removeHistory).toHaveBeenNthCalledWith(2, other!.options.id, 'Notifications')
    expect(answer).toHaveBeenNthCalledWith(2, { sessionId: 'session-2', ...capability }, 'rejected')
  })

  it('does not retry an approval when exact history removal fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    notificationMocks.removeHistory.mockRejectedValueOnce(new Error('history unavailable'))
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    const { open, actions } = protocolLinks(notification)
    service.handleProtocolActivation(actions[0]!)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('unable to remove notification')))
    for (const link of [open, ...actions]) service.handleProtocolActivation(link)
    expect(answerApproval).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1', ...capability }, 'allowed-once')
    expect(notificationMocks.removeHistory).toHaveBeenCalledExactlyOnceWith(notification.options.id, 'Notifications')
    expect(notification.close).toHaveBeenCalledOnce()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('still removes the history entry when native close throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { service, answerApproval } = approvalFixture('win32', undefined, notificationScheme)
    await service.show({ kind: 'approval', sessionId: 'session-1', approval: capability })
    const notification = notificationMocks.instances[0]!
    notification.close.mockImplementation(() => { throw new Error('native close unavailable') })
    const { actions } = protocolLinks(notification)
    service.handleProtocolActivation(actions[1]!)
    await vi.waitFor(() => expect(notificationMocks.removeHistory)
      .toHaveBeenCalledExactlyOnceWith(notification.options.id, 'Notifications'))
    service.handleProtocolActivation(actions[0]!)
    expect(answerApproval).toHaveBeenCalledOnce()
    expect(notification.close).toHaveBeenCalledOnce()
  })
})

describe('plain notification dismissal', () => {
  it.each([notificationScheme, undefined, null])('offers Windows system dismissal with protocol availability %s', async (scheme) => {
    const { service, answerApproval, openSession } = approvalFixture('win32', undefined, scheme)
    await service.show({ kind: 'question', sessionId: 'session-1' })
    const notification = notificationMocks.instances[0]!
    const xml = notification.options.toastXml as string
    expect(xml).toContain('<action activationType="system" arguments="dismiss" content="关闭"/>')
    expect(xml).not.toContain('content="允许一次"')
    expect(xml).not.toContain('content="拒绝"')
    expect(notification.options.actions).toBeUndefined()
    if (scheme === notificationScheme) expect(protocolLinks(notification).actions).toEqual([])
    else expect(xml).not.toContain('activationType="protocol"')
    expect(service.handleProtocolActivation('dismiss')).toBe(false)
    notification.emit('action', { actionIndex: 0 })
    notification.emit('close', { reason: 'userCanceled' })
    expect(openSession).not.toHaveBeenCalled()
    expect(answerApproval).not.toHaveBeenCalled()
    expect(notificationMocks.removeHistory).not.toHaveBeenCalled()
  })

  it.each(['approval', 'question', 'plan-review', 'turn-complete'])('closes a plain macOS %s notification without opening or answering', async (kind) => {
    const { service, answerApproval, openSession } = approvalFixture('darwin')
    await service.show({ kind, sessionId: 'session-1' })
    await service.show({ kind, sessionId: 'session-2' })
    const [notification, other] = notificationMocks.instances
    expect(notification!.options.actions).toEqual([{ type: 'button', text: '关闭' }])
    expect(notification!.options.toastXml).toBeUndefined()
    expect(notification!.options.groupId).toBeUndefined()
    for (const index of [-1, 1, '0']) notification!.emit('action', { actionIndex: index }, 0)
    expect(notification!.close).not.toHaveBeenCalled()
    notification!.emit('action', {}, 0)
    notification!.emit('action', { actionIndex: 0 })
    notification!.emit('click')
    expect(notification!.close).toHaveBeenCalledOnce()
    expect(other!.close).not.toHaveBeenCalled()
    expect(openSession).not.toHaveBeenCalled()
    expect(answerApproval).not.toHaveBeenCalled()
    expect(notificationMocks.removeHistory).not.toHaveBeenCalled()
  })

  it('does not add a platform dismissal action on Linux', async () => {
    const { service, answerApproval, openSession } = approvalFixture('linux')
    for (const kind of ['approval', 'question', 'plan-review', 'turn-complete']) {
      await service.show({ kind, sessionId: 'session-1' })
      const notification = notificationMocks.instances.at(-1)!
      expect(notification.options.actions).toBeUndefined()
      expect(notification.options.toastXml).toBeUndefined()
      expect(notification.options.groupId).toBeUndefined()
      notification.emit('action', { actionIndex: 0 })
      expect(notification.close).not.toHaveBeenCalled()
    }
    expect(openSession).not.toHaveBeenCalled()
    expect(answerApproval).not.toHaveBeenCalled()
    expect(notificationMocks.removeHistory).not.toHaveBeenCalled()
  })
})

describe('DesktopNotificationService', () => {
  it('persists normalized settings with desktop defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-notifications-'))
    temporaryPaths.push(root)
    const path = join(root, 'notifications.json')
    expect(await readDesktopNotificationSettings(path)).toEqual(DEFAULT_DESKTOP_NOTIFICATION_SETTINGS)

    const service = new DesktopNotificationService(path, {
      getWindow: () => undefined,
      openSession: vi.fn(),
    })
    await service.initialize()
    await expect(service.updateSettings({
      turnCompletion: 'always',
      permissionRequests: false,
      questions: true,
    })).resolves.toEqual({
      turnCompletion: 'always',
      permissionRequests: false,
      questions: true,
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(service.currentSettings)
  })

  it('notifies on configured transitions and opens the owning session on click', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-notifications-'))
    temporaryPaths.push(root)
    const openSession = vi.fn()
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isFocused: () => false,
    }
    const service = new DesktopNotificationService(join(root, 'notifications.json'), {
      getWindow: () => window as never,
      openSession,
    })
    await service.initialize()

    await expect(service.show({
      kind: 'turn-complete',
      sessionId: 'session-1',
      sessionTitle: '测试对话',
      summary: '**你的图片** [已可查看](https://example.com/image)。',
      key: 'turn:session-1:2',
    })).resolves.toBe(true)
    const notification = notificationMocks.instances[0]
    expect(notification?.options).toMatchObject({
      title: '测试对话',
      body: '你的图片 已可查看。',
    })
    expect(notification?.options.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(notification?.options).not.toHaveProperty('tag')
    expect(notification?.show).toHaveBeenCalledOnce()
    notification?.emit('click')
    expect(openSession).toHaveBeenCalledWith('session-1')
  })

  it('suppresses completion while focused and honors interaction toggles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-notifications-'))
    temporaryPaths.push(root)
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isFocused: () => true,
    }
    const service = new DesktopNotificationService(join(root, 'notifications.json'), {
      getWindow: () => window as never,
      openSession: vi.fn(),
    })
    await service.initialize()

    await expect(service.show({ kind: 'turn-complete', sessionId: 'session-1' })).resolves.toBe(false)
    await expect(service.show({ kind: 'approval', sessionId: 'session-1' })).resolves.toBe(true)
    await service.updateSettings({ turnCompletion: 'never', permissionRequests: false, questions: false })
    await expect(service.show({ kind: 'approval', sessionId: 'session-1' })).resolves.toBe(false)
    await expect(service.show({ kind: 'question', sessionId: 'session-1' })).resolves.toBe(false)
  })

  it('falls back to a concise completion body when the reply has no text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-notifications-'))
    temporaryPaths.push(root)
    const service = new DesktopNotificationService(join(root, 'notifications.json'), {
      getWindow: () => undefined,
      openSession: vi.fn(),
    })

    await expect(service.show({
      kind: 'turn-complete',
      sessionId: 'session-1',
      sessionTitle: '图片任务',
    })).resolves.toBe(true)
    expect(notificationMocks.instances[0]?.options).toMatchObject({
      title: '图片任务',
      body: '回复已完成。',
    })
  })

  it('uses the conversation title with approval, question, and plan summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-notifications-'))
    temporaryPaths.push(root)
    const service = new DesktopNotificationService(join(root, 'notifications.json'), {
      getWindow: () => undefined,
      openSession: vi.fn(),
    })

    await service.show({ kind: 'approval', sessionId: 'session-1', sessionTitle: '构建插件', summary: 'Bash：运行测试' })
    await service.show({ kind: 'question', sessionId: 'session-1', sessionTitle: '构建插件', summary: '请选择输出尺寸' })
    await service.show({ kind: 'plan-review', sessionId: 'session-1', sessionTitle: '构建插件', summary: '请审核实施计划' })

    expect(notificationMocks.instances.map((item) => item.options)).toEqual([
      expect.objectContaining({ title: '构建插件', body: '审批 · Bash：运行测试' }),
      expect.objectContaining({ title: '构建插件', body: '提问 · 请选择输出尺寸' }),
      expect.objectContaining({ title: '构建插件', body: '确认 · 请审核实施计划' }),
    ])
  })

  it('reports a native notification failure instead of treating show() as delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-notifications-'))
    temporaryPaths.push(root)
    notificationMocks.failure = 'application is not signed'
    const service = new DesktopNotificationService(join(root, 'notifications.json'), {
      getWindow: () => undefined,
      openSession: vi.fn(),
    })

    await expect(service.show({ kind: 'approval', sessionId: 'session-1' })).resolves.toBe(false)
  })

})
