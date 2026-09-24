import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalWindow = globalThis.window

afterEach(() => {
  vi.resetModules()
  Object.assign(globalThis, { window: originalWindow })
})

async function loadClientModule(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  let factory: ((require: (id: string) => unknown) => Record<string, unknown>) | undefined
  Object.assign(globalThis, {
    window: {
      __ModuleLoader__: {
        load: (entry: { factory: typeof factory }) => { factory = entry.factory },
      },
    },
  })
  await import('../resources/dsh-desktop-bridge/lib/client.js')
  if (factory === undefined) throw new Error('Client bundle did not register its module factory')
  return factory((id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id]
    if (id === '@deepseek-ai/cordis') {
      return {
        Service: class Service {
          protected ctx: Record<string, unknown>
          name: string

          constructor(ctx: Record<string, unknown>, name: string) {
            this.ctx = ctx
            this.name = name
            ctx[name] = this
          }
        },
      }
    }
    if (id === 'react') return {}
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected client dependency: ${id}`)
  })
}

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    listeners,
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of [...listeners]) listener() },
  }
}

it('bridges official plugin switches and withdraws only its own transport on reload', async () => {
  const client = await loadClientModule()
  const install = client.installPluginManagerTransport as (remote: unknown) => () => void
  const outcome = { changed: true, application: 'applied' }
  const setBundleEnabled = vi.fn(async () => ({ ok: true, value: outcome }))
  const key = Symbol.for('dsh.desktop.plugin-manager.transport.v1')
  const target = window as unknown as Record<symbol, { setBundleEnabled(name: string, enabled: boolean): Promise<unknown> }>
  const first = install({ pluginManager: { setBundleEnabled } })
  expect(await target[key]!.setBundleEnabled('@dfy-plugins/dsh-wallpaper', false)).toEqual(outcome)
  expect(setBundleEnabled).toHaveBeenCalledExactlyOnceWith('@dfy-plugins/dsh-wallpaper', false)
  const second = install({ pluginManager: { setBundleEnabled } })
  first()
  expect(target[key]).toBeDefined()
  setBundleEnabled.mockRejectedValueOnce(new Error('permission denied'))
  await expect(target[key]!.setBundleEnabled('demo', true)).rejects.toThrow('permission denied')
  second()
  expect(target[key]).toBeUndefined()
})

function chatSnapshot(nodes: Array<Record<string, unknown>>) {
  const entries = nodes.map((node, index) => ({
    key: String(node.seq ?? index), kind: 'assistant-step', data: { blocks: node.blocks ?? [] },
  }))
  return { order: entries.map(node => node.key), nodes: new Map(entries.map(node => [node.key, node])) }
}

function notificationContext() {
  const list = observable({ byId: { one: { displayTitle: '测试对话', updatedAt: 1 } } } as { byId: Record<string, Record<string, unknown>> })
  const statuses = observable(new Map<string, Record<string, unknown>>([['one', { running: true }]]))
  const chat = observable(chatSnapshot([]))
  const interactions = {
    set(value: Map<string, Record<string, unknown>>) {
      statuses.set(new Map([...statuses.getSnapshot()].map(([id, status]) => [id, { ...status, pendingInteraction: value.get(id) }])))
    },
  }
  const cleanups: Array<() => void> = []
  const ctx = {
    locale: { resolveText: vi.fn((text: Record<string, string>) => text.zh ?? text.en) },
    sessions: { list, binding: () => ({}) },
    uiSession: { sessionStatus: statuses },
    uiConversation: { binding: () => ({ activate: vi.fn(), target: () => chat }) },
    effect(setup: () => () => void) { const cleanup = setup(); cleanups.push(cleanup); return cleanup },
  }
  return { ctx, list, statuses, interactions, chat, dispose: () => { for (const cleanup of cleanups.splice(0)) cleanup() } }

}

type NotificationApproval = { token: string; interactionKey: string }
type ApprovalTransport = { answer(request: unknown): Promise<'answered' | 'expired'> }

function approvalTransport(client: Record<string, unknown>): ApprovalTransport | undefined {
  return Reflect.get(window, Symbol.for(String(client.NOTIFICATION_APPROVAL_TRANSPORT_KEY))) as ApprovalTransport | undefined
}

function loadOfficialApprovalClient(): { apply(ctx: unknown): void } {
  const dshRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
  const packageUrl = pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-client-ui-approval/package.json'))
  let factory: ((require: (id: string) => unknown) => { apply(ctx: unknown): void }) | undefined
  runInNewContext(readFileSync(new URL('lib/client.js', packageUrl), 'utf8'), {
    window: { __ModuleLoader__: { load: (entry: { factory: typeof factory }) => { factory = entry.factory } } },
  })
  if (factory === undefined) throw new Error('Official approval bundle did not register')
  return factory((id) => {
    if (id === 'react' || id === 'react/jsx-runtime' || id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected approval dependency: ${id}`)
  })
}

describe('desktop notification session transitions', () => {
  it('reports missing session selection and preserves successful navigation and cleanup', async () => {
    const client = await loadClientModule()
    const install = client.installSessionOpenFeedback as (sessions: { openSession(id: string): void }, report: (message: string) => void) => () => void
    const report = vi.fn()
    const sessions = {
      current: '',
      openSession(id: string) {
        if (id === 'missing') throw new Error('sessions.select: unknown session missing')
        this.current = id
      },
    }
    const original = sessions.openSession
    const dispose = install(sessions, report)
    expect(() => sessions.openSession('missing')).not.toThrow()
    expect(report).toHaveBeenCalledWith(expect.stringContaining('当前没有对应的会话记录'))
    sessions.openSession('existing')
    expect(sessions.current).toBe('existing')
    expect(report).toHaveBeenCalledTimes(1)
    dispose()
    expect(sessions.openSession).toBe(original)
  })

  it('provides the context-menu registry as a lifecycle-owned Cordis Service', async () => {
    const client = await loadClientModule()
    const DesktopContextMenuService = client.DesktopContextMenuService as new (ctx: Record<string, unknown>) => {
      name: string
      version: number
      icons: readonly string[]
      register(value: Record<string, unknown>): () => void
    }
    const cleanups: Array<() => unknown> = []
    const ctx: Record<string, unknown> = {
      effect: vi.fn((setup: () => () => unknown) => {
        const cleanup = setup()
        cleanups.push(cleanup)
        return cleanup
      }),
    }
    const service = new DesktopContextMenuService(ctx)
    expect(ctx.desktopContextMenu).toBe(service)
    expect(service.name).toBe('desktopContextMenu')
    expect(service.version).toBe(1)
    expect(service.icons).toContain('archive')
    const contribution = {
      id: 'archive-manager.archive-session',
      label: '归档当前会话',
      icon: 'archive',
      onSelect: vi.fn(),
    }
    const dispose = service.register(contribution)
    expect(() => service.register(contribution)).toThrow(/Duplicate context menu contribution/u)
    expect(dispose()).toBeUndefined()
    expect(() => service.register(contribution)).not.toThrow()
    expect(cleanups).toHaveLength(2)
  })

  it('publishes the desktop menu Service through the official inspect registry contract', async () => {
    const client = await loadClientModule()
    const createProvider = client.createDesktopContextMenuInspectProvider as () => {
      manifest: { id: string; methods: Array<{ name: string }> }
      query(method: string): Promise<Record<string, unknown>>
    }
    const provider = createProvider()
    expect(provider.manifest).toMatchObject({
      id: 'DesktopContextMenu',
      methods: [{ name: 'describe' }],
    })
    await expect(provider.query('describe')).resolves.toMatchObject({
      service: 'desktopContextMenu',
      access: { hardDependency: { inject: ['desktopContextMenu'] } },
    })
  })

  it('binds menu registrations to the calling Fiber with the real Cordis runtime', async () => {
    const projectRequire = createRequire(import.meta.url)
    const dshRequire = createRequire(projectRequire.resolve('@deepseek-ai/dsh/package.json'))
    const cordis = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis')).href) as {
      Context: new () => {
        fiber: { dispose(): Promise<void> }
        plugin(plugin: unknown): Promise<{ dispose(): Promise<void> }>
        desktopContextMenu: { register(value: Record<string, unknown>): () => void }
      }
    }
    const client = await loadClientModule({ '@deepseek-ai/cordis': cordis })
    const DesktopContextMenuService = client.DesktopContextMenuService as new (ctx: unknown) => unknown
    const root = new cordis.Context()
    await root.plugin(DesktopContextMenuService)

    const contribution = {
      id: 'fiber-owned.action',
      label: 'Fiber action',
      onSelect: vi.fn(),
    }
    const consumer = Object.assign((ctx: typeof root) => {
      ctx.desktopContextMenu.register(contribution)
    }, { inject: ['desktopContextMenu'] })
    const consumerFiber = await root.plugin(consumer)
    expect(() => root.desktopContextMenu.register(contribution)).toThrow(/Duplicate context menu contribution/u)

    await consumerFiber.dispose()
    expect(() => root.desktopContextMenu.register(contribution)).not.toThrow()
    await root.fiber.dispose()
  })

  it('uses unified status independently of the session list and ignores unknown running state', async () => {
    const client = await loadClientModule()
    const project = client.projectSessions as (list: unknown, statuses: unknown) => Map<string, unknown>
    const diff = client.diffSessionNotifications as (before: unknown, after: unknown) => unknown[]
    const list = { byId: { one: { displayTitle: '测试', running: false, updatedAt: 3 } } }
    const running = project(list, new Map([['one', { running: true }]]))
    expect(diff(new Map(), running)).toEqual([])
    expect(diff(running, project(list, new Map([['one', { running: undefined }]])))).toEqual([])
    expect(diff(running, project(list, new Map([['one', { running: false }]])))).toMatchObject([{ kind: 'turn-complete' }])
    expect(diff(running, project(list, new Map([['one', { running: false, pendingInteraction: { kind: 'approval', key: 'a' } }]])))).toMatchObject([{ kind: 'approval' }])
  })

  it('extracts text from current Chat nodes and waits for a new assistant key', async () => {
    const client = await loadClientModule()
    const latest = client.latestAssistantReply as (binding: unknown) => string | undefined
    const marker = client.latestAssistantMarker as (binding: unknown) => unknown
    const wait = client.waitForAssistantReply as (binding: unknown, baseline: unknown, timeout: number) => Promise<string | undefined>
    const chat = observable(chatSnapshot([{ seq: 1, blocks: [{ kind: 'text', text: '旧回复' }] }]))
    const binding = { chat }
    expect(latest(binding)).toBe('旧回复')
    const pending = wait(binding, marker(binding), 100)
    chat.set(chatSnapshot([{ seq: 2, blocks: [{ kind: 'reasoning', text: '内部思考' }, { kind: 'text', text: ' 新回复 ' }] }]))
    await expect(pending).resolves.toBe('新回复')
    expect(chat.listeners.size).toBe(0)
    chat.set(chatSnapshot([{ seq: 3, blocks: [{ kind: 'image' }] }]))
    expect(latest(binding)).toBeUndefined()
  })

  it('deduplicates interaction keys, summarizes questions and cancels delayed completions', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    const interaction = { kind: 'question', key: 'q1', questions: [{ header: '尺寸', question: '选择哪种尺寸？' }] }
    source.interactions.set(new Map([['one', interaction]]))
    source.interactions.set(new Map([['one', interaction]]))
    source.interactions.set(new Map([['one', { ...interaction, key: 'q2', kind: 'plan-review', questions: [{ question: '审核计划', intent: { kind: 'plan-review' } }] }]]))
    expect(send.mock.calls.map(([v]) => v)).toMatchObject([{ kind: 'question', summary: '选择哪种尺寸？' }, { kind: 'plan-review', summary: '审核计划' }])
    source.statuses.set(new Map([['one', { running: false }]]))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(source.chat.listeners.size).toBe(1)
    source.statuses.set(new Map([['one', { running: true }]]))
    source.chat.set(chatSnapshot([{ seq: 2, blocks: [{ kind: 'text', text: '新轮次回复' }] }]))
    source.statuses.set(new Map([['one', { running: false }]]))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(send.mock.calls.map(([v]) => v)).toMatchObject([{ kind: 'question' }, { kind: 'plan-review' }, { kind: 'turn-complete', summary: '新轮次回复' }])
    source.statuses.set(new Map([['one', { running: true }]]))
    source.statuses.set(new Map([['one', { running: false }]]))
    await new Promise(resolve => setTimeout(resolve, 10))
    source.dispose()
    expect(source.chat.listeners.size).toBe(0)
    expect(source.statuses.listeners.size).toBe(0)
    expect(source.list.listeners.size).toBe(0)
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it.each(['allowed-once', 'rejected'] as const)('answers the real 0.1.7 PendingApproval once with %s', async (decision) => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    let requestApproval: ((request: Record<string, unknown>, next: () => Promise<string>) => Promise<string>) | undefined
    loadOfficialApprovalClient().apply({
      effect: (setup: () => unknown) => setup(),
      inject: (dependencies: string[]) => { expect(dependencies).toEqual(['shortcuts']) },
      locale: { ...source.ctx.locale, register: () => () => {} },
      slots: { inject: () => {} },
      sessions: { scopeOf: () => 'one' },
      remote: { $on: (_name: string, handler: typeof requestApproval) => { requestApproval = handler } },
      uiSession: { registerPendingInteraction: () => (pending: Record<string, unknown>) => {
        source.interactions.set(new Map([['one', pending]]))
        return () => { source.interactions.set(new Map()) }
      } },
    })
    if (requestApproval === undefined) throw new Error('Official approval handler did not register')
    const outcome = requestApproval({ toolName: 'desktop_restart_harness', reason: 'Auto review denied this call.',
      displayReason: { en: 'Auto review denied this call.', zh: '自动审阅拒绝了此调用。' } }, async () => 'delegated')
    const notification = send.mock.calls[0]?.[0] as { approval: NotificationApproval; summary: string }
    expect(notification.summary).toBe('desktop_restart_harness：自动审阅拒绝了此调用。')
    expect(notification.approval).toEqual({ token: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u), interactionKey: 'approval:1' })
    const transport = approvalTransport(client)!
    const command = { sessionId: 'one', ...notification.approval, decision }
    await expect(Promise.all([transport.answer(command), transport.answer(command)])).resolves.toEqual(['answered', 'expired'])
    await expect(outcome).resolves.toBe(decision)
    expect(source.statuses.getSnapshot().get('one')?.pendingInteraction).toBeUndefined()
    source.dispose()
    expect(approvalTransport(client)).toBeUndefined()
  })

  it('uses the current interface language without replacing the audited approval reason', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    let language = 'zh'
    source.ctx.locale.resolveText.mockImplementation(text => text[language] ?? text.en)
    install(source.ctx, send)
    const approval = { kind: 'approval', key: 'first', reason: 'Audited reason',
      displayReason: { en: 'Review denied', zh: '审阅拒绝' } }
    source.interactions.set(new Map([['one', approval]]))
    language = 'en'
    source.interactions.set(new Map([['one', { ...approval, key: 'second' }]]))
    source.interactions.set(new Map([['one', { ...approval, key: 'legacy', displayReason: undefined }]]))
    source.ctx.locale.resolveText.mockImplementation(() => { throw new Error('Locale unavailable') })
    source.interactions.set(new Map([['one', { ...approval, key: 'fallback' }]]))
    expect(send.mock.calls.map(([value]) => value)).toMatchObject([
      { summary: '审阅拒绝' }, { summary: 'Review denied' }, { summary: 'Audited reason' }, { summary: 'Audited reason' },
    ])
    expect(approval.reason).toBe('Audited reason')
    source.dispose()
  })

  it('expires replaced objects and removed requests without ever answering the new approval', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    const first = { key: 'approval:1', kind: 'approval', sessionId: 'one', answer: vi.fn(async () => {}) }
    source.interactions.set(new Map([['one', first]]))
    const initial = (send.mock.calls[0]?.[0] as { approval: NotificationApproval }).approval
    const replacement = { ...first, answer: vi.fn(async () => {}) }
    // Deliberately omit a store notification: the native click must re-read the actual object.
    source.statuses.getSnapshot().set('one', { running: true, pendingInteraction: replacement })
    await expect(approvalTransport(client)!.answer({ sessionId: 'one', ...initial, decision: 'allowed-once' })).resolves.toBe('expired')
    expect(first.answer).not.toHaveBeenCalled()
    expect(replacement.answer).not.toHaveBeenCalled()
    const next = { ...replacement, key: 'approval:2' }
    source.interactions.set(new Map([['one', next]]))
    const latest = (send.mock.calls.at(-1)?.[0] as { approval: NotificationApproval }).approval
    expect(latest.token).not.toBe(initial.token)
    source.interactions.set(new Map())
    await expect(approvalTransport(client)!.answer({ sessionId: 'one', ...latest, decision: 'rejected' })).resolves.toBe('expired')
    expect(next.answer).not.toHaveBeenCalled()
    source.dispose()
  })

  it('rejects malformed decisions and mismatched identities without consuming a valid request', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    const pending = { key: 'approval:1', kind: 'approval', sessionId: 'one', answer: vi.fn(async () => {}) }
    source.interactions.set(new Map([['one', pending]]))
    const approval = (send.mock.calls[0]?.[0] as { approval: NotificationApproval }).approval
    const command = { sessionId: 'one', ...approval, decision: 'allowed-once' }
    const transport = approvalTransport(client)!
    for (const invalid of [null, {}, { ...command, decision: 'always-allow' }, { ...command, sessionId: 'other' }, { ...command, interactionKey: 'approval:2' }, { ...command, token: 'missing' }]) {
      await expect(transport.answer(invalid)).resolves.toBe('expired')
    }
    expect(pending.answer).not.toHaveBeenCalled()
    await expect(transport.answer(command)).resolves.toBe('answered')
    expect(pending.answer).toHaveBeenCalledExactlyOnceWith('allowed-once')
    source.dispose()
  })

  it('invalidates old HMR tokens and lets an older cleanup preserve the replacement transport', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const oldSource = notificationContext()
    const newSource = notificationContext()
    const oldSend = vi.fn(async (_value: unknown) => {})
    const newSend = vi.fn(async (_value: unknown) => {})
    install(oldSource.ctx, oldSend)
    const oldPending = { key: 'approval:1', kind: 'approval', sessionId: 'one', answer: vi.fn(async () => {}) }
    oldSource.interactions.set(new Map([['one', oldPending]]))
    const oldApproval = (oldSend.mock.calls[0]?.[0] as { approval: NotificationApproval }).approval
    const oldTransport = approvalTransport(client)!
    install(newSource.ctx, newSend)
    const newTransport = approvalTransport(client)!
    oldSource.dispose()
    expect(approvalTransport(client)).toBe(newTransport)
    const newPending = { ...oldPending, answer: vi.fn(async () => {}) }
    newSource.interactions.set(new Map([['one', newPending]]))
    const newApproval = (newSend.mock.calls[0]?.[0] as { approval: NotificationApproval }).approval
    expect(newApproval.token).not.toBe(oldApproval.token)
    const oldCommand = { sessionId: 'one', ...oldApproval, decision: 'allowed-once' }
    await expect(oldTransport.answer(oldCommand)).resolves.toBe('expired')
    await expect(newTransport.answer(oldCommand)).resolves.toBe('expired')
    expect(oldPending.answer).not.toHaveBeenCalled()
    expect(newPending.answer).not.toHaveBeenCalled()
    await expect(newTransport.answer({ sessionId: 'one', ...newApproval, decision: 'rejected' })).resolves.toBe('answered')
    expect(newPending.answer).toHaveBeenCalledExactlyOnceWith('rejected')
    newSource.dispose()
  })

  it('consumes the token if the official answer rejects, leaving retries expired', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    const pending = { key: 'approval:1', kind: 'approval', sessionId: 'one', answer: vi.fn(async () => { throw new Error('request already settled') }) }
    source.interactions.set(new Map([['one', pending]]))
    const approval = (send.mock.calls[0]?.[0] as { approval: NotificationApproval }).approval
    const command = { sessionId: 'one', ...approval, decision: 'allowed-once' }
    await expect(approvalTransport(client)!.answer(command)).rejects.toThrow('request already settled')
    await expect(approvalTransport(client)!.answer(command)).resolves.toBe('expired')
    expect(pending.answer).toHaveBeenCalledTimes(1)
    source.dispose()
  })
})
