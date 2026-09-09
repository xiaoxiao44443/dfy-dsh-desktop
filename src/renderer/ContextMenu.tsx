import {
  Archive,
  Check,
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Link,
  MousePointer2,
  PanelRightOpen,
  Pencil,
  Puzzle,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Scissors,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { clampContextMenuPosition } from '../shared/context-menu.js'
import type { ContextMenuIcon, DesktopContextMenuRequest } from '../shared/context-menu.js'

const menuIcons: Record<ContextMenuIcon, LucideIcon> = {
  copy: Copy,
  cut: Scissors,
  paste: ClipboardPaste,
  undo: RotateCcw,
  redo: RotateCw,
  'select-all': MousePointer2,
  'external-link': ExternalLink,
  browser: PanelRightOpen,
  link: Link,
  plugin: Puzzle,
  archive: Archive,
  trash: Trash2,
  edit: Pencil,
  folder: FolderOpen,
  settings: Settings,
  terminal: Terminal,
  sparkles: Sparkles,
  refresh: RefreshCw,
  download: Download,
}

interface ContextMenuProps {
  menu: DesktopContextMenuRequest
  onSelect: (itemId: string) => void
  presentationPending?: boolean
  presentationSynchronized?: boolean
}

export function ContextMenu({ menu, onSelect, presentationPending = false, presentationSynchronized = false }: ContextMenuProps): ReactNode {
  const card = useRef<HTMLElement>(null)
  const [position, setPosition] = useState({ x: menu.x, y: menu.y })

  useLayoutEffect(() => {
    const place = (): void => {
      const element = card.current
      if (element === null) return
      const next = clampContextMenuPosition(
        menu.x,
        menu.y,
        element.offsetWidth,
        element.offsetHeight,
        window.innerWidth,
        window.innerHeight,
      )
      setPosition((current) => current.x === next.x && current.y === next.y ? current : next)
    }
    place()
    // Contributions arrive after the initial menu. Reposition before paint,
    // then keep tracking dimensions when fonts or the available space change.
    const observer = new ResizeObserver(place)
    if (card.current !== null) observer.observe(card.current)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [menu.requestId, menu.x, menu.y, menu.items])

  return (
    <section
      ref={card}
      className={`context-menu-card${presentationPending ? ' shell-overlay-pending' : ''}${presentationSynchronized ? ' shell-overlay-synchronized' : ''}`}
      role="menu"
      aria-label="右键菜单"
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((entry) => {
        if (entry.kind === 'separator') return <div className="context-menu-separator" role="separator" key={entry.id} />
        const Icon = entry.icon === undefined ? undefined : menuIcons[entry.icon]
        return (
          <button
            className={`context-menu-item${entry.danger === true ? ' danger' : ''}`}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            disabled={!entry.enabled}
            tabIndex={-1}
            key={entry.id}
            onAuxClick={(event) => event.preventDefault()}
            onClick={(event) => {
              if (event.button !== 0) {
                event.preventDefault()
                return
              }
              onSelect(entry.id)
            }}
          >
            <span className="context-menu-icon" aria-hidden="true">
              {entry.checked === true ? <Check /> : Icon === undefined ? null : <Icon />}
            </span>
            <span className="context-menu-label">{entry.label}</span>
          </button>
        )
      })}
    </section>
  )
}
