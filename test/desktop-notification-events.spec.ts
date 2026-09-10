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

function notificationContext(modern = true) {
  const list = observable({ byId: { one: { displayTitle: '测试对话', running: true, updatedAt: 1 } } } as { byId: Record<string, Record<string, unknown>> })
  const interactions = observable(new Map<string, Record<string, unknown>>())
  const session = observable<Record<string, unknown>>({ nodes: [] })
  const cleanups: Array<() => void> = []
  const ctx = {
    sessions: { list, binding: () => ({ session }) },
    effect(setup: () => () => void) { const cleanup = setup(); cleanups.push(cleanup); return cleanup },
    inject: vi.fn((_dependencies: string[], callback: (ctx: unknown) => void) => {
      if (modern) callback({ ...ctx, uiSession: { pendingInteractions: interactions } })
    }),
  }
  return { ctx, list, interactions, session, dispose: () => { for (const cleanup of cleanups.splice(0)) cleanup() } }
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
    const install = client.installSessionOpenFeedback as (sessions: { open(id: string): void }, report: (message: string) => void) => () => void
    const report = vi.fn()
    const sessions = {
      current: '',
      open(id: string) {
        if (id === 'missing') throw new Error('sessions.select: unknown session missing')
        this.current = id
      },
    }
    const original = sessions.open
    const dispose = install(sessions, report)
    expect(() => sessions.open('missing')).not.toThrow()
    expect(report).toHaveBeenCalledWith(expect.stringContaining('当前没有对应的会话记录'))
    sessions.open('existing')
    expect(sessions.current).toBe('existing')
    expect(report).toHaveBeenCalledTimes(1)
    dispose()
    expect(sessions.open).toBe(original)
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

  it('suppresses the baseline and reports completion only after a running transition', async () => {
    const client = await loadClientModule()
    const project = client.projectSessions as (value: unknown) => Map<string, unknown>
    const diff = client.diffSessionNotifications as (
      previous: Map<string, unknown>,
      next: Map<string, unknown>,
    ) => Array<Record<string, unknown>>
    const initial = project({ byId: {
      one: { id: 'one', displayTitle: '旧对话', running: false, completed: true, updatedAt: 1 },
    } })
    expect(diff(new Map(), initial)).toEqual([])

    const running = project({ byId: {
      one: { id: 'one', displayTitle: '测试对话', running: true, updatedAt: 2 },
    } })
    const finished = project({ byId: {
      one: { id: 'one', displayTitle: '测试对话', running: false, updatedAt: 3 },
    } })
    expect(diff(running, finished)).toEqual([{
      kind: 'turn-complete',
      sessionId: 'one',
      sessionTitle: '测试对话',
      key: 'turn-complete:one:3',
    }])
  })

  it('extracts the latest finalized assistant text for a completion preview', async () => {
    const client = await loadClientModule()
    const latestReply = client.latestAssistantReply as (binding: unknown) => string | undefined
    const binding = {
      session: {
        getSnapshot: () => ({
          nodes: [
            { kind: 'assistant', blocks: [{ kind: 'text', text: '较早的回复' }] },
            { kind: 'assistant', blocks: [{ kind: 'reasoning', text: '内部思考' }, { kind: 'text', text: '  你的图片已可查看  ' }] },
          ],
        }),
      },
    }

    expect(latestReply(binding)).toBe('你的图片已可查看')
    expect(latestReply({
      session: {
        getSnapshot: () => ({
          nodes: [
            { kind: 'assistant', blocks: [{ kind: 'text', text: '上一轮回复' }] },
            { kind: 'assistant', blocks: [{ kind: 'image', attachment: {} }] },
          ],
        }),
      },
    })).toBeUndefined()
    expect(latestReply(undefined)).toBeUndefined()
  })

  it('waits for the finalized assistant message after the list reports completion', async () => {
    const client = await loadClientModule()
    const markerOf = client.latestAssistantMarker as (binding: unknown) => unknown
    const waitForReply = client.waitForAssistantReply as (
      binding: unknown,
      baseline: unknown,
      timeoutMs?: number,
    ) => Promise<string | undefined>
    let snapshot = {
      nodes: [{ kind: 'assistant', seq: 1, blocks: [{ kind: 'text', text: '上一轮回复' }] }],
    }
    const listeners = new Set<() => void>()
    const binding = {
      session: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }
    const baseline = markerOf(binding)
    const pending = waitForReply(binding, baseline, 100)
    snapshot = {
      nodes: [
        ...snapshot.nodes,
        { kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: '这一轮的最终回复' }] },
      ],
    }
    for (const listener of listeners) listener()

    await expect(pending).resolves.toBe('这一轮的最终回复')
    expect(listeners.size).toBe(0)
  })

  it('extracts safe summaries from approval, question, and plan-review waits', async () => {
    const client = await loadClientModule()
    const summarize = client.pendingInteractionSummary as (
      binding: unknown,
      status: 'approval' | 'question' | 'plan-review',
    ) => string | undefined
    const binding = {
      session: {
        getSnapshot: () => ({
          pending: [
            { kind: 'approval', payload: { toolName: 'Bash', callId: 'private-call-id', reason: '运行项目测试' } },
            { kind: 'question', payload: { questions: [{
              id: 'q1',
              header: '输出尺寸',
              question: '你希望生成哪种尺寸？',
            }] } },
          ],
        }),
      },
    }
    const planBinding = {
      session: {
        getSnapshot: () => ({
          pending: [{ kind: 'question', payload: { questions: [{
            id: 'plan',
            question: '请审核实施计划',
            detail: '# 内部详细计划',
            intent: { kind: 'plan-review', approve: '批准' },
          }] } }],
        }),
      },
    }

    expect(summarize(binding, 'approval')).toBe('Bash：运行项目测试')
    expect(summarize(binding, 'question')).toBe('输出尺寸：你希望生成哪种尺寸？')
    expect(summarize(planBinding, 'plan-review')).toBe('请审核实施计划')
  })

  it('prioritizes approval, question, and plan-review interactions', async () => {
    const client = await loadClientModule()
    const project = client.projectSessions as (value: unknown) => Map<string, unknown>
    const diff = client.diffSessionNotifications as (
      previous: Map<string, unknown>,
      next: Map<string, unknown>,
    ) => Array<Record<string, unknown>>
    const previous = project({ byId: {
      approval: { displayTitle: 'A', running: true, updatedAt: 1 },
      question: { displayTitle: 'Q', running: true, updatedAt: 1 },
      plan: { displayTitle: 'P', running: true, updatedAt: 1 },
    } })
    const next = project({ byId: {
      approval: { displayTitle: 'A', running: false, pendingInteraction: 'approval', updatedAt: 2 },
      question: { displayTitle: 'Q', running: true, pendingInteraction: 'question', updatedAt: 2 },
      plan: { displayTitle: 'P', running: true, pendingInteraction: 'plan-review', updatedAt: 2 },
    } })
    expect(diff(previous, next).map((event) => event.kind)).toEqual(['approval', 'question', 'plan-review'])
  })

  it('reports an interaction that first appears with a newly created session', async () => {
    const client = await loadClientModule()
    const project = client.projectSessions as (value: unknown) => Map<string, unknown>
    const diff = client.diffSessionNotifications as (
      previous: Map<string, unknown>,
      next: Map<string, unknown>,
    ) => Array<Record<string, unknown>>
    const next = project({ byId: {
      newSession: {
        displayTitle: '新对话',
        running: true,
        pendingInteraction: 'question',
        updatedAt: 2,
      },
    } })

    expect(diff(new Map(), next)).toEqual([{
      kind: 'question',
      sessionId: 'newSession',
      sessionTitle: '新对话',
      key: 'question:newSession:2',
    }])
  })

  it('notifies from the rc.1 interaction store without list changes and distinguishes consecutive approval keys', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    const approval = { key: 'approval:1', kind: 'approval', sessionId: 'one', toolName: 'desktop_restart_harness', reason: '加载浏览器修复' }
    source.interactions.set(new Map([['one', approval]]))
    source.interactions.set(new Map([['one', { ...approval }]]))
    source.list.set({ byId: { one: { displayTitle: '已改标题', running: true, updatedAt: 2, pendingInteraction: 'approval' } } })
    source.interactions.set(new Map([['one', { ...approval, key: 'approval:2', reason: '加载通知修复' }]]))
    expect(send.mock.calls.map(([value]) => value)).toEqual([
      { kind: 'approval', sessionId: 'one', sessionTitle: '测试对话', key: 'approval:one:approval:1', summary: 'desktop_restart_harness：加载浏览器修复' },
      { kind: 'approval', sessionId: 'one', sessionTitle: '已改标题', key: 'approval:one:approval:2', summary: 'desktop_restart_harness：加载通知修复' },
    ])
    source.dispose()
    expect(source.list.listeners.size).toBe(0)
    expect(source.interactions.listeners.size).toBe(0)
  })

  it('summarizes rc.1 question and plan-review objects without legacy payload wrappers', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    source.interactions.set(new Map([['one', { key: 'question:1', kind: 'question', sessionId: 'one', questions: [{ header: '尺寸', question: '选择哪种尺寸？' }] }]]))
    source.interactions.set(new Map([['one', { key: 'question:2', kind: 'plan-review', sessionId: 'one', questions: [{ question: '请审核实施计划', detail: '详细计划', intent: { kind: 'plan-review' } }] }]]))
    expect(send.mock.calls.map(([value]) => value)).toMatchObject([
      { kind: 'question', summary: '选择哪种尺寸？' },
      { kind: 'plan-review', summary: '请审核实施计划' },
    ])
    source.dispose()
  })

  it('rechecks independently published interactions before sending a completion and still completes the selected session', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    source.list.set({ byId: { one: { displayTitle: '测试对话', running: false, updatedAt: 2 } } })
    source.interactions.set(new Map([['one', { key: 'approval:1', kind: 'approval', sessionId: 'one', toolName: 'Bash' }]]))
    source.session.set({ nodes: [{ kind: 'assistant', seq: 1, blocks: [{ kind: 'text', text: '请求确认' }] }] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ kind: 'approval' })
    source.interactions.set(new Map())
    source.list.set({ byId: { one: { displayTitle: '测试对话', running: true, updatedAt: 3 } } })
    source.session.set({ nodes: [{ kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: '任务已完成' }] }] })
    // The selected session has no `completed` unread-dot field in rc.1.
    source.list.set({ byId: { one: { displayTitle: '测试对话', running: false, updatedAt: 4 } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(send.mock.calls.map(([value]) => value)).toMatchObject([
      { kind: 'approval' }, { kind: 'turn-complete', summary: '任务已完成' },
    ])
    source.dispose()
  })

  it('keeps legacy approval notifications when the newer UI service is absent', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext(false)
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    source.session.set({ pending: [{ kind: 'approval', payload: { toolName: 'Bash', reason: '运行测试' } }] })
    source.list.set({ byId: { one: { displayTitle: '测试对话', running: false, pendingInteraction: 'approval', updatedAt: 2 } } })
    await Promise.resolve()
    expect(send).toHaveBeenCalledWith({ kind: 'approval', sessionId: 'one', sessionTitle: '测试对话', key: 'approval:one:2', summary: 'Bash：运行测试' })
    expect(source.interactions.listeners.size).toBe(0)
    source.dispose()
  })

  it('drops a delayed completion after a newer run and cancels summary subscriptions on disposal', async () => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    source.list.set({ byId: { one: { displayTitle: '测试对话', running: false, updatedAt: 2 } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(source.session.listeners.size).toBe(1)
    source.list.set({ byId: { one: { displayTitle: '测试对话', running: true, updatedAt: 3 } } })
    source.session.set({ nodes: [{ kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: '新轮次回复' }] }] })
    source.list.set({ byId: { one: { displayTitle: '测试对话', running: false, updatedAt: 4 } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ kind: 'turn-complete', key: 'turn-complete:one:4', summary: '新轮次回复' })
    source.list.set({ byId: { one: { displayTitle: '测试对话', running: true, updatedAt: 5 } } })
    source.list.set({ byId: { one: { displayTitle: '测试对话', running: false, updatedAt: 6 } } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(source.session.listeners.size).toBe(1)
    source.dispose()
    expect(source.session.listeners.size).toBe(0)
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('attaches a later UI service through real Cordis optional injection and disposes both subscriptions', async () => {
    const projectRequire = createRequire(import.meta.url)
    const dshRequire = createRequire(projectRequire.resolve('@deepseek-ai/dsh/package.json'))
    type TestContext = {
      fiber: { dispose(): Promise<void> }
      plugin(plugin: unknown): Promise<{ dispose(): Promise<void> }>
    }
    const cordis = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis')).href) as {
      Context: new () => TestContext
      Service: new (ctx: TestContext, name: string) => object
    }
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    const root = new cordis.Context()
    class Sessions extends cordis.Service {
      list = source.list
      binding = source.ctx.sessions.binding
      constructor(ctx: TestContext) { super(ctx, 'sessions') }
    }
    class UiSession extends cordis.Service {
      pendingInteractions = source.interactions
      constructor(ctx: TestContext) { super(ctx, 'uiSession') }
    }
    try {
      await root.plugin(Sessions)
      const consumer = await root.plugin(Object.assign((ctx: TestContext) => install(ctx, send), { inject: ['sessions'] }))
      expect(source.list.listeners.size).toBe(1)
      expect(source.interactions.listeners.size).toBe(0)
      const ui = await root.plugin(UiSession)
      expect(source.interactions.listeners.size).toBe(1)
      source.interactions.set(new Map([['one', { key: 'approval:1', kind: 'approval', sessionId: 'one', toolName: 'Bash' }]]))
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval', summary: '请求使用 Bash' }))
      await ui.dispose()
      expect(source.interactions.listeners.size).toBe(0)
      expect(source.list.listeners.size).toBe(1)
      await consumer.dispose()
      expect(source.list.listeners.size).toBe(0)
    } finally {
      await root.fiber.dispose()
    }
  })

  it.each(['allowed-once', 'rejected'] as const)('answers the real rc.1 PendingApproval once with %s', async (decision) => {
    const client = await loadClientModule()
    const install = client.installSessionNotifications as (ctx: unknown, send: (value: unknown) => Promise<void>) => void
    const source = notificationContext()
    const send = vi.fn(async (_value: unknown) => {})
    install(source.ctx, send)
    let requestApproval: ((request: Record<string, unknown>, next: () => Promise<string>) => Promise<string>) | undefined
    loadOfficialApprovalClient().apply({
      effect: (setup: () => unknown) => setup(),
      locale: { register: () => () => {} },
      slots: { inject: () => {} },
      sessions: { scopeOf: () => 'one' },
      remote: { $on: (_name: string, handler: typeof requestApproval) => { requestApproval = handler } },
      uiSession: { registerPendingInteraction: () => (pending: Record<string, unknown>) => {
        source.interactions.set(new Map([['one', pending]]))
        return () => { source.interactions.set(new Map()) }
      } },
    })
    if (requestApproval === undefined) throw new Error('Official approval handler did not register')
    const outcome = requestApproval({ toolName: 'desktop_restart_harness', reason: '加载已更新插件' }, async () => 'delegated')
    const notification = send.mock.calls[0]?.[0] as { approval: NotificationApproval }
    expect(notification.approval).toEqual({ token: expect.stringMatching(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u), interactionKey: 'approval:1' })
    const transport = approvalTransport(client)!
    const command = { sessionId: 'one', ...notification.approval, decision }
    await expect(Promise.all([transport.answer(command), transport.answer(command)])).resolves.toEqual(['answered', 'expired'])
    await expect(outcome).resolves.toBe(decision)
    expect(source.interactions.getSnapshot().size).toBe(0)
    source.dispose()
    expect(approvalTransport(client)).toBeUndefined()
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
    source.interactions.getSnapshot().set('one', replacement)
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
