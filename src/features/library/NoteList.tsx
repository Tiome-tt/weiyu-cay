import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { FolderId, NoteId, NoteSummary } from '../../domain/model'
import { Icon } from '../../shared/Icon'

interface NoteListProps {
  notes: NoteSummary[]
  activeId: NoteId | null
  state: 'loading' | 'ready' | 'error'
  onSelect: (id: NoteId) => void
  onDelete?: (id: NoteId, title: string) => void
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
  showEmptyState?: boolean
}
export function NoteList({ notes, activeId, state, onSelect, onDelete, deletingId = null, deleteError = null, deleteFeedback = null, undoAvailable = false, undoBusy = false, onUndoDelete, onDismissFeedback, folderId = null, onReorder, onMoveToFolder, showEmptyState = true }: NoteListProps) {
  const feedbackRef = useRef<HTMLParagraphElement>(null)
  const contextTriggerRef = useRef<HTMLButtonElement | null>(null)
  const pointerStartRef = useRef<{ id: NoteId; x: number; y: number } | null>(null)
  const pointerDragRef = useRef<NoteId | null>(null)
  const pointerTargetRef = useRef<{ noteId?: NoteId; folderId?: FolderId } | null>(null)
  const suppressClickRef = useRef(false)
  const [draggingId, setDraggingId] = useState<NoteId | null>(null)
  const [contextTarget, setContextTarget] = useState<NoteSummary | null>(null)
  const [contextPosition, setContextPosition] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (deleteFeedback !== null) feedbackRef.current?.focus()
  }, [deleteFeedback])

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
    event.preventDefault()
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
        pointerTargetRef.current = folderTarget?.dataset.folderId !== undefined
          ? { folderId: folderTarget.dataset.folderId as FolderId }
          : noteTarget?.dataset.noteId !== undefined
            ? { noteId: noteTarget.dataset.noteId as NoteId }
            : null
      }
    }
    const onUp = () => {
      const dragged = pointerDragRef.current
      const target = pointerTargetRef.current
      pointerStartRef.current = null
      pointerDragRef.current = null
      pointerTargetRef.current = null
      setDraggingId(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (dragged !== null && target !== null) {
        if (target.folderId !== undefined && onMoveToFolder !== undefined) void onMoveToFolder(dragged, target.folderId)
        else if (target.noteId !== undefined && target.noteId !== dragged && onReorder !== undefined) {
          const ids = notes.map((note) => note.id).filter((noteId) => noteId !== dragged)
          const targetIndex = ids.indexOf(target.noteId)
          ids.splice(targetIndex < 0 ? ids.length : targetIndex, 0, dragged)
          void onReorder(folderId, ids)
        }
      }
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp, { once: true })
  }

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
      {state === 'loading' && <p className="library-status">正在加载笔记…</p>}
      {state === 'error' && <p className="library-status library-status--error">无法加载笔记。</p>}
      {showEmptyState && state === 'ready' && notes.length === 0 && <p className="library-status">此文件夹中还没有笔记。</p>}
      {state === 'ready' && notes.length > 0 && (
        <ul className="note-list__items">
          {notes.map((note) => (
            <li key={note.id} data-note-id={note.id} className={`note-list__row${draggingId === note.id ? ' note-list__row--dragging' : ''}`} draggable={false} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
              event.preventDefault()
              const sourceId = event.dataTransfer.getData('text/plain') as NoteId
              if (!sourceId || sourceId === note.id || onReorder === undefined) return
              const ids = notes.map((candidate) => candidate.id).filter((id) => id !== sourceId)
              const targetIndex = ids.indexOf(note.id)
              ids.splice(targetIndex < 0 ? ids.length : targetIndex, 0, sourceId)
              void onReorder(folderId, ids)
            }} onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', note.id)
              event.dataTransfer.setData('application/x-cay-note', note.id)
            }}>
              <button
                type="button"
                className="note-card"
                aria-current={activeId === note.id ? 'true' : undefined}
                onPointerDown={(event) => handlePointerDown(event, note.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  contextTriggerRef.current = event.currentTarget
                  setContextTarget(note)
                  setContextPosition({ x: event.clientX, y: event.clientY })
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && contextTarget !== null) {
                    event.preventDefault()
                    setContextTarget(null)
                    setContextPosition(null)
                    return
                  }
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                  event.preventDefault()
                  const bounds = event.currentTarget.getBoundingClientRect()
                  contextTriggerRef.current = event.currentTarget
                  setContextTarget(note)
                  setContextPosition({ x: bounds.left, y: bounds.bottom })
                }}
                onClick={() => { if (!suppressClickRef.current) onSelect(note.id) }}
              >
                <strong className="note-card__title"><Icon name="note" size={14} />{note.title}</strong>
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
          <button type="button" role="menuitem" autoFocus disabled={onDelete === undefined || deletingId !== null || undoBusy} onClick={() => {
            if (onDelete !== undefined) onDelete(contextTarget.id, contextTarget.title)
            setContextTarget(null)
            setContextPosition(null)
          }}>删除笔记</button>
        </div>
      )}
    </section>
  )
}
