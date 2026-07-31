import type { NoteId, NoteSummary } from '../../domain/model'

interface NoteListProps {
  notes: NoteSummary[]
  activeId: NoteId | null
  state: 'loading' | 'ready' | 'error'
  onSelect: (id: NoteId) => void
}

export function NoteList({ notes, activeId, state, onSelect }: NoteListProps) {
  return (
    <section aria-label="笔记列表" className="note-list">
      <header className="library-pane__header library-pane__header--compact">
        <div>
          <span className="library-pane__eyebrow">当前文件夹</span>
          <h2>笔记</h2>
        </div>
      </header>
      {state === 'loading' && <p className="library-status">正在加载笔记…</p>}
      {state === 'error' && <p className="library-status library-status--error">无法加载笔记。</p>}
      {state === 'ready' && notes.length === 0 && <p className="library-status">此文件夹中还没有笔记。</p>}
      {state === 'ready' && notes.length > 0 && (
        <ul className="note-list__items">
          {notes.map((note) => (
            <li key={note.id}>
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
