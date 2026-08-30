import { Icon } from '../../shared/Icon'
import type { Folder, FolderId } from '../../domain/model'

export type LibraryRailEntry = 'unfiled' | 'folder' | 'temporary' | 'trash'

interface LibraryRailProps {
  activeEntry: LibraryRailEntry
  onUnfiled?: () => void
  onTemporary?: () => void
  onTrash?: () => void
  starredFolders?: Folder[]
  activeFolderId?: FolderId | null
  onFolder?: (id: FolderId) => void
  onMoreFolders?: () => void
  onExpand: () => void
}

export function LibraryRail({ activeEntry, activeFolderId = null, starredFolders = [], onTemporary, onTrash, onFolder = () => undefined, onMoreFolders = () => undefined, onExpand }: LibraryRailProps) {
  return (
    <nav className="library-rail" style={{ width: '42px' }} aria-label="折叠的资料库">
      <RailButton label="临时便签" icon="inbox" current={activeEntry === 'temporary'} onClick={onTemporary} />
      <RailButton label="回收站" icon="trash" current={activeEntry === 'trash'} onClick={onTrash} />
      <div className="library-rail__separator" aria-hidden="true" />
      {starredFolders.length > 0 && <div className="library-rail__separator" aria-hidden="true" />}
      {starredFolders.slice(0, 6).map((folder) => (
        <RailButton key={folder.id} label={folder.name} icon="star" current={activeEntry === 'folder' && activeFolderId === folder.id} onClick={() => onFolder(folder.id)} />
      ))}
      {starredFolders.length > 6 && <button className="library-rail__button" type="button" aria-label="更多星标文件夹" title="更多星标文件夹" onClick={onMoreFolders}><Icon name="more" size={18} /></button>}
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
