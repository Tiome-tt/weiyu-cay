import { useMemo, type ReactNode } from 'react'
import type { Folder, FolderId, NoteId, NoteSummary } from '../../domain/model'
import { Icon } from '../../shared/Icon'

interface InternalLinkTreeProps {
  folders: Folder[]
  targets: NoteSummary[]
  selectedId: NoteId | ''
  onSelect: (id: NoteId) => void
}

/**
 * Presents link targets using the same folder hierarchy as the library rail.
 * Folder rows are structural only; a note row is the only selectable target.
 */
export function InternalLinkTree({ folders, targets, selectedId, onSelect }: InternalLinkTreeProps) {
  const targetsByFolder = useMemo(() => {
    const grouped = new Map<FolderId | null, NoteSummary[]>()
    const knownFolderIds = new Set(folders.map((folder) => folder.id))
    for (const target of targets) {
      // Keep every target reachable even while the folder list is loading or
      // when an older note points at a folder that has since been removed.
      const folderId = target.folderId !== null && knownFolderIds.has(target.folderId)
        ? target.folderId
        : null
      const current = grouped.get(folderId) ?? []
      current.push(target)
      grouped.set(folderId, current)
    }
    for (const notes of grouped.values()) notes.sort(compareNotes)
    return grouped
  }, [targets])

  const childrenByParent = useMemo(() => {
    const grouped = new Map<FolderId | null, Folder[]>()
    for (const folder of folders) {
      const current = grouped.get(folder.parentId) ?? []
      current.push(folder)
      grouped.set(folder.parentId, current)
    }
    for (const children of grouped.values()) {
      children.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    }
    return grouped
  }, [folders])

  const rendered = renderLevel(null, 1, childrenByParent, targetsByFolder, new Set(), selectedId, onSelect)
  return (
    <div className="internal-link-tree" role="tree" aria-label="内部链接目标">
      {rendered}
    </div>
  )
}

function renderLevel(
  parentId: FolderId | null,
  level: number,
  childrenByParent: ReadonlyMap<FolderId | null, Folder[]>,
  targetsByFolder: ReadonlyMap<FolderId | null, NoteSummary[]>,
  visited: Set<FolderId>,
  selectedId: NoteId | '',
  onSelect: (id: NoteId) => void,
): ReactNode[] {
  const rows: ReactNode[] = []
  for (const folder of childrenByParent.get(parentId) ?? []) {
    if (visited.has(folder.id)) continue
    const nextVisited = new Set(visited)
    nextVisited.add(folder.id)
    rows.push(
      <div
        key={`folder-${folder.id}`}
        className="internal-link-tree__folder"
        role="treeitem"
        aria-level={level}
        aria-expanded="true"
        style={{ paddingLeft: `${6 + (level - 1) * 14}px` }}
      >
        <Icon name="folder" size={14} />
        <span>{folder.name}</span>
      </div>,
    )
    rows.push(...renderLevel(folder.id, level + 1, childrenByParent, targetsByFolder, nextVisited, selectedId, onSelect))
  }
  for (const note of targetsByFolder.get(parentId) ?? []) {
    rows.push(
      <button
        key={`note-${note.id}`}
        type="button"
        role="treeitem"
        aria-level={level}
        aria-selected={selectedId === note.id}
        aria-label={`选择链接：${note.title}`}
        className={`internal-link-tree__note${selectedId === note.id ? ' is-selected' : ''}`}
        style={{ paddingLeft: `${6 + (level - 1) * 14}px` }}
        onClick={() => onSelect(note.id)}
      >
        <Icon name="note" size={14} />
        <span>{note.title}</span>
      </button>,
    )
  }
  return rows
}

function compareNotes(left: NoteSummary, right: NoteSummary) {
  return left.title.localeCompare(right.title, 'zh-Hans') || left.id.localeCompare(right.id)
}
