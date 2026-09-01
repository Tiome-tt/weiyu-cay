import { useEffect, useRef, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import type { Folder, FolderId } from '../../domain/model'

export interface CreateNoteDraft {
  title: string
  folderId: FolderId | null
  tags: string
}

export type CreateNoteStatus = 'idle' | 'pending' | 'error'

export interface CreateNotePopoverProps {
  folders: Folder[]
  draft: CreateNoteDraft
  status: CreateNoteStatus
  triggerRef: RefObject<HTMLButtonElement | null>
  onDraftChange(draft: CreateNoteDraft): void
  onCreate(title: string, folderId: FolderId | null, tags: string[]): void
  onClose(): void
}

export function CreateNotePopover({
  folders,
  draft,
  status,
  triggerRef,
  onDraftChange,
  onCreate,
  onClose,
}: CreateNotePopoverProps) {
  const busy = status === 'pending'
  const hasFolder = folders.some((folder) => folder.id === draft.folderId)
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
      if (popoverRef.current?.contains(event.target as Node)) return
      close()
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const normalizedTitle = draft.title.trim()
    if (busy || !hasFolder || normalizedTitle.length === 0) return
    onCreate(normalizedTitle, draft.folderId, normalizeTagText(draft.tags))
  }

  const keepFocusInside = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
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
      <form aria-label="新建笔记" onSubmit={submit}>
        <h2 id="create-note-title">新建笔记</h2>
        <label>
          <span>笔记标题</span>
          <input
            ref={titleRef}
            aria-label="笔记标题"
            readOnly={busy}
            value={draft.title}
            onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
          />
        </label>
        <label>
          <span>保存到目录</span>
          <select
            aria-label="保存到目录"
            disabled={busy}
            value={draft.folderId ?? ''}
            onChange={(event) => onDraftChange({ ...draft, folderId: (event.target.value || null) as FolderId | null })}
          >
            <option value="" disabled hidden>{folders.length === 0 ? '请先创建文件夹' : '请选择文件夹'}</option>
            {folders
              .slice()
              .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
              .map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
        </label>
        <label>
          <span>标签（可选）</span>
          <input
            aria-label="笔记标签"
            readOnly={busy}
            placeholder="例如：项目，设计"
            value={draft.tags}
            onChange={(event) => onDraftChange({ ...draft, tags: event.target.value })}
          />
        </label>
        {busy && <p role="status">正在创建笔记…</p>}
        {status === 'error' && <p role="alert">无法新建笔记，请重试。</p>}
        <div className="create-note-popover__actions">
          <button type="button" onClick={close}>取消</button>
          <button
            type="submit"
            aria-label={busy ? '正在创建笔记' : '创建笔记'}
            disabled={busy || !hasFolder || draft.title.trim().length === 0}
          >
            {busy ? '正在创建…' : '创建笔记'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function normalizeTagText(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\s,，;；]+/u)
      .map((tag) => tag.replace(/^#+/u, '').trim())
      .filter((tag) => tag.length > 0),
  ))
}
