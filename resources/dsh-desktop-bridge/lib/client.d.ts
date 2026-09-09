import { Service, type Context } from '@deepseek-ai/cordis'

export type DesktopContextMenuIcon =
  | 'copy'
  | 'cut'
  | 'paste'
  | 'undo'
  | 'redo'
  | 'select-all'
  | 'external-link'
  | 'link'
  | 'plugin'
  | 'archive'
  | 'trash'
  | 'edit'
  | 'folder'
  | 'settings'
  | 'terminal'
  | 'sparkles'
  | 'refresh'

export interface DesktopContextMenuContext {
  target: Element
  editableElement: HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
  editable: boolean
  selectionText: string
  linkUrl: string
  x: number
  y: number
  event: MouseEvent
}

type ContextValue<T> = T | ((context: DesktopContextMenuContext) => T)

export interface DesktopContextMenuContribution {
  id: string
  label: ContextValue<string>
  linkURL?: ContextValue<string>
  icon?: DesktopContextMenuIcon
  group?: string
  order?: number
  when?: (context: DesktopContextMenuContext) => boolean
  enabled?: ContextValue<boolean>
  checked?: ContextValue<boolean>
  danger?: ContextValue<boolean>
  onSelect(context: DesktopContextMenuContext): void | Promise<void>
}

export declare class DesktopContextMenuService extends Service {
  readonly version: 1
  readonly icons: readonly DesktopContextMenuIcon[]
  constructor(ctx: Context)
  register(contribution: DesktopContextMenuContribution): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopContextMenu: DesktopContextMenuService
  }
}

export declare const name = 'desktop-notifications'
export declare const inject: readonly ['slots', 'sessions', 'cordisInspect']
export declare function latestAssistantReply(binding: unknown): string | undefined
export declare function latestAssistantMarker(binding: unknown): unknown
export declare function waitForAssistantReply(binding: unknown, baseline: unknown, timeoutMs?: number): Promise<string | undefined>
export declare function pendingInteractionSummary(binding: unknown, status: 'approval' | 'question' | 'plan-review'): string | undefined
export declare function installSessionOpenFeedback(sessions: { open(id: string): void }, report: (message: string) => void): () => void
export declare function apply(ctx: Context): void
