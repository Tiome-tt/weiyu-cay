import { libraryEntryPresentation } from './libraryEntries'
import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Folder, FolderId, NoteId, NoteSummary } from '../../domain/model'
import { Icon, type IconName } from '../../shared/Icon'

export function reorderNoteIds(ids: NoteId[], draggedId: NoteId, targetId: NoteId, placement: 'before' | 'after'): NoteId[] {
  if (draggedId === targetId || !ids.includes(draggedId) || !ids.includes(targetId)) return [...ids]
  const withoutDragged = ids.filter((id) => id !== draggedId)
  const targetIndex = withoutDragged.indexOf(targetId)
  if (targetIndex < 0) return [...ids]
  withoutDragged.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, draggedId)
  return withoutDragged
}

type NoteDropTarget = { noteId?: NoteId; folderId?: FolderId; placement?: 'before' | 'after' }

const EMPTY_SELECTION = new Set<NoteId>()
function isPdfFileEntry(note: NoteSummary): boolean {
  return note.content?.type === 'file'
    && (note.content.file.mediaType === 'application/pdf' || /\.pdf$/i.test(note.content.file.originalName))
}

function canExportPdf(note: NoteSummary): boolean {
  return note.content?.type !== 'file' || isPdfFileEntry(note)
}

interface NoteListProps {
  notes: NoteSummary[]
  activeId: NoteId | null
  state: 'loading' | 'ready' | 'error'
  onSelect: (id: NoteId) => void
  onDelete?: (id: NoteId, title: string) => void
  onDeleteSelection?: (notes: NoteSummary[]) => void
  onMoveSelection?: (ids: NoteId[], folderId: FolderId) => Promise<void>
  folders?: Folder[]
  deletingId?: NoteId | null
  deleteError?: string | null
  deleteFeedback?: string | null
  undoAvailable?: boolean
  undoBusy?: boolean
  onUndoDelete?: () => void
  onDismissFeedback?: () => void
  folderId?: FolderId | null
  onReorder?: (folderId: FolderId | null, orderedIds: NoteId[]) => Promise<void>
  onMoveToFolder?: (noteId: NoteId, folderId: FolderId) => Promise<void>
  onExport?: (note: NoteSummary, kind: 'word' | 'pdf') => void
  showEmptyState?: boolean
}
export function NoteList({ notes, activeId, state, onSelect, onDelete, onDeleteSelection, onMoveSelection, folders, deletingId = null, deleteError = null, deleteFeedback = null, undoAvailable = false, undoBusy = false, onUndoDelete, onDismissFeedback, folderId = null, onReorder, onMoveToFolder, onExport, showEmptyState = true }: NoteListProps) {
  const feedbackRef = useRef<HTMLParagraphElement>(null)
  const contextTriggerRef = useRef<HTMLButtonElement | null>(null)
  const pointerStartRef = useRef<{ id: NoteId; x: number; y: number } | null>(null)
  const pointerDragRef = useRef<NoteId | null>(null)
  const pointerTargetRef = useRef<NoteDropTarget | null>(null)
  const suppressClickRef = useRef(false)
  const selectionAnchorRef = useRef<NoteId | null>(null)
  const selectionActiveIdRef = useRef<NoteId | null | undefined>(undefined)
  const [draggingId, setDraggingId] = useState<NoteId | null>(null)
  const [dropTarget, setDropTarget] = useState<NoteDropTarget | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<NoteId>>(new Set())
  const [contextTarget, setContextTarget] = useState<NoteSummary | null>(null)
  const [contextPosition, setContextPosition] = useState<{ x: number; y: number } | null>(null)
  const [moveFolderId, setMoveFolderId] = useState<FolderId | ''>('')
  useEffect(() => {
    if (deleteFeedback !== null) feedbackRef.current?.focus()
  }, [deleteFeedback])

  useEffect(() => {
    const visible = new Set(notes.map((note) => note.id))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
    if (selectionAnchorRef.current !== null && !visible.has(selectionAnchorRef.current)) selectionAnchorRef.current = null
  }, [notes])

  useLayoutEffect(() => {
    const activeIsVisible = activeId !== null && notes.some((note) => note.id === activeId)
    const activeChanged = selectionActiveIdRef.current !== activeId
    selectionActiveIdRef.current = activeId
    selectionAnchorRef.current = activeIsVisible ? activeId : null
    setSelectedIds((current) => {
      if (!activeIsVisible) return activeChanged && current.size > 0 ? new Set() : current
      if (!activeChanged && current.size > 0) return current
      return new Set([activeId])
    })
  }, [activeId, notes])

  useEffect(() => {
    if (deleteFeedback === null || onDismissFeedback === undefined) return
    const timer = window.setTimeout(onDismissFeedback, 10000)
    return () => window.clearTimeout(timer)
  }, [deleteFeedback, onDismissFeedback])

  useEffect(() => {
    if (contextTarget === null) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (document.querySelector('.note-context-menu')?.contains(target)) return
      setContextTarget(null)
      setContextPosition(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [contextTarget])

  useEffect(() => {
    setMoveFolderId('')
  }, [contextTarget])

  useLayoutEffect(() => {
    if (contextTarget === null || contextPosition === null) return
    const menu = document.querySelector<HTMLElement>('.note-context-menu')
    if (menu === null) return
    const margin = 8
    const x = Math.max(margin, Math.min(contextPosition.x, window.innerWidth - menu.offsetWidth - margin))
    const y = Math.max(margin, Math.min(contextPosition.y, window.innerHeight - menu.offsetHeight - margin))
    if (x !== contextPosition.x || y !== contextPosition.y) setContextPosition({ x, y })
  }, [contextTarget, contextPosition])

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: NoteId) => {
    if (event.button !== 0 || (onReorder === undefined && onMoveToFolder === undefined)) return
    pointerStartRef.current = { id, x: event.clientX, y: event.clientY }
    pointerDragRef.current = null
    pointerTargetRef.current = null
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const start = pointerStartRef.current
      if (start === null) return
      if (pointerDragRef.current === null && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) >= 5) {
        pointerDragRef.current = start.id
        setDraggingId(start.id)
        suppressClickRef.current = true
      }
      if (pointerDragRef.current !== null) {
        moveEvent.preventDefault()
        const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        const noteTarget = element?.closest<HTMLElement>('[data-note-id]')
        const folderTarget = element?.closest<HTMLElement>('[data-folder-id]')
        const listTarget = element?.closest<HTMLElement>('[data-note-list]')
        if (folderTarget?.dataset.folderId !== undefined) {
          const target = { folderId: folderTarget.dataset.folderId as FolderId }
          pointerTargetRef.current = target
          setDropTarget(target)
        } else if (noteTarget?.dataset.noteId !== undefined) {
          const box = noteTarget.getBoundingClientRect()
          const placement: 'before' | 'after' = moveEvent.clientY < box.top + box.height / 2 ? 'before' : 'after'
          const target = { noteId: noteTarget.dataset.noteId as NoteId, placement }
          pointerTargetRef.current = target
          setDropTarget(target)
        } else if (listTarget !== undefined && listTarget !== null && notes.length > 0) {
          const rows = [...listTarget.querySelectorAll<HTMLElement>('[data-note-id]')]
          const first = rows[0]
          const last = rows[rows.length - 1]
          if (first !== undefined && last !== undefined) {
            const firstBox = first.getBoundingClientRect()
            const lastBox = last.getBoundingClientRect()
            const target = moveEvent.clientY < firstBox.top + firstBox.height / 2
              ? { noteId: first.dataset.noteId as NoteId, placement: 'before' as const }
              : { noteId: last.dataset.noteId as NoteId, placement: 'after' as const }
            pointerTargetRef.current = target
            setDropTarget(target)
            void lastBox
          }
        } else {
          pointerTargetRef.current = null
          setDropTarget(null)
        }
      }
    }
    const onUp = () => {
      const dragged = pointerDragRef.current
      const target = pointerTargetRef.current
      pointerStartRef.current = null
      pointerDragRef.current = null
      pointerTargetRef.current = null
      setDraggingId(null)
      setDropTarget(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      if (dragged !== null && target !== null) {
        if (target.folderId !== undefined && onMoveToFolder !== undefined) void onMoveToFolder(dragged, target.folderId)
        else if (target.noteId !== undefined && target.placement !== undefined && onReorder !== undefined) {
          const ids = reorderNoteIds(notes.map((note) => note.id), dragged, target.noteId, target.placement)
          if (ids.some((id, index) => id !== notes[index]?.id)) void onReorder(folderId, ids)
        }
      }
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp, { once: true })
    window.addEventListener('pointercancel', onUp, { once: true })
    window.addEventListener('blur', onUp, { once: true })
  }

  const toggleSelection = (id: NoteId) => {
    selectionAnchorRef.current = id
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectRange = (id: NoteId) => {
    const anchor = selectionAnchorRef.current
    const anchorIndex = anchor === null ? -1 : notes.findIndex((note) => note.id === anchor)
    const targetIndex = notes.findIndex((note) => note.id === id)
    if (anchorIndex < 0 || targetIndex < 0) {
      selectionAnchorRef.current = id
      setSelectedIds(new Set([id]))
      return
    }
    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
    setSelectedIds(new Set(notes.slice(start, end + 1).map((note) => note.id)))
  }

  // Do not paint a selection from the previous navigation while the active-note
  // synchronization effect is waiting to run. The current note remains visible
  // through aria-current, while stale single-folder selection cannot leak across
  // startup, search, outline, or internal-link navigation.
  const selectionIsSynchronized = selectionActiveIdRef.current === activeId
  const effectiveSelectedIds = selectionIsSynchronized ? selectedIds : EMPTY_SELECTION
  const selectedEntries = notes.filter((note) => effectiveSelectedIds.has(note.id))
  const contextSelection = contextTarget !== null && effectiveSelectedIds.has(contextTarget.id)
    ? selectedEntries
    : contextTarget === null ? [] : [contextTarget]
  const selectionCount = contextSelection.length

  return (
    <section aria-label="笔记列表" className="note-list">
      {deleteFeedback && createPortal(
        <div className="note-list__mutation-status">
          <span className="note-list__mutation-icon" aria-hidden="true"><Icon name="note" size={18} /></span><p ref={feedbackRef} role="status" tabIndex={-1} title={deleteFeedback}>{deleteFeedback}</p>
          <div className="note-list__mutation-actions">
            {undoAvailable && onUndoDelete && <button type="button" disabled={undoBusy || deletingId !== null} onClick={onUndoDelete}>{undoBusy ? '正在撤销…' : '撤销删除'}</button>}
            {onDismissFeedback && <button type="button" aria-label="关闭提示" onClick={onDismissFeedback}><Icon name="close" size={15} /></button>}
          </div>
        </div>, document.querySelector('.main-window') ?? document.body
      )}
      {deleteError && <p role="alert" className="library-status library-status--error">{deleteError}</p>}
      {effectiveSelectedIds.size > 1 && <p className="library-status note-list__selection-status" role="status">已选择 {effectiveSelectedIds.size} 项</p>}
      {state === 'loading' && <p className="library-status">正在加载笔记…</p>}
      {state === 'error' && <p className="library-status library-status--error">无法加载笔记。</p>}
      {showEmptyState && state === 'ready' && notes.length === 0 && <p className="library-status">此文件夹中还没有笔记。</p>}
      {state === 'ready' && notes.length > 0 && (
        <ul className="note-list__items" data-note-list>
          {notes.map((note) => (
            <li key={note.id} data-note-id={note.id} className={`note-list__row${draggingId === note.id ? ' note-list__row--dragging' : ''}${dropTarget?.noteId === note.id && dropTarget.placement === 'before' ? ' note-list__row--drop-before' : ''}${dropTarget?.noteId === note.id && dropTarget.placement === 'after' ? ' note-list__row--drop-after' : ''}`}>
              <button
                type="button"
                className="note-card"
                aria-label={note.title}
                aria-describedby={`entry-type-${note.id}`}
                aria-pressed={effectiveSelectedIds.has(note.id)}
                aria-current={activeId === note.id ? 'true' : undefined}
                onPointerDown={(event) => handlePointerDown(event, note.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (!effectiveSelectedIds.has(note.id)) {
                    selectionAnchorRef.current = note.id
                    setSelectedIds(new Set([note.id]))
                  }
                  contextTriggerRef.current = event.currentTarget
                  setContextTarget(note)
                  setContextPosition({ x: event.clientX, y: event.clientY })
                }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
                    event.preventDefault()
                    toggleSelection(note.id)
                    return
                  }
                  if (event.key === 'Escape' && contextTarget !== null) {
                    event.preventDefault()
                    setContextTarget(null)
                    setContextPosition(null)
                    return
                  }
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                  event.preventDefault()
                  const bounds = event.currentTarget.getBoundingClientRect()
                  if (!effectiveSelectedIds.has(note.id)) {
                    selectionAnchorRef.current = note.id
                    setSelectedIds(new Set([note.id]))
                  }
                  contextTriggerRef.current = event.currentTarget
                  setContextTarget(note)
                  setContextPosition({ x: bounds.left, y: bounds.bottom })
                }}
                onClick={(event) => {
                  if (suppressClickRef.current) return
                  if (event.ctrlKey || event.metaKey) {
                    toggleSelection(note.id)
                  } else if (event.shiftKey) {
                    selectRange(note.id)
                  } else {
                    selectionAnchorRef.current = note.id
                    setSelectedIds(new Set([note.id]))
                    onSelect(note.id)
                  }
                }}
              >
                <strong className="note-card__title"><Icon name={entryIconName(note)} size={14} />{note.title}</strong>
                <span id={`entry-type-${note.id}`} className="note-card__type">{entryTypeText(note)}</span>
                {note.tags.length > 0 && <span className="note-card__tags">{note.tags.map((tag) => `#${tag}`).join(' ')}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {contextTarget !== null && contextPosition !== null && (
        <div className="note-context-menu" role="menu" aria-label="笔记快捷操作" style={{ left: contextPosition.x, top: contextPosition.y }} onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setContextTarget(null)
          setContextPosition(null)
          contextTriggerRef.current?.focus()
        }} onContextMenu={(event) => event.preventDefault()}>
          {onExport && selectionCount === 1 && canExportPdf(contextTarget) && <>
            <button type="button" role="menuitem" autoFocus onClick={() => { onExport(contextSelection[0], 'pdf'); setContextTarget(null); setContextPosition(null) }}>{isPdfFileEntry(contextTarget) ? '另存 PDF' : '导出 PDF'}</button>
            {contextTarget.content?.type === 'document' && <button type="button" role="menuitem" onClick={() => { onExport(contextTarget, 'word'); setContextTarget(null); setContextPosition(null) }}>导出 Word</button>}
          </>}
          {onMoveSelection && folders && selectionCount > 1 && <form aria-label="移动所选条目" onSubmit={(event) => {
            event.preventDefault()
            if (moveFolderId === '') return
            void onMoveSelection(contextSelection.map((entry) => entry.id), moveFolderId)
            setContextTarget(null)
            setContextPosition(null)
          }}>
            <label>
              <span className="sr-only">移动所选条目到</span>
              <select aria-label="移动所选条目到" value={moveFolderId} onChange={(event) => setMoveFolderId(event.target.value as FolderId | '')}>
                <option value="" disabled>选择文件夹</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
            </label>
            <button type="submit" disabled={moveFolderId === ''}>移动</button>
          </form>}
          <button type="button" role="menuitem" autoFocus={onExport === undefined} disabled={(onDelete === undefined && onDeleteSelection === undefined) || deletingId !== null || undoBusy} onClick={() => {
            if (onDeleteSelection !== undefined) onDeleteSelection(contextSelection)
            else if (onDelete !== undefined) onDelete(contextTarget.id, contextTarget.title)
            setContextTarget(null)
            setContextPosition(null)
          }}>{selectionCount > 1 ? `删除 ${selectionCount} 项` : '删除笔记'}</button>
        </div>
      )}
    </section>
  )
}

function entryIconName(note: NoteSummary): IconName {
  const presentation = libraryEntryPresentation(note)
  switch (presentation.format) {
    case 'pdf': return 'file-pdf'
    case 'image': return 'file-image'
    case 'office': {
      const extension = presentation.extension?.toLowerCase()
      return extension === 'xls' || extension === 'xlsx' ? 'file-excel' : extension === 'ppt' || extension === 'pptx' ? 'file-powerpoint' : 'file-word'
    }
    case 'text': return 'file-text'
    case 'markdown': return 'file-text'
    case 'document': return 'file-text'
    default: return 'file'
  }
}

function entryTypeText(note: NoteSummary): string {
  const presentation = libraryEntryPresentation(note)
  return presentation.format !== 'markdown'
    && presentation.extension !== null
    && presentation.extension.toLocaleLowerCase() !== presentation.label.toLocaleLowerCase()
    ? `${presentation.label} · ${presentation.extension}`
    : presentation.label
}
