import type {
  BrowserLocatorKind,
  BrowserLocatorMatch,
  BrowserLocatorResolution,
  BrowserLocatorStep,
  BrowserTabRuntime,
  DesktopBrowserAgentRequest,
  SnapshotTarget,
} from './desktop-browser-types.js'
import { finiteCoordinate, positiveInteger } from './desktop-browser-utils.js'
import { normalizeBrowserPageUrl } from '../shared/browser-address.js'

export type BrowserDebuggerCommand = (
  tab: BrowserTabRuntime,
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>

export type BrowserSnapshotReader = (tab: BrowserTabRuntime) => Promise<Record<string, unknown>>

export interface BrowserNavigationState {
  version: number
  url: string
  title: string
  h1: string
  text: string
  readyState: string
  loading: boolean
  inflightRequests: number
  networkActivityVersion?: number
  networkIdleMs: number
  kind: 'document' | 'same-document'
  failure?: { url: string; message: string; at: number }
}

export interface BrowserNavigationOutcome {
  status: 'success' | 'no-op' | 'timeout' | 'failed'
  reason?: 'no-navigation' | 'expected-url' | 'unstable-page' | 'navigation-failed'
  state: BrowserNavigationState
  elapsedMs: number
}

export interface BrowserNavigationWaitOptions {
  timeoutMs: number
  waitUntil: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
  expectedUrl?: string
  requireNavigation: boolean
  acceptCurrent?: boolean
  detectionTimeoutMs?: number
}

export interface BrowserNavigationRetryResult {
  attempts: number
  outcome?: BrowserNavigationOutcome
  error?: unknown
}

export interface BrowserReadOnlyEvaluation {
  source: string
  argument: string
  timeoutMs: number
}

const READ_ONLY_EVALUATION_FORBIDDEN = /(?:\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b|\b(?:localStorage|sessionStorage|indexedDB|caches)\b|\b(?:(?:(?:window|globalThis|document)\s*\.\s*)?location)\s*(?:=|\.\s*(?:assign|replace|reload)\s*\(|\.\s*(?:href|protocol|host|hostname|port|pathname|search|hash)\s*=)|\bhistory\s*\.\s*(?:back|forward|go|pushState|replaceState)\s*\(|\bhistory\s*\.\s*scrollRestoration\s*=|\.\s*(?:click|focus|blur|submit|remove|append|appendChild|prepend|replaceWith|setAttribute|removeAttribute|dispatchEvent)\s*\(|\.(?:innerHTML|outerHTML|textContent|value|checked)\s*=)/u

export function prepareReadOnlyEvaluation(request: DesktopBrowserAgentRequest): BrowserReadOnlyEvaluation {
  if (typeof request.script !== 'string' || request.script.trim().length === 0 || request.script.length > 8_000) {
    throw new Error('evaluate script 必须是 1–8000 字符的字符串。')
  }
  if (READ_ONLY_EVALUATION_FORBIDDEN.test(request.script)) {
    throw new Error('evaluate 只允许只读页面检查，脚本包含可能修改页面或发起网络请求的操作。')
  }
  let argument: string
  try {
    argument = JSON.stringify(request.argument ?? null)
  } catch {
    throw new Error('evaluate argument 必须可 JSON 序列化。')
  }
  if (argument.length > 32_000) throw new Error('evaluate argument 过大。')
  return {
    source: request.script.trim(),
    argument,
    timeoutMs: request.timeoutMs === undefined ? 5_000 : positiveInteger(request.timeoutMs, 'timeoutMs', 250, 15_000),
  }
}

const LOCATOR_KINDS = new Set<BrowserLocatorKind>([
  'css', 'role', 'text', 'label', 'placeholder', 'testid', 'nth', 'frame', 'filter', 'and', 'or',
])

export function parseLocatorPlan(request: DesktopBrowserAgentRequest): BrowserLocatorStep[] {
  if (!Array.isArray(request.locator) || request.locator.length === 0) throw new Error('locator 必须是非空定位步骤数组。')
  if (request.locator.length > 12) throw new Error('locator 定位步骤过多。')
  return request.locator.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('locator 定位步骤格式无效。')
    const source = entry as Record<string, unknown>
    if (typeof source.kind !== 'string' || !LOCATOR_KINDS.has(source.kind as BrowserLocatorKind)) throw new Error('locator 定位类型无效。')
    if (typeof source.value !== 'string' || source.value.length === 0 || source.value.length > 1_000) throw new Error('locator 定位值无效。')
    if (source.kind === 'nth' && !/^-?\d+$/u.test(source.value)) throw new Error('locator nth 索引无效。')
    if (source.kind === 'filter' || source.kind === 'and' || source.kind === 'or') {
      try {
        const decoded = JSON.parse(source.value) as unknown
        if (source.kind === 'filter') {
          if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error()
          const options = decoded as Record<string, unknown>
          const validMatcher = (matcher: unknown): boolean => {
            if (matcher === null || typeof matcher !== 'object' || Array.isArray(matcher)) return false
            const value = matcher as Record<string, unknown>
            if (typeof value.value !== 'string' || value.value.length === 0) return false
            if (value.namePattern !== undefined && typeof value.namePattern !== 'string') return false
            if (value.nameFlags !== undefined && typeof value.nameFlags !== 'string') return false
            return true
          }
          if (options.hasText !== undefined && !validMatcher(options.hasText)) throw new Error()
          if (options.hasNotText !== undefined && !validMatcher(options.hasNotText)) throw new Error()
          if (options.has !== undefined && (!Array.isArray(options.has) || options.has.length === 0 || options.has.length > 12)) throw new Error()
          if (options.hasNot !== undefined && (!Array.isArray(options.hasNot) || options.hasNot.length === 0 || options.hasNot.length > 12)) throw new Error()
          if (options.visible !== undefined && typeof options.visible !== 'boolean') throw new Error()
          if (options.hasText === undefined && options.hasNotText === undefined && options.has === undefined
            && options.hasNot === undefined && options.visible === undefined) throw new Error()
        } else if (!Array.isArray(decoded) || decoded.length === 0 || decoded.length > 12) throw new Error()
      } catch {
        throw new Error(`locator ${String(source.kind)} 配置无效。`)
      }
    }
    if (source.exact !== undefined && typeof source.exact !== 'boolean') throw new Error('locator exact 必须是布尔值。')
    if (source.name !== undefined && (typeof source.name !== 'string' || source.name.length === 0 || source.name.length > 500)) {
      throw new Error('locator name 无效。')
    }
    if (source.namePattern !== undefined) {
      if (typeof source.namePattern !== 'string' || source.namePattern.length === 0 || source.namePattern.length > 500) {
        throw new Error('locator namePattern 无效。')
      }
      if (source.name !== undefined) throw new Error('locator name 和 namePattern 不能同时使用。')
      if (source.nameFlags !== undefined && (typeof source.nameFlags !== 'string' || !/^[dgimsuvy]*$/u.test(source.nameFlags))) {
        throw new Error('locator nameFlags 无效。')
      }
      try {
        new RegExp(source.namePattern, typeof source.nameFlags === 'string' ? source.nameFlags : '')
      } catch {
        throw new Error('locator namePattern 不是有效正则表达式。')
      }
    } else if (source.nameFlags !== undefined) throw new Error('locator nameFlags 缺少 namePattern。')
    return {
      kind: source.kind as BrowserLocatorKind,
      value: source.value,
      ...(typeof source.name === 'string' ? { name: source.name } : {}),
      ...(typeof source.namePattern === 'string' ? { namePattern: source.namePattern } : {}),
      ...(typeof source.nameFlags === 'string' ? { nameFlags: source.nameFlags } : {}),
      ...(source.exact === true ? { exact: true } : {}),
    }
  })
}

export function strictLocator(resolution: BrowserLocatorResolution): BrowserLocatorMatch {
  if (resolution.count === 0) throw new Error('Locator 没有匹配到元素，请刷新 DOM 快照并重新构造定位器。')
  if (resolution.count > 1) throw new Error(`Locator 严格模式失败：匹配到 ${String(resolution.count)} 个元素。`)
  if (resolution.first === undefined) throw new Error('Locator 无法读取匹配元素。')
  return resolution.first
}

export function targetFromRequest(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): SnapshotTarget {
  if (typeof request.ref === 'number') {
    const ref = positiveInteger(request.ref, 'ref', 1, Number.MAX_SAFE_INTEGER)
    const snapshotVersion = positiveInteger(request.snapshotVersion, 'snapshotVersion', 1, Number.MAX_SAFE_INTEGER)
    if (snapshotVersion !== tab.snapshotVersion) throw new Error('这个元素引用已失效，请重新调用 browser_snapshot。')
    const target = tab.snapshotTargets.get(ref)
    if (target === undefined) throw new Error('这个元素引用已失效，请重新调用 browser_snapshot。')
    return target
  }
  return { x: finiteCoordinate(request.x, 'x'), y: finiteCoordinate(request.y, 'y') }
}

export function readConsoleLogs(tab: BrowserTabRuntime, request: DesktopBrowserAgentRequest): Record<string, unknown> {
  if (request.filter !== undefined && typeof request.filter !== 'string') throw new Error('filter 必须是字符串。')
  if (request.levels !== undefined && (!Array.isArray(request.levels) || request.levels.some((level) => !['debug', 'info', 'log', 'warn', 'warning', 'error'].includes(String(level))))) {
    throw new Error('levels 包含不支持的日志等级。')
  }
  const limit = request.limit === undefined ? 100 : positiveInteger(request.limit, 'limit', 1, 500)
  const levels = request.levels === undefined
    ? undefined
    : new Set((request.levels as unknown[]).map((level) => level === 'warning' ? 'warn' : String(level)))
  const filter = typeof request.filter === 'string' ? request.filter.toLocaleLowerCase() : undefined
  const logs = tab.consoleLogs.filter((entry) => (levels === undefined || levels.has(entry.level))
    && (filter === undefined || entry.message.toLocaleLowerCase().includes(filter))).slice(-limit)
  return { ok: true, tabId: tab.id, logs }
}

export async function waitForPage(
  tab: BrowserTabRuntime,
  request: DesktopBrowserAgentRequest,
  debuggerCommand: BrowserDebuggerCommand,
  snapshot: BrowserSnapshotReader,
): Promise<Record<string, unknown>> {
  const text = request.text
  if (text !== undefined && (typeof text !== 'string' || text.length === 0)) throw new Error('text 必须是非空字符串。')
  const state = request.state === undefined ? 'visible' : request.state
  if (state !== 'visible' && state !== 'hidden') throw new Error('state 必须是 visible 或 hidden。')
  const timeoutMs = request.timeoutMs === undefined ? 10_000 : positiveInteger(request.timeoutMs, 'timeoutMs', 250, 30_000)
  const deadline = Date.now() + timeoutMs
  const earliestSuccess = Date.now() + 180
  let readyState = 'loading'
  let textMatched = text === undefined
  while (Date.now() <= deadline) {
    if (tab.view.webContents.isDestroyed()) throw new Error('浏览器标签页已关闭。')
    try {
      const response = await debuggerCommand(tab, 'Runtime.evaluate', {
        expression: `(() => ({ readyState: document.readyState, textMatched: ${text === undefined ? 'true' : `String(document.body?.innerText || '').includes(${JSON.stringify(text)})`} }))()`,
        returnByValue: true,
        awaitPromise: true,
      }) as { result?: { value?: { readyState?: unknown; textMatched?: unknown } } }
      const value = response.result?.value
      readyState = typeof value?.readyState === 'string' ? value.readyState : 'loading'
      textMatched = value?.textMatched === true
      const textReady = text === undefined || (state === 'visible' ? textMatched : !textMatched)
      if (Date.now() >= earliestSuccess && !tab.loading && readyState !== 'loading' && textReady) {
        const result = await snapshot(tab)
        return { ...result, waited: { text: text ?? null, state, timeoutMs } }
      }
    } catch {
      readyState = 'loading'
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
  }
  const condition = text === undefined ? '页面完成加载' : `文本“${text}”变为${state === 'visible' ? '可见' : '不可见'}`
  throw new Error(`等待${condition}超时（${String(timeoutMs)}ms）。`)
}

function urlPatternMatches(expected: string | undefined, actual: string): boolean {
  if (expected === undefined) return true
  const escaped = expected.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`, 'u').test(actual)
}

function navigationSignature(state: BrowserNavigationState, includeNetwork: boolean): string {
  return [
    state.url,
    state.readyState,
    String(state.loading),
    ...(includeNetwork ? [String(state.inflightRequests), String(state.networkActivityVersion ?? 0)] : []),
  ].join('\u0000')
}

function commitNavigationState(tab: BrowserTabRuntime, state: BrowserNavigationState): void {
  tab.url = normalizeBrowserPageUrl(state.url) ?? ''
  tab.title = state.title || tab.view.webContents.getTitle().trim() || tab.url || '浏览器'
}

export async function readNavigationState(
  tab: BrowserTabRuntime,
  debuggerCommand: BrowserDebuggerCommand,
): Promise<BrowserNavigationState> {
  const contents = tab.view.webContents
  if (contents.isDestroyed()) throw new Error('浏览器标签页已关闭。')
  const currentUrl = contents.getURL()
  const response = await debuggerCommand(tab, 'Runtime.evaluate', {
    expression: `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      return {
        readyState: document.readyState,
        title: document.title,
        h1: normalize(document.querySelector('h1')?.innerText),
        text: normalize(document.body?.innerText).slice(0, 4000),
      };
    })()`,
    returnByValue: true,
  }).catch(() => undefined) as { result?: { value?: { readyState?: unknown; title?: unknown; h1?: unknown; text?: unknown } } } | undefined
  const value = response?.result?.value
  return {
    version: tab.navigationVersion,
    url: currentUrl,
    title: typeof value?.title === 'string' ? value.title.trim() : contents.getTitle().trim(),
    h1: typeof value?.h1 === 'string' ? value.h1 : '',
    text: typeof value?.text === 'string' ? value.text : '',
    readyState: typeof value?.readyState === 'string' ? value.readyState : 'loading',
    loading: tab.loading,
    inflightRequests: tab.inflightRequests.size,
    networkActivityVersion: tab.networkActivityVersion ?? 0,
    networkIdleMs: tab.inflightRequests.size === 0 ? Math.max(0, Date.now() - tab.networkIdleSince) : 0,
    kind: tab.lastNavigationKind,
    ...(tab.lastNavigationFailure === undefined ? {} : { failure: tab.lastNavigationFailure }),
  }
}

export async function waitForNavigationStability(
  tab: BrowserTabRuntime,
  before: BrowserNavigationState,
  options: BrowserNavigationWaitOptions,
  debuggerCommand: BrowserDebuggerCommand,
): Promise<BrowserNavigationOutcome> {
  const startedAt = Date.now()
  const deadline = startedAt + options.timeoutMs
  const detectionDeadline = startedAt + (options.detectionTimeoutMs ?? 300)
  let detectedAt: number | undefined
  let stableSince: number | undefined
  let stableSignature = ''
  let networkQuietSince: number | undefined
  let networkQuietVersion: number | undefined
  let latest = before
  let matchedExpectedUrl = false

  while (Date.now() <= deadline) {
    latest = await readNavigationState(tab, debuggerCommand)
    const now = Date.now()
    if (latest.failure !== undefined && (latest.failure.at !== before.failure?.at
      || (!options.requireNavigation && options.expectedUrl !== undefined && !urlPatternMatches(options.expectedUrl, latest.url)
        && urlPatternMatches(options.expectedUrl, latest.failure.url)))) {
      return { status: 'failed', reason: 'navigation-failed', state: latest, elapsedMs: now - startedAt }
    }
    const changed = latest.version > before.version || latest.url !== before.url || latest.loading
    if (detectedAt === undefined && (changed || options.acceptCurrent === true)) detectedAt = now
    if (detectedAt === undefined) {
      if (!options.requireNavigation && now >= detectionDeadline) {
        return { status: 'no-op', reason: 'no-navigation', state: latest, elapsedMs: now - startedAt }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      continue
    }

    const urlReady = urlPatternMatches(options.expectedUrl, latest.url)
    matchedExpectedUrl ||= urlReady
    if (urlReady && options.waitUntil === 'commit') {
      commitNavigationState(tab, latest)
      return { status: 'success', state: latest, elapsedMs: now - startedAt }
    }
    if (latest.inflightRequests !== 0) {
      networkQuietSince = undefined
      networkQuietVersion = undefined
    } else if (networkQuietSince === undefined || networkQuietVersion !== (latest.networkActivityVersion ?? 0)) {
      networkQuietSince = now
      networkQuietVersion = latest.networkActivityVersion ?? 0
    }
    const documentReady = options.waitUntil === 'domcontentloaded'
      ? latest.readyState === 'interactive' || latest.readyState === 'complete'
      : options.waitUntil === 'networkidle'
        ? latest.readyState === 'complete'
          && !latest.loading
          && latest.inflightRequests === 0
          && networkQuietSince !== undefined
          && now - networkQuietSince >= 500
        : latest.readyState === 'complete' && !latest.loading
    const ready = urlReady && documentReady
    const signature = navigationSignature(latest, options.waitUntil === 'networkidle')
    if (ready) {
      if (signature !== stableSignature) {
        stableSignature = signature
        stableSince = now
      } else if (stableSince !== undefined && now - stableSince >= 180) {
        commitNavigationState(tab, latest)
        return { status: 'success', state: latest, elapsedMs: now - startedAt }
      }
    } else {
      stableSignature = ''
      stableSince = undefined
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }

  return {
    status: 'timeout',
    reason: detectedAt === undefined ? 'no-navigation' : matchedExpectedUrl ? 'unstable-page' : 'expected-url',
    state: latest,
    elapsedMs: Date.now() - startedAt,
  }
}

export async function runNavigationWithRetry(
  action: () => Promise<void>,
  observe: () => Promise<BrowserNavigationOutcome>,
): Promise<BrowserNavigationRetryResult> {
  let outcome: BrowserNavigationOutcome | undefined
  let error: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await action()
      outcome = await observe()
      if (outcome.status === 'success') return { attempts: attempt, outcome }
    } catch (currentError) {
      error = currentError
    }
  }
  return { attempts: 2, ...(outcome === undefined ? {} : { outcome }), ...(error === undefined ? {} : { error }) }
}

export async function waitForNavigation(
  tab: BrowserTabRuntime,
  request: DesktopBrowserAgentRequest,
  requireNavigation: boolean,
  debuggerCommand: BrowserDebuggerCommand,
): Promise<Record<string, unknown>> {
  const timeoutMs = request.timeoutMs === undefined ? 30_000 : positiveInteger(request.timeoutMs, 'timeoutMs', 250, 60_000)
  const afterVersion = requireNavigation ? positiveInteger(request.afterVersion, 'afterVersion', 0, Number.MAX_SAFE_INTEGER) : undefined
  const expectedUrl = request.url
  if (expectedUrl !== undefined && (typeof expectedUrl !== 'string' || expectedUrl.length === 0 || expectedUrl.length > 4_000)) {
    throw new Error('url 必须是非空字符串。')
  }
  const waitUntil = request.waitUntil === undefined ? 'load' : request.waitUntil
  if (!['commit', 'domcontentloaded', 'load', 'networkidle'].includes(String(waitUntil))) {
    throw new Error('waitUntil 必须是 commit、domcontentloaded、load 或 networkidle。')
  }
  const current = await readNavigationState(tab, debuggerCommand).catch((error: unknown) => {
    throw new Error(navigationFailureMessage(tab.url, typeof expectedUrl === 'string' ? expectedUrl : undefined,
      error instanceof Error ? error.message : String(error)), { cause: error })
  })
  const supplied = request.before
  let before: BrowserNavigationState
  if (supplied !== undefined) {
    if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('before 导航状态无效。')
    const value = supplied as Partial<BrowserNavigationState>
    if (typeof value.version !== 'number' || typeof value.url !== 'string' || typeof value.title !== 'string'
      || typeof value.h1 !== 'string' || typeof value.text !== 'string') throw new Error('before 导航状态无效。')
    before = {
      version: value.version,
      url: value.url,
      title: value.title,
      h1: value.h1,
      text: value.text,
      readyState: typeof value.readyState === 'string' ? value.readyState : 'complete',
      loading: value.loading === true,
      inflightRequests: typeof value.inflightRequests === 'number' ? value.inflightRequests : 0,
      networkActivityVersion: typeof value.networkActivityVersion === 'number' ? value.networkActivityVersion : 0,
      networkIdleMs: typeof value.networkIdleMs === 'number' ? value.networkIdleMs : 0,
      kind: value.kind === 'same-document' ? 'same-document' : 'document',
      ...(value.failure !== undefined && value.failure !== null && typeof value.failure.url === 'string' && typeof value.failure.message === 'string'
        && typeof value.failure.at === 'number' && Number.isFinite(value.failure.at) ? { failure: value.failure } : {}),
    }
  } else {
    before = { ...current, version: afterVersion ?? current.version }
  }
  const outcome = await waitForNavigationStability(tab, before, {
    timeoutMs,
    waitUntil: waitUntil as BrowserNavigationWaitOptions['waitUntil'],
    ...(typeof expectedUrl === 'string' ? { expectedUrl } : {}),
    requireNavigation,
    acceptCurrent: !requireNavigation,
  }, debuggerCommand).catch((error: unknown) => {
    throw new Error(navigationFailureMessage(tab.url, typeof expectedUrl === 'string' ? expectedUrl : undefined,
      error instanceof Error ? error.message : String(error)), { cause: error })
  })
  if (outcome.status === 'success') {
    return {
      ok: true,
      tabId: tab.id,
      status: outcome.status,
      url: outcome.state.url,
      version: outcome.state.version,
      waitUntil,
      elapsedMs: outcome.elapsedMs,
    }
  }
  const reason = outcome.reason === 'navigation-failed' ? outcome.state.failure?.message ?? '页面加载失败'
    : outcome.reason === 'no-navigation' ? '未观察到新导航'
      : outcome.reason === 'expected-url' ? '当前 URL 未匹配预期 URL'
        : waitUntil === 'networkidle' ? `网络尚未空闲（${outcome.state.inflightRequests} 个未完成请求，空闲 ${Math.round(outcome.state.networkIdleMs)}ms）`
          : outcome.state.loading || outcome.state.readyState !== 'complete' ? '页面仍在加载' : '页面状态尚未稳定'
  throw new Error(navigationFailureMessage(outcome.state.url, typeof expectedUrl === 'string' ? expectedUrl : undefined,
    reason, outcome.status === 'failed' ? '导航失败' : `等待${requireNavigation ? '导航' : 'URL/页面状态'}超时（${timeoutMs}ms，${String(waitUntil)}）`))
}

export function navigationFailureMessage(currentUrl: string, expectedUrl: string | undefined, reason: string, title = '导航失败'): string {
  const compact = (value: string, limit: number): string => {
    const text = value.replace(/[\r\n]+/gu, ' ').trim()
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
  }
  const explanation = reason === 'no-navigation' ? '未观察到新导航'
    : reason === 'expected-url' ? '当前 URL 未匹配预期 URL'
      : reason === 'unstable-page' ? '页面状态尚未稳定' : reason
  return `${title}。当前 URL：${compact(currentUrl, 400) || '(空白)'}。`
    + (expectedUrl === undefined ? '' : `预期 URL：${compact(expectedUrl, 400)}。`)
    + `原因：${compact(explanation, 300)}。`
}

export async function evaluatePage(
  tab: BrowserTabRuntime,
  request: DesktopBrowserAgentRequest,
  debuggerCommand: BrowserDebuggerCommand,
): Promise<Record<string, unknown>> {
  const { source, argument, timeoutMs } = prepareReadOnlyEvaluation(request)
  const callable = /^(?:async\s*)?(?:function\b|\(?\s*[A-Za-z_$][\w$]*(?:\s*,[^)]*)?\)?\s*=>|\(.*\)\s*=>)/su.test(source)
  const expression = callable
    ? `Promise.resolve((${source})(${argument}))`
    : `Promise.resolve((${source}))`
  const result = await Promise.race([
    debuggerCommand(tab, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`evaluate 超时（${String(timeoutMs)}ms）。`)), timeoutMs)),
  ]) as { result?: { value?: unknown; unserializableValue?: unknown; description?: unknown }; exceptionDetails?: unknown }
  if (result.exceptionDetails !== undefined) throw new Error(`evaluate 执行失败：${String(result.result?.description ?? '页面脚本异常')}`)
  if (result.result?.unserializableValue !== undefined) throw new Error('evaluate 结果无法 JSON 序列化。')
  return { ok: true, tabId: tab.id, value: result.result?.value ?? null }
}
