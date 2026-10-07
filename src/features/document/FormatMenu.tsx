import { useEffect, useRef, useState } from 'react'

interface FormatMenuProps {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange(value: string): void
  compact?: boolean
}

/** Pointer opening preserves the editor selection; keyboard opening focuses the current choice. */
export function FormatMenu({ label, value, options, onChange, compact = false }: FormatMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const keyboardOpen = useRef(false)
  useEffect(() => {
    if (!open) return
    if (keyboardOpen.current) {
      (root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus()
    }
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div ref={root} className={`rich-document__format-menu${compact ? ' rich-document__format-menu--compact' : ''}`}>
    <button ref={trigger} type="button" className="rich-document__format-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { keyboardOpen.current = false; setOpen(current => !current) }}
      onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); keyboardOpen.current = true; setOpen(true)
        } else if (event.key === 'Escape') setOpen(false)
      }}>
      {!compact && <span>{options.find(option => option.value === value)?.label ?? label}</span>}
      <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && <div className="rich-document__heading-options rich-document__format-options" role="menu" aria-label={label} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault()
        setOpen(false); trigger.current?.focus(); return
      }
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
      if (next !== null) { event.preventDefault(); items[next]?.focus() }
    }}>
      {options.map(option => <button type="button" key={option.value} role="menuitemradio" aria-checked={option.value === value}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { setOpen(false); onChange(option.value) }}>
        <span>{option.label}</span><span aria-hidden="true">{option.value === value ? '✓' : ''}</span>
      </button>)}
    </div>}
  </div>
}
