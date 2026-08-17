import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '../../shared/Icon'

interface FolderActionMenuProps {
  enabled: boolean
  onRename(): void
  onMove(): void
  onDelete(): void
}

export function FolderActionMenu({ enabled, onRename, onMove, onDelete }: FolderActionMenuProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  const close = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus())
  }

  useEffect(() => {
    if (!enabled) setOpen(false)
  }, [enabled])

  useEffect(() => {
    if (!open) return
    itemRefs.current[activeIndex]?.focus()
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false)
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  }, [activeIndex, open])

  const openMenu = (index: number) => {
    setActiveIndex(index)
    setOpen(true)
  }

  const run = (action: () => void, restoreFocus: boolean) => {
    action()
    close(restoreFocus)
  }

  const leaveMenu = (reverse: boolean) => {
    const root = rootRef.current
    const trigger = triggerRef.current
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element === trigger || !root?.contains(element))
    const triggerIndex = trigger === null ? -1 : focusable.indexOf(trigger)
    const destination = triggerIndex < 0
      ? trigger
      : focusable[triggerIndex + (reverse ? -1 : 1)] ?? trigger
    close(false)
    queueMicrotask(() => destination?.focus())
  }

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null
    if (event.key === 'ArrowDown') next = (index + 1) % itemRefs.current.length
    if (event.key === 'ArrowUp') next = (index - 1 + itemRefs.current.length) % itemRefs.current.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = itemRefs.current.length - 1
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      leaveMenu(event.shiftKey)
      return
    }
    if (next === null) return
    event.preventDefault()
    setActiveIndex(next)
    itemRefs.current[next]?.focus()
  }

  const actions = [
    { label: '重命名文件夹', run: onRename, restoreFocus: false },
    { label: '移动文件夹', run: onMove, restoreFocus: false },
    { label: '删除空文件夹', run: onDelete, danger: true, restoreFocus: true },
  ]

  return (
    <div
      ref={rootRef}
      className="folder-action-menu"
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label="文件夹更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!enabled}
        onClick={() => {
          if (open) close(false)
          else openMenu(0)
        }}
        onKeyDown={(event) => {
          if (enabled && !open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            openMenu(event.key === 'ArrowUp' ? actions.length - 1 : 0)
          }
        }}
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div role="menu" aria-label="文件夹操作" className="folder-action-menu__popover">
          {actions.map((action, index) => (
            <button
              key={action.label}
              ref={(node) => { itemRefs.current[index] = node }}
              role="menuitem"
              type="button"
              tabIndex={activeIndex === index ? 0 : -1}
              data-variant={action.danger ? 'danger' : undefined}
              className={action.danger ? 'folder-action-menu__item folder-action-menu__item--danger' : 'folder-action-menu__item'}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={(event) => moveFocus(event, index)}
              onClick={() => run(action.run, action.restoreFocus)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
