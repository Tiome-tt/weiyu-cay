import { Icon } from '../../shared/Icon'

export type LibraryRailEntry = 'unfiled' | 'folders' | 'temporary' | 'trash'

interface LibraryRailProps {
  activeEntry: LibraryRailEntry
  onUnfiled: () => void
  onFolders: () => void
  onTemporary?: () => void
  onTrash?: () => void
  onExpand: () => void
}

export function LibraryRail({ activeEntry, onUnfiled, onFolders, onTemporary, onTrash, onExpand }: LibraryRailProps) {
  return (
    <nav className="library-rail" style={{ width: '42px' }} aria-label="折叠的资料库">
      <RailButton label="未归档笔记" icon="inbox" current={activeEntry === 'unfiled'} onClick={onUnfiled} />
      <RailButton label="临时收集箱" icon="inbox" current={activeEntry === 'temporary'} onClick={onTemporary} />
      <RailButton label="文件夹" icon="folder" current={activeEntry === 'folders'} onClick={onFolders} />
      <RailButton label="回收站" icon="trash" current={activeEntry === 'trash'} onClick={onTrash} />
      <button className="library-rail__button library-rail__expand" type="button" aria-label="展开资料库" onClick={onExpand}>
        <Icon name="expand" size={18} />
      </button>
    </nav>
  )
}

interface RailButtonProps {
  label: string
  icon: 'folder' | 'inbox' | 'trash'
  current: boolean
  onClick?: () => void
}

function RailButton({ label, icon, current, onClick }: RailButtonProps) {
  return (
    <button
      className="library-rail__button"
      type="button"
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      disabled={onClick === undefined}
      onClick={onClick}
    >
      <Icon name={icon} size={18} />
    </button>
  )
}
