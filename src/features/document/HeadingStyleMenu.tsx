import { useEffect, useRef, useState } from 'react'

interface HeadingStyleMenuProps {
  level: number
  onChange(level: number): void
}

/** An app menu avoids platform select hover colors and keeps the H trigger stable. */
export function HeadingStyleMenu({ level, onChange }: HeadingStyleMenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const keyboardOpen = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    if (keyboardOpen.current) root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
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
  const close = () => { setOpen(false); trigger.current?.focus() }
  return <div ref={root} className="rich-document__heading-menu">
    <button ref={trigger} type="button" className="rich-document__heading-trigger" aria-label="段落样式" title="段落样式" aria-haspopup="menu" aria-expanded={open} onMouseDown={(event) => event.preventDefault()} onClick={() => { keyboardOpen.current = false; setOpen((current) => !current) }} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); keyboardOpen.current = true; setOpen(true) }
    }}><strong aria-hidden="true">H</strong><svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"><path d="m4 6 4 4 4-4" /></svg></button>
    {open && <div className="rich-document__heading-options" role="menu" aria-label="段落样式" onKeyDown={(event) => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); close(); return }
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
      if (next !== null) { event.preventDefault(); items[next]?.focus() }
    }}>{[0, 1, 2, 3, 4, 5, 6].map((value) => <button key={value} type="button" role="menuitemradio" aria-checked={level === value} onClick={() => { setOpen(false); onChange(value) }}><span>{value === 0 ? '正文' : '标题 ' + value}</span><span aria-hidden="true">{level === value ? '✓' : ''}</span></button>)}</div>}
  </div>
}
