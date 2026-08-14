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
    itemRefs.current[0]?.focus()
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false)
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  }, [open])

  const run = (action: () => void) => {
    action()
    close(false)
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
    if (next === null) return
    event.preventDefault()
    itemRefs.current[next]?.focus()
  }

  const actions = [
    { label: '重命名文件夹', run: onRename },
    { label: '移动文件夹', run: onMove },
    { label: '删除空文件夹', run: onDelete, danger: true },
  ]

  return (
    <div ref={rootRef} className="folder-action-menu">
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label="文件夹更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!enabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (enabled && !open && event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
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
              data-variant={action.danger ? 'danger' : undefined}
              className={action.danger ? 'folder-action-menu__item folder-action-menu__item--danger' : 'folder-action-menu__item'}
              onKeyDown={(event) => moveFocus(event, index)}
              onClick={() => run(action.run)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
