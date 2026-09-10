import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import { removeWindowsNotification } from './windows-notification-history.js'

export type TurnCompletionNotificationMode = 'never' | 'unfocused' | 'always'
export type DesktopNotificationKind = 'turn-complete' | 'approval' | 'question' | 'plan-review'
export type DesktopApprovalDecision = 'allowed-once' | 'rejected'

export interface DesktopNotificationApproval {
  sessionId: string
  token: string
  interactionKey: string
}

export interface DesktopNotificationSettings {
  turnCompletion: TurnCompletionNotificationMode
  permissionRequests: boolean
  questions: boolean
}

export interface DesktopNotificationRequest {
  kind: DesktopNotificationKind
  sessionId: string
  sessionTitle?: string
  summary?: string
  key?: string
  approval?: Omit<DesktopNotificationApproval, 'sessionId'>
}

export interface DesktopNotificationActions {
  getWindow(): BrowserWindow | undefined
  openSession(sessionId: string): void
  answerApproval?(request: DesktopNotificationApproval, decision: DesktopApprovalDecision): Promise<'answered' | 'expired'>
}

export const DEFAULT_DESKTOP_NOTIFICATION_SETTINGS: DesktopNotificationSettings = {
  turnCompletion: 'unfocused',
  permissionRequests: true,
  questions: true,
}

export class DesktopNotificationService {
  private settings: DesktopNotificationSettings = { ...DEFAULT_DESKTOP_NOTIFICATION_SETTINGS }
  private readonly notifications = new Map<Notification, () => void>()
  private readonly protocolActions = new Map<string, () => void>()
  private readonly protocolScheme: string | undefined
  private readonly windowsApprovalActionsDisabled: boolean

  constructor(
    private readonly settingsPath: string,
    private readonly actions: DesktopNotificationActions,
    protocolScheme?: string | null,
  ) {
    this.protocolScheme = process.platform === 'win32' && typeof protocolScheme === 'string'
      && /^[a-z][a-z0-9+.-]*$/u.test(protocolScheme) ? protocolScheme : undefined
    this.windowsApprovalActionsDisabled = process.platform === 'win32' && protocolScheme === null
  }

  handleProtocolActivation(value: string): boolean {
    if (this.protocolScheme === undefined || typeof value !== 'string') return false
    const prefix = `${this.protocolScheme}://action/`
    if (!value.startsWith(prefix)) return false
    const nonce = value.slice(prefix.length)
    if (nonce.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(nonce)) return false
    // Recognize expired notification links without opening a different session.
    this.protocolActions.get(nonce)?.()
    return true
  }

  async initialize(): Promise<void> {
    this.settings = await readDesktopNotificationSettings(this.settingsPath)
  }

  get currentSettings(): DesktopNotificationSettings {
    return { ...this.settings }
  }

  async updateSettings(value: unknown): Promise<DesktopNotificationSettings> {
    this.settings = normalizeDesktopNotificationSettings(value)
    await writeDesktopNotificationSettings(this.settingsPath, this.settings)
    return this.currentSettings
  }

  async show(requestValue: unknown): Promise<boolean> {
    const request = normalizeDesktopNotificationRequest(requestValue)
    if (request === undefined || !this.shouldNotify(request.kind) || !Notification.isSupported()) return false

    const sessionTitle = normalizeSessionTitle(request.sessionTitle)
    const title = sessionTitle
    const body = request.kind === 'turn-complete'
      ? normalizeNotificationPreview(request.summary, '回复已完成。')
      : request.kind === 'approval'
        ? `审批 · ${normalizeNotificationPreview(request.summary, '需要你确认权限后才能继续。')}`
        : request.kind === 'plan-review'
          ? `确认 · ${normalizeNotificationPreview(request.summary, '需要你审核计划后才能继续。')}`
          : `提问 · ${normalizeNotificationPreview(request.summary, '需要你的回答后才能继续。')}`
    const answerApproval = this.actions.answerApproval?.bind(this.actions)
    const approval = request.kind === 'approval' && request.approval !== undefined && answerApproval !== undefined
      && !this.windowsApprovalActionsDisabled
      && (process.platform === 'win32' || process.platform === 'darwin')
      ? { sessionId: request.sessionId, ...request.approval }
      : undefined
    const protocol = this.protocolScheme === undefined ? undefined : {
      open: randomUUID(),
      ...(approval === undefined ? {} : { allow: randomUUID(), reject: randomUUID() }),
    }
    const protocolUrl = (nonce: string): string => `${this.protocolScheme}://action/${nonce}`
    const notificationId = randomUUID()
    const notificationGroup = 'Notifications'
    const macCloseAction = process.platform === 'darwin' && approval === undefined
    const notification = new Notification({
      id: notificationId,
      title,
      body,
      ...(process.platform === 'win32' ? { groupId: notificationGroup } : {}),
      ...(protocol !== undefined || (process.platform === 'win32' && approval === undefined) ? {
        toastXml: buildWindowsNotificationXml(title, body, protocol === undefined ? undefined : protocolUrl(protocol.open),
          protocol?.allow === undefined || protocol.reject === undefined ? undefined : {
            allow: protocolUrl(protocol.allow), reject: protocolUrl(protocol.reject),
          }),
      } : approval === undefined ? macCloseAction ? {
        actions: [{ type: 'button' as const, text: '关闭' }],
      } : {} : {
        actions: [
          { type: 'button' as const, text: '允许一次' },
          { type: 'button' as const, text: '拒绝' },
        ],
      }),
    })
    return await new Promise<boolean>((resolve) => {
      let settled = false
      let inactive = false
      let answered = false
      let opened = false
      let timeout: NodeJS.Timeout | undefined
      const clearProtocolActions = (): void => {
        if (protocol === undefined) return
        for (const nonce of Object.values(protocol)) this.protocolActions.delete(nonce)
      }
      const release = (close: boolean): void => {
        if (inactive) return
        inactive = true
        this.notifications.delete(notification)
        clearProtocolActions()
        if (close) {
          try { notification.close() } catch (error) {
            console.warn(`[desktop-notifications] native notification close failed: ${String(error)}`)
          }
          // Protocol activation can race the native dismissed event. Electron's
          // close() then only hides the banner; remove its exact history entry too.
          if (process.platform === 'win32') void removeWindowsNotification(notificationId, notificationGroup).catch(() => {
            console.warn('[desktop-notifications] unable to remove notification from Windows history')
          })
        }
      }
      const finish = (shown: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (!shown) release(true)
        resolve(shown)
      }
      const openSession = (): void => {
        if (inactive || answered || opened) return
        opened = true
        if (protocol !== undefined) this.protocolActions.delete(protocol.open)
        try { this.actions.openSession(request.sessionId) } catch (error) {
          console.warn(`[desktop-notifications] unable to open notification session: ${String(error)}`)
        }
      }
      if (protocol === undefined) notification.on('click', openSession)
      else this.protocolActions.set(protocol.open, openSession)
      notification.on('close', (details) => {
        // A protocol activation may arrive through a second process after Windows
        // closes the toast. Only consumption, failure, or capacity eviction expires it.
        if (protocol !== undefined) return
        // Windows can move a timed-out toast into Action Center. Keep approval
        // callbacks alive there; dismissing a toast never answers the request.
        if (approval !== undefined && details?.reason !== 'userCanceled' && details?.reason !== 'applicationHidden') return
        release(false)
        finish(false)
      })
      if (approval !== undefined && answerApproval !== undefined) {
        const answer = (index: number): void => {
          if (inactive || answered) return
          if (index !== 0 && index !== 1) return
          answered = true
          clearProtocolActions()
          void (async () => {
            try {
              await answerApproval(approval, index === 0 ? 'allowed-once' : 'rejected')
            } catch (error) {
              console.warn(`[desktop-notifications] approval action failed: ${String(error)}`)
              try { this.actions.openSession(request.sessionId) } catch (openError) {
                console.warn(`[desktop-notifications] unable to open approval session: ${String(openError)}`)
              }
            } finally {
              release(true)
            }
          })()
        }
        if (protocol === undefined) {
          notification.on('action', (details, legacyActionIndex) => {
            answer(details?.actionIndex === undefined ? legacyActionIndex : details.actionIndex)
          })
        } else {
          if (protocol.allow !== undefined) this.protocolActions.set(protocol.allow, () => answer(0))
          if (protocol.reject !== undefined) this.protocolActions.set(protocol.reject, () => answer(1))
        }
      } else if (macCloseAction) {
        notification.on('action', (details, legacyActionIndex) => {
          const index = details?.actionIndex === undefined ? legacyActionIndex : details.actionIndex
          if (index === 0) release(true)
        })
      }
      notification.once('show', () => finish(true))
      notification.once('failed', (_details, error) => {
        console.warn(`[desktop-notifications] native notification failed: ${error}`)
        release(true)
        finish(false)
      })
      this.notifications.set(notification, () => { finish(false); release(true) })
      while (this.notifications.size > 128) this.notifications.values().next().value?.()
      timeout = setTimeout(() => finish(false), 5_000)
      timeout.unref()
      try { notification.show() } catch (error) {
        console.warn(`[desktop-notifications] native notification show failed: ${String(error)}`)
        finish(false)
      }
    })
  }

  private shouldNotify(kind: DesktopNotificationKind): boolean {
    if (kind === 'approval') return this.settings.permissionRequests
    if (kind === 'question' || kind === 'plan-review') return this.settings.questions
    if (this.settings.turnCompletion === 'never') return false
    if (this.settings.turnCompletion === 'always') return true
    const window = this.actions.getWindow()
    return window === undefined || window.isDestroyed() || window.isMinimized() || !window.isFocused()
  }
}

export function normalizeDesktopNotificationSettings(value: unknown): DesktopNotificationSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_DESKTOP_NOTIFICATION_SETTINGS }
  }
  const candidate = value as Record<string, unknown>
  const turnCompletion = candidate.turnCompletion === 'never'
    || candidate.turnCompletion === 'unfocused'
    || candidate.turnCompletion === 'always'
    ? candidate.turnCompletion
    : DEFAULT_DESKTOP_NOTIFICATION_SETTINGS.turnCompletion
  return {
    turnCompletion,
    permissionRequests: typeof candidate.permissionRequests === 'boolean'
      ? candidate.permissionRequests
      : DEFAULT_DESKTOP_NOTIFICATION_SETTINGS.permissionRequests,
    questions: typeof candidate.questions === 'boolean'
      ? candidate.questions
      : DEFAULT_DESKTOP_NOTIFICATION_SETTINGS.questions,
  }
}

export async function readDesktopNotificationSettings(path: string): Promise<DesktopNotificationSettings> {
  try {
    return normalizeDesktopNotificationSettings(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return { ...DEFAULT_DESKTOP_NOTIFICATION_SETTINGS }
  }
}

export async function writeDesktopNotificationSettings(
  path: string,
  settings: DesktopNotificationSettings,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

function normalizeDesktopNotificationRequest(value: unknown): DesktopNotificationRequest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.kind !== 'turn-complete' && candidate.kind !== 'approval'
    && candidate.kind !== 'question' && candidate.kind !== 'plan-review') return undefined
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0 || candidate.sessionId.length > 240) return undefined
  if (/[\r\n\0]/u.test(candidate.sessionId)) return undefined
  const approval = normalizeApprovalCapability(candidate.approval)
  return {
    kind: candidate.kind,
    sessionId: candidate.sessionId,
    ...(typeof candidate.sessionTitle === 'string' ? { sessionTitle: candidate.sessionTitle } : {}),
    ...(typeof candidate.summary === 'string' && candidate.summary.length <= 4_000
      ? { summary: candidate.summary }
      : {}),
    ...(typeof candidate.key === 'string' && candidate.key.length <= 500 ? { key: candidate.key } : {}),
    ...(candidate.kind === 'approval' && approval !== undefined ? { approval } : {}),
  }
}

function buildWindowsNotificationXml(
  title: string,
  body: string,
  openUrl: string | undefined,
  approval?: { allow: string; reject: string },
): string {
  const actions = approval === undefined
    ? '<actions><action activationType="system" arguments="dismiss" content="关闭"/></actions>'
    : `<actions>`
    + `<action activationType="protocol" arguments="${escapeNotificationXml(approval.allow)}" content="允许一次"/>`
    + `<action activationType="protocol" arguments="${escapeNotificationXml(approval.reject)}" content="拒绝"/>`
    + `</actions>`
  return (openUrl === undefined ? '<toast>' : `<toast activationType="protocol" launch="${escapeNotificationXml(openUrl)}">`)
    + `<visual><binding template="ToastGeneric"><text>${escapeNotificationXml(title)}</text>`
    + `<text>${escapeNotificationXml(body)}</text></binding></visual>${actions}</toast>`
}

function escapeNotificationXml(value: string): string {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/[&<>"']/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    })[character]!)
}

function normalizeApprovalCapability(value: unknown): DesktopNotificationRequest['approval'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(candidate.token)) return undefined
  if (typeof candidate.interactionKey !== 'string' || candidate.interactionKey.trim().length === 0
    || candidate.interactionKey.length > 500 || /[\r\n\0]/u.test(candidate.interactionKey)) return undefined
  return { token: candidate.token, interactionKey: candidate.interactionKey }
}

function normalizeSessionTitle(value: string | undefined): string {
  const normalized = value?.replace(/[\r\n\0]+/gu, ' ').trim().slice(0, 120)
  return normalized === undefined || normalized.length === 0 ? 'DFY DSH Desktop' : normalized
}

function normalizeNotificationPreview(value: string | undefined, fallback: string): string {
  const normalized = value
    ?.replace(/```[^\n]*\n?/gu, ' ')
    .replace(/```/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^[\s>*#+-]+/gmu, '')
    .replace(/[`*_~]/gu, '')
    .replace(/[\r\n\0\t ]+/gu, ' ')
    .trim()
    .slice(0, 240)
  return normalized === undefined || normalized.length === 0 ? fallback : normalized
}
