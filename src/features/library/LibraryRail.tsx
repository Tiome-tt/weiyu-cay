import {text as uiText} from '../../shared/i18n'
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
    <nav className="library-rail" style={{ width: '42px' }} aria-label={uiText("折叠的资料库","Collapsed library")}>
      <RailButton label={uiText("临时便笺","Sticky notes")} icon="inbox" current={activeEntry === 'temporary'} onClick={onTemporary} />
      <RailButton label={uiText("回收站","Trash")} icon="trash" current={activeEntry === 'trash'} onClick={onTrash} />
      <div className="library-rail__separator" aria-hidden="true" />

      {starredNotes.slice(0, 6).map((note) => (
        <RailButton key={note.id} label={note.title} icon="star" current={activeEntry === 'folder' && activeNoteId === note.id} onClick={() => onNote(note.id)} />
      ))}
      {starredNotes.length > 6 && <button className="library-rail__button" type="button" aria-label={uiText("更多星标笔记","More starred notes")} title={uiText("更多星标笔记","More starred notes")} onClick={onMoreNotes}><Icon name="more" size={18} /></button>}
      <button className="library-rail__button library-rail__expand" type="button" aria-label={uiText("展开资料库","Expand library")} title={uiText("展开资料库","Expand library")} onClick={onExpand}>
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
