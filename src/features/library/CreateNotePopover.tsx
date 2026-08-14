import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import type { Folder, FolderId } from '../../domain/model'

export interface CreateNotePopoverProps {
  folders: Folder[]
  initialFolderId: FolderId | null
  triggerRef: RefObject<HTMLButtonElement | null>
  onCreate(title: string, folderId: FolderId | null): Promise<void>
  onClose(): void
}

export function CreateNotePopover({ folders, initialFolderId, triggerRef, onCreate, onClose }: CreateNotePopoverProps) {
  const [title, setTitle] = useState('')
  const [folderId, setFolderId] = useState<FolderId | null>(initialFolderId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  const close = () => {
    onClose()
    triggerRef.current?.focus()
  }

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    if (busy) titleRef.current?.focus()
  }, [busy])

  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => {
      if (busy || popoverRef.current?.contains(event.target as Node)) return
      close()
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const normalizedTitle = title.trim()
    if (busy || normalizedTitle.length === 0) return
    setBusy(true)
    setError(false)
    try {
      await onCreate(normalizedTitle, folderId)
      setBusy(false)
      close()
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (busy) return
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      popoverRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)') ?? [],
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="true"
      aria-busy={busy}
      aria-labelledby="create-note-title"
      className="create-note-popover"
      onKeyDown={keepFocusInside}
    >
      <form aria-label="新建笔记" onSubmit={(event) => void submit(event)}>
        <h2 id="create-note-title">新建笔记</h2>
        <label>
          <span>笔记标题</span>
          <input
            ref={titleRef}
            aria-label="笔记标题"
            readOnly={busy}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          <span>保存到目录</span>
          <select
            aria-label="保存到目录"
            disabled={busy}
            value={folderId ?? ''}
            onChange={(event) => setFolderId((event.target.value || null) as FolderId | null)}
          >
            <option value="">未归档笔记</option>
            {folders
              .slice()
              .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
              .map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
        </label>
        {busy && <p role="status">正在创建笔记…</p>}
        {error && <p role="alert">无法新建笔记，请重试。</p>}
        <div className="create-note-popover__actions">
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button
            type="submit"
            aria-label={busy ? '正在创建笔记' : '创建笔记'}
            disabled={busy || title.trim().length === 0}
          >
            {busy ? '正在创建…' : '创建笔记'}
          </button>
        </div>
      </form>
    </div>
  )
}
