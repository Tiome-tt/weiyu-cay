import type { NoteId, NoteSummary } from '../../domain/model'

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
}

export function NoteList({ notes, activeId, state, onSelect, onDelete, deletingId = null, deleteError = null, deleteFeedback = null, undoAvailable = false, undoBusy = false, onUndoDelete }: NoteListProps) {
  return (
    <section aria-label="笔记列表" className="note-list">
      <header className="library-pane__header library-pane__header--compact">
        <div>
          <span className="library-pane__eyebrow">当前文件夹</span>
          <h2>笔记</h2>
        </div>
      </header>
      {deleteFeedback && (
        <div className="note-list__mutation-status">
          <p role="status">{deleteFeedback}</p>
          {undoAvailable && onUndoDelete && <button type="button" disabled={undoBusy || deletingId !== null} onClick={onUndoDelete}>{undoBusy ? '正在撤销…' : '撤销删除'}</button>}
        </div>
      )}
      {deleteError && <p role="alert" className="library-status library-status--error">{deleteError}</p>}
      {state === 'loading' && <p className="library-status">正在加载笔记…</p>}
      {state === 'error' && <p className="library-status library-status--error">无法加载笔记。</p>}
      {state === 'ready' && notes.length === 0 && <p className="library-status">此文件夹中还没有笔记。</p>}
      {state === 'ready' && notes.length > 0 && (
        <ul className="note-list__items">
          {notes.map((note) => (
            <li key={note.id} className="note-list__row">
              <button
                type="button"
                className="note-card"
                aria-current={activeId === note.id ? 'true' : undefined}
                onClick={() => onSelect(note.id)}
              >
                <strong>{note.title}</strong>
                {note.excerpt && <span>{concise(note.excerpt)}</span>}
                {note.updatedAt && <time dateTime={note.updatedAt}>{formatDate(note.updatedAt)}</time>}
              </button>
              {onDelete && (
                <button
                  type="button"
                  className="note-list__delete"
                  aria-label={`删除 ${note.title}`}
                  disabled={deletingId !== null || undoBusy}
                  onClick={() => onDelete(note.id, note.title)}
                >
                  {deletingId === note.id ? '…' : '×'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function concise(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 96)
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date)
}
