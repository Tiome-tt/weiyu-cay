import {text as uiText} from '../../shared/i18n'
import { ErrorNotification } from '../../shared/notifications'
import type { NewNoteFormat } from '../../domain/content'
import { useEffect, useRef, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import type { Folder, FolderId } from '../../domain/model'

export interface CreateNoteDraft {
  format: NewNoteFormat
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
  onCreate(title: string, folderId: FolderId | null, tags: string[], format: NewNoteFormat): void
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
    onCreate(normalizedTitle, draft.folderId, normalizeTagText(draft.tags), draft.format)
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
      <form aria-label={uiText("新建笔记","New note")} onSubmit={submit}>
        <h2 id="create-note-title">{uiText("新建笔记","New note")}</h2>
        <label>
          <span>{uiText("笔记标题","Note title")}</span>
          <input
            ref={titleRef}
            aria-label={uiText("笔记标题","Note title")}
            readOnly={busy}
            value={draft.title}
            onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
          />
        </label>
        <label>
          <span>{uiText("保存到目录","Save in folder")}</span>
          <select
            aria-label={uiText("保存到目录","Save in folder")}
            disabled={busy}
            value={draft.folderId ?? ''}
            onChange={(event) => onDraftChange({ ...draft, folderId: (event.target.value || null) as FolderId | null })}
          >
            <option value="" disabled hidden>{folders.length === 0 ? uiText("请先创建文件夹","Create a folder first") : uiText("请选择文件夹","Choose a folder")}</option>
            {folders
              .slice()
              .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
              .map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
        </label>
        <label>
          <span>{uiText("内容类型","Content type")}</span>
          <select aria-label={uiText("内容类型","Content type")} disabled={busy} value={draft.format} onChange={e => onDraftChange({...draft, format:e.target.value as NewNoteFormat})}>
            <option value="document">{uiText("文档","Document")}</option><option value="markdown">Markdown</option><option value="text">{uiText("纯文本","Plain text")}</option>
          </select>
        </label>
        <label>
          <span>{uiText("标签（可选）","Tags (optional)")}</span>
          <input
            aria-label={uiText("笔记标签","Note tags")}
            readOnly={busy}
            placeholder={uiText("例如：项目，设计","For example: project, design")}
            value={draft.tags}
            onChange={(event) => onDraftChange({ ...draft, tags: event.target.value })}
          />
        </label>
        {busy && <p role="status">{uiText("正在创建笔记…","Creating note…")}</p>}
        <ErrorNotification error={status === 'error' ? uiText("无法新建笔记，请重试。","Could not create a note. Try again.") : null} />
        <div className="create-note-popover__actions">
          <button type="button" onClick={close}>{uiText("取消","Cancel")}</button>
          <button
            type="submit"
            aria-label={busy ? uiText("正在创建笔记","Creating note") : uiText("创建笔记","Create note")}
            disabled={busy || !hasFolder || draft.title.trim().length === 0}
          >
            {busy ? uiText("正在创建…","Creating…") : uiText("创建笔记","Create note")}
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
