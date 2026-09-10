import type { ContextMenuParams } from 'electron'
import type { ContextMenuActionEntry, ContextMenuEntry } from '../shared/context-menu.js'
import { isSupportedBrowserUrl } from '../shared/browser-address.js'

export type BuiltinContextMenuAction =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'copy-image'
  | 'reveal-image'
  | 'save-image'
  | 'paste'
  | 'select-all'
  | 'open-link-in-browser'
  | 'open-link'
  | 'copy-link'
  | 'inspect-element'

export const BUILTIN_CONTEXT_MENU_ACTIONS: Readonly<Record<string, BuiltinContextMenuAction>> = {
  'desktop.undo': 'undo',
  'desktop.redo': 'redo',
  'desktop.cut': 'cut',
  'desktop.copy': 'copy',
  'desktop.copy-image': 'copy-image',
  'desktop.reveal-image': 'reveal-image',
  'desktop.save-image': 'save-image',
  'desktop.paste': 'paste',
  'desktop.select-all': 'select-all',
  'desktop.open-link-in-browser': 'open-link-in-browser',
  'desktop.open-link': 'open-link',
  'desktop.copy-link': 'copy-link',
  'desktop.inspect-element': 'inspect-element',
}

type ContextMenuSnapshot = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'linkURL' | 'editFlags'>
  & Partial<Pick<ContextMenuParams, 'mediaType' | 'hasImageContents' | 'srcURL'>>

function action(
  id: string,
  label: string,
  icon: ContextMenuActionEntry['icon'],
  enabled: boolean,
): ContextMenuActionEntry {
  return {
    kind: 'item',
    id,
    label,
    enabled,
    ...(icon === undefined ? {} : { icon }),
  }
}

function appendGroup(items: ContextMenuEntry[], group: ContextMenuActionEntry[], id: string): void {
  if (group.length === 0) return
  if (items.length > 0) items.push({ kind: 'separator', id: `desktop.separator.${id}` })
  items.push(...group)
}

export function buildBuiltinContextMenuItems(
  snapshot: ContextMenuSnapshot,
  options: { embeddedBrowserEnabled?: boolean; platform?: NodeJS.Platform; imageCanReveal?: boolean; inspectElementEnabled?: boolean } = {},
): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = []
  const copyableImage = (snapshot.mediaType === 'image'
      && (snapshot.hasImageContents === true || Boolean(snapshot.srcURL)))
    || snapshot.mediaType === 'canvas'
  if (isSupportedBrowserUrl(snapshot.linkURL)) {
    appendGroup(items, [
      action('desktop.open-link-in-browser', '在内置浏览器中打开', 'browser', options.embeddedBrowserEnabled === true),
      action('desktop.open-link', '在默认浏览器中打开', 'external-link', true),
      action('desktop.copy-link', '复制链接地址', 'link', true),
    ], 'link')
  }

  if (copyableImage) {
    const platform = options.platform ?? process.platform
    const revealLabel = platform === 'darwin' ? '在访达中显示'
      : platform === 'win32' ? '在资源管理器中打开' : '在文件管理器中显示'
    appendGroup(items, [
      action('desktop.copy-image', '复制', 'copy', true),
      ...(options.imageCanReveal === true ? [action('desktop.reveal-image', revealLabel, 'folder', true)] : []),
      action('desktop.save-image', '下载副本', 'download', true),
    ], 'image')
  }

  if (!copyableImage && snapshot.isEditable) {
    appendGroup(items, [
      action('desktop.undo', '撤销', 'undo', snapshot.editFlags.canUndo),
      action('desktop.redo', '重做', 'redo', snapshot.editFlags.canRedo),
    ], 'history')
    appendGroup(items, [
      action('desktop.cut', '剪切', 'cut', snapshot.editFlags.canCut),
      action('desktop.copy', '复制', 'copy', snapshot.editFlags.canCopy),
      action('desktop.paste', '粘贴', 'paste', snapshot.editFlags.canPaste),
    ], 'edit')
  } else if (!copyableImage && snapshot.selectionText.length > 0) {
    appendGroup(items, [
      action('desktop.copy', '复制', 'copy', true),
    ], 'copy')
  }

  if (!copyableImage) {
    appendGroup(items, [
      action('desktop.select-all', '全选', 'select-all', snapshot.editFlags.canSelectAll),
    ], 'selection')
  }
  if (options.inspectElementEnabled === true) {
    appendGroup(items, [
      action('desktop.inspect-element', '检查', 'inspect', true),
    ], 'inspect')
  }
  return items
}

export function appendPluginContextMenuItems(
  builtins: readonly ContextMenuEntry[],
  pluginItems: readonly ContextMenuEntry[],
): ContextMenuEntry[] {
  if (pluginItems.length === 0) return [...builtins]
  return [
    ...builtins,
    ...(builtins.length === 0 ? [] : [{ kind: 'separator' as const, id: 'desktop.separator.plugins' }]),
    ...pluginItems,
  ]
}
