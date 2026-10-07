import { Icon } from '../../shared/Icon'
import type { NoteSummary, NoteId } from '../../domain/model'

export type LibraryRailEntry = 'unfiled' | 'folder' | 'temporary' | 'trash'

interface LibraryRailProps {
  activeEntry: LibraryRailEntry
  onUnfiled?: () => void
  onTemporary?: () => void
  onTrash?: () => void
  starredNotes?: NoteSummary[]
  activeNoteId?: NoteId | null
  onNote?: (id: NoteId) => void
  onMoreNotes?: () => void
  onExpand: () => void
}

export function LibraryRail({ activeEntry, activeNoteId = null, starredNotes = [], onTemporary, onTrash, onNote = () => undefined, onMoreNotes = () => undefined, onExpand }: LibraryRailProps) {
  return (
    <nav className="library-rail" style={{ width: '42px' }} aria-label="折叠的资料库">
      <RailButton label="临时便笺" icon="inbox" current={activeEntry === 'temporary'} onClick={onTemporary} />
      <RailButton label="回收站" icon="trash" current={activeEntry === 'trash'} onClick={onTrash} />
      <div className="library-rail__separator" aria-hidden="true" />

      {starredNotes.slice(0, 6).map((note) => (
        <RailButton key={note.id} label={note.title} icon="star" current={activeEntry === 'folder' && activeNoteId === note.id} onClick={() => onNote(note.id)} />
      ))}
      {starredNotes.length > 6 && <button className="library-rail__button" type="button" aria-label="更多星标笔记" title="更多星标笔记" onClick={onMoreNotes}><Icon name="more" size={18} /></button>}
      <button className="library-rail__button library-rail__expand" type="button" aria-label="展开资料库" title="展开资料库" onClick={onExpand}>
        <Icon name="expand" size={18} />
      </button>
    </nav>
  )
}

interface RailButtonProps {
  label: string
  icon: 'folder' | 'inbox' | 'trash' | 'star'
  current: boolean
  onClick?: () => void
}

function RailButton({ label, icon, current, onClick }: RailButtonProps) {
  return (
    <button
      className="library-rail__button"
      type="button"
      aria-label={label}
      title={label}
      aria-current={current ? 'page' : undefined}
      disabled={onClick === undefined}
      onClick={onClick}
    >
      <Icon name={icon} size={18} />
    </button>
  )
}
