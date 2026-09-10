import { describe, expect, it } from 'vitest'
import {
  clampContextMenuPosition,
  parsePluginContextMenuCollection,
  sanitizeContextMenuEntries,
} from '../src/shared/context-menu.js'
import { appendPluginContextMenuItems, BUILTIN_CONTEXT_MENU_ACTIONS, buildBuiltinContextMenuItems } from '../src/main/context-menu.js'

describe('desktop context menu protocol', () => {
  it('sanitizes entries and collapses invalid separators', () => {
    expect(sanitizeContextMenuEntries([
      { kind: 'separator', id: 'leading' },
      { kind: 'item', id: 'desktop.copy', label: '复制', icon: 'copy', shortcut: 'Ctrl+C' },
      { kind: 'separator', id: 'group-1' },
      { kind: 'separator', id: 'group-2' },
      { kind: 'item', id: 'plugin.archive', label: '归档', icon: 'not-allowed', danger: false },
      { kind: 'separator', id: 'trailing' },
    ])).toEqual([
      { kind: 'item', id: 'desktop.copy', label: '复制', enabled: true, icon: 'copy' },
      { kind: 'separator', id: 'group-1' },
      { kind: 'item', id: 'plugin.archive', label: '归档', enabled: true, danger: false },
    ])
  })

  it('only accepts namespaced plugin contributions', () => {
    expect(parsePluginContextMenuCollection({
      token: 'menu-1',
      items: [
        { kind: 'item', id: 'desktop.copy', label: '伪造复制' },
        { kind: 'item', id: 'plugin.archive', label: '归档', icon: 'archive' },
      ],
    })).toEqual({
      token: 'menu-1',
      items: [{ kind: 'item', id: 'plugin.archive', label: '归档', enabled: true, icon: 'archive' }],
    })
  })

  it('accepts a sanitized HTTP target contributed by a menu provider', () => {
    expect(parsePluginContextMenuCollection({
      token: 'menu-link',
      items: [],
      linkURL: 'http://127.0.0.1:43210/artifacts/demo/index.html',
    })).toEqual({
      token: 'menu-link',
      items: [],
      linkURL: 'http://127.0.0.1:43210/artifacts/demo/index.html',
    })
    expect(parsePluginContextMenuCollection({
      token: 'menu-file',
      items: [],
      linkURL: 'file:///C:/private/index.html',
    })).toEqual({ token: 'menu-file', items: [], linkURL: 'file:///C:/private/index.html' })
    for (const linkURL of ['file:///C:/private/config.json', 'file://server/share/index.html', 'javascript:alert(1)', 'data:text/html,hello']) {
      expect(parsePluginContextMenuCollection({ token: 'menu-file', items: [], linkURL })).toBeUndefined()
    }
  })

  it('keeps the menu inside the viewport', () => {
    expect(clampContextMenuPosition(790, 590, 220, 180, 800, 600)).toEqual({ x: 572, y: 412 })
    expect(clampContextMenuPosition(-20, -40, 220, 180, 800, 600)).toEqual({ x: 8, y: 8 })
  })

  it('builds a usable core menu without any Harness plugin', () => {
    const items = buildBuiltinContextMenuItems({
      isEditable: true,
      selectionText: 'hello',
      linkURL: '',
      editFlags: {
        canUndo: true,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true,
        canEditRichly: false,
      },
    })

    expect(items.filter((entry) => entry.kind === 'item').map((entry) => [entry.id, entry.enabled])).toEqual([
      ['desktop.undo', true],
      ['desktop.redo', false],
      ['desktop.cut', true],
      ['desktop.copy', true],
      ['desktop.paste', true],
      ['desktop.select-all', true],
    ])
    expect(items.find((entry) => entry.kind === 'item' && entry.id === 'desktop.copy')).not.toHaveProperty('shortcut')
  })

  it('only offers copy outside editable controls when text is selected', () => {
    const snapshot = {
      isEditable: false,
      linkURL: '',
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    }
    const withoutSelection = buildBuiltinContextMenuItems({ ...snapshot, selectionText: '' })
    const withSelection = buildBuiltinContextMenuItems({ ...snapshot, selectionText: 'hello' })

    expect(withoutSelection.some((entry) => entry.kind === 'item' && entry.id === 'desktop.copy')).toBe(false)
    expect(withSelection.some((entry) => entry.kind === 'item' && entry.id === 'desktop.copy')).toBe(true)
  })

  it('separates embedded and default browser link actions', () => {
    const items = buildBuiltinContextMenuItems({
      isEditable: false,
      selectionText: '',
      linkURL: 'https://example.com/',
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    }, { embeddedBrowserEnabled: true })

    expect(items.filter((entry) => entry.kind === 'item').slice(0, 3)).toEqual([
      { kind: 'item', id: 'desktop.open-link-in-browser', label: '在内置浏览器中打开', enabled: true, icon: 'browser' },
      { kind: 'item', id: 'desktop.open-link', label: '在默认浏览器中打开', enabled: true, icon: 'external-link' },
      { kind: 'item', id: 'desktop.copy-link', label: '复制链接地址', enabled: true, icon: 'link' },
    ])
  })

  it('offers image copy, Windows Explorer and a native-save action', () => {
    const items = buildBuiltinContextMenuItems({
      isEditable: false,
      selectionText: '',
      linkURL: '',
      mediaType: 'image',
      hasImageContents: true,
      srcURL: 'blob:http://127.0.0.1/image-preview',
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    }, { platform: 'win32', imageCanReveal: true })

    expect(items.filter((entry) => entry.kind === 'item')).toEqual([
      { kind: 'item', id: 'desktop.copy-image', label: '复制', enabled: true, icon: 'copy' },
      { kind: 'item', id: 'desktop.reveal-image', label: '在资源管理器中打开', enabled: true, icon: 'folder' },
      { kind: 'item', id: 'desktop.save-image', label: '下载副本', enabled: true, icon: 'download' },
    ])
  })

  it('offers image copy when Chromium provides a source before decoded contents', () => {
    const items = buildBuiltinContextMenuItems({
      isEditable: false,
      selectionText: '',
      linkURL: '',
      mediaType: 'image',
      hasImageContents: false,
      srcURL: 'blob:http://127.0.0.1/composer-preview',
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canDelete: false,
        canSelectAll: true,
        canEditRichly: false,
      },
    }, { platform: 'darwin', imageCanReveal: true })

    expect(items.filter((entry) => entry.kind === 'item')).toEqual([
      { kind: 'item', id: 'desktop.copy-image', label: '复制', enabled: true, icon: 'copy' },
      { kind: 'item', id: 'desktop.reveal-image', label: '在访达中显示', enabled: true, icon: 'folder' },
      { kind: 'item', id: 'desktop.save-image', label: '下载副本', enabled: true, icon: 'download' },
    ])
  })

  it('only offers copy and download for memory images on either desktop platform', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const items = buildBuiltinContextMenuItems({
        isEditable: false, selectionText: '', linkURL: '', srcURL: 'blob:http://localhost/image',
        mediaType: 'image', hasImageContents: true,
        editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false,
          canPaste: false, canDelete: false, canSelectAll: true, canEditRichly: false },
      }, { platform })
      expect(items.map((item) => item.id)).toEqual(['desktop.copy-image', 'desktop.save-image'])
    }
  })

  it.each(['none', 'image', 'canvas'] as const)('only includes inspect for explicitly enabled page menus with %s content', (mediaType) => {
    const snapshot = {
      isEditable: false, selectionText: '', linkURL: '', mediaType, hasImageContents: true,
      editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false,
        canPaste: false, canDelete: false, canSelectAll: true, canEditRichly: false },
    }
    for (const options of [{}, { embeddedBrowserEnabled: true }, { inspectElementEnabled: false }]) {
      expect(buildBuiltinContextMenuItems(snapshot, options).some((entry) => entry.id === 'desktop.inspect-element')).toBe(false)
    }
    expect(buildBuiltinContextMenuItems(snapshot, { inspectElementEnabled: true }).slice(-2)).toEqual([
      { kind: 'separator', id: 'desktop.separator.inspect' },
      { kind: 'item', id: 'desktop.inspect-element', label: '检查', enabled: true, icon: 'inspect' },
    ])
    expect(BUILTIN_CONTEXT_MENU_ACTIONS['desktop.inspect-element']).toBe('inspect-element')
  })

  it('places plugin contributions behind a stable separator', () => {
    expect(appendPluginContextMenuItems(
      [{ kind: 'item', id: 'desktop.copy', label: '复制', enabled: true }],
      [{ kind: 'item', id: 'plugin.archive', label: '归档', enabled: true }],
    )).toEqual([
      { kind: 'item', id: 'desktop.copy', label: '复制', enabled: true },
      { kind: 'separator', id: 'desktop.separator.plugins' },
      { kind: 'item', id: 'plugin.archive', label: '归档', enabled: true },
    ])
  })
})
