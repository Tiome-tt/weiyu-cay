import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../../shared/Icon'

interface EditorActionsMenuProps {
  children(close: () => void): ReactNode
}

const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

/** Compact disclosure for metadata actions that should not compete with the writing surface. */
export function EditorActionsMenu({ children }: EditorActionsMenuProps) {
  const [open, setOpen] = useState(false)
  const focusEdgeRef = useRef<'first' | 'last'>('first')
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = (restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus())
  }

  const openMenu = (edge: 'first' | 'last') => {
    focusEdgeRef.current = edge
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const focusable = menuRef.current?.querySelectorAll<HTMLElement>(focusableSelector)
    const target = focusEdgeRef.current === 'last' ? focusable?.[focusable.length - 1] : focusable?.[0]
    target?.focus()

    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false)
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  }, [open])

  const leaveMenu = (reverse: boolean) => {
    const root = rootRef.current
    const trigger = triggerRef.current
    const pageFocusable = Array.from(document.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => element === trigger || !root?.contains(element))
    const triggerIndex = trigger === null ? -1 : pageFocusable.indexOf(trigger)
    const destination = triggerIndex < 0
      ? trigger
      : pageFocusable[triggerIndex + (reverse ? -1 : 1)] ?? trigger
    close(false)
    queueMicrotask(() => destination?.focus())
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const leavingBackward = event.shiftKey && document.activeElement === first
    const leavingForward = !event.shiftKey && document.activeElement === last
    if (!leavingBackward && !leavingForward) return
    event.preventDefault()
    leaveMenu(event.shiftKey)
  }

  return (
    <div
      ref={rootRef}
      className="editor-actions-menu"
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="icon-button editor-actions-menu__trigger"
        aria-label="笔记更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="笔记更多操作"
        onClick={() => {
          if (open) close(false)
          else openMenu('first')
        }}
        onKeyDown={(event) => {
          if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
          event.preventDefault()
          openMenu(event.key === 'ArrowUp' ? 'last' : 'first')
        }}
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="笔记操作"
          className="editor-actions-menu__popover"
          onKeyDown={handleMenuKeyDown}
        >
          {children(() => close())}
        </div>
      )}
    </div>
  )
}
