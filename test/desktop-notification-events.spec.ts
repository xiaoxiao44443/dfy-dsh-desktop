import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
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
})
