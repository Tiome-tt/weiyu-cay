import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import type { Folder, FolderId } from '../../domain/model'

interface FolderTreeProps {
  folders: Folder[]
  activeId: FolderId | null
  temporaryInboxActive?: boolean
  trashActive?: boolean
  state: 'loading' | 'ready' | 'error'
  onSelect: (id: FolderId | null) => void
  onTemporaryInbox?: () => void
  onTrash?: () => void
  onCreate: (parentId: FolderId | null, name: string) => Promise<void>
  onRename: (id: FolderId, name: string) => Promise<void>
  onMove: (id: FolderId, parentId: FolderId | null) => Promise<void>
  onDelete: (id: FolderId) => Promise<void>
}

export function FolderTree(props: FolderTreeProps) {
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<FolderId | null>(null)
  const [moving, setMoving] = useState<FolderId | null>(null)
  const [moveTarget, setMoveTarget] = useState<FolderId | null>(null)
  const [focusedKey, setFocusedKey] = useState<TreeItemKey>('root')
  const [name, setName] = useState('')
  const [error, setError] = useState(false)
  const itemRefs = useRef(new Map<TreeItemKey, HTMLButtonElement>())

  const finishCreate = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await props.onCreate(props.activeId, name)
      setCreating(false)
      setName('')
      setError(false)
    } catch {
      setError(true)
    }
  }

  const finishRename = async (event: FormEvent) => {
    event.preventDefault()
    if (renaming === null) return
    try {
      await props.onRename(renaming, name)
      setRenaming(null)
      setName('')
      setError(false)
    } catch {
      setError(true)
    }
  }

  const runDelete = async () => {
    if (props.activeId === null) return
    try {
      await props.onDelete(props.activeId)
      setError(false)
    } catch {
      setError(true)
    }
  }

  const finishMove = async (event: FormEvent) => {
    event.preventDefault()
    if (moving === null) return
    try {
      await props.onMove(moving, moveTarget)
      setMoving(null)
      setMoveTarget(null)
      setError(false)
    } catch {
      setError(true)
    }
  }

  const dropFolder = async (event: DragEvent, parentId: FolderId | null) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain') as FolderId
    if (!id) return
    try {
      await props.onMove(id, parentId)
      setError(false)
    } catch {
      setError(true)
    }
  }

  const selected = props.folders.find((folder) => folder.id === props.activeId)
  const visibleKeys = useMemo<TreeItemKey[]>(
    () => [
      'root',
      ...(props.onTemporaryInbox ? ['temporary-inbox' as const] : []),
      ...(props.onTrash ? ['trash' as const] : []),
      ...flattenFolders(props.folders),
    ],
    [props.folders, props.onTemporaryInbox, props.onTrash],
  )

  useEffect(() => {
    if (!visibleKeys.includes(focusedKey)) {
      setFocusedKey(props.activeId !== null && visibleKeys.includes(props.activeId) ? props.activeId : 'root')
    }
  }, [focusedKey, props.activeId, visibleKeys])

  const focusItem = (key: TreeItemKey) => {
    setFocusedKey(key)
    queueMicrotask(() => itemRefs.current.get(key)?.focus())
  }

  const handleTreeKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    key: TreeItemKey,
  ) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'm' && key !== 'root' && key !== 'temporary-inbox' && key !== 'trash') {
      event.preventDefault()
      setMoving(key)
      setMoveTarget(null)
      return
    }
    const index = visibleKeys.indexOf(key)
    let target: TreeItemKey | undefined
    switch (event.key) {
      case 'ArrowDown':
        target = visibleKeys[Math.min(index + 1, visibleKeys.length - 1)]
        break
      case 'ArrowUp':
        target = visibleKeys[Math.max(index - 1, 0)]
        break
      case 'Home':
        target = visibleKeys[0]
        break
      case 'End':
        target = visibleKeys[visibleKeys.length - 1]
        break
      case 'ArrowRight':
        target = key === 'root' || key === 'temporary-inbox' || key === 'trash'
          ? props.folders.find((folder) => folder.parentId === null)?.id
          : props.folders.find((folder) => folder.parentId === key)?.id
        break
      case 'ArrowLeft':
        if (key === 'temporary-inbox' || key === 'trash') {
          target = 'root'
        } else if (key !== 'root') {
          target = props.folders.find((folder) => folder.id === key)?.parentId ?? 'root'
        }
        break
      default:
        return
    }
    if (target === undefined) return
    event.preventDefault()
    focusItem(target)
  }

  const registerItem = (key: TreeItemKey, node: HTMLButtonElement | null) => {
    if (node) itemRefs.current.set(key, node)
    else itemRefs.current.delete(key)
  }

  const renderBranch = (parentId: FolderId | null): React.ReactNode =>
    props.folders
      .filter((folder) => folder.parentId === parentId)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
      .map((folder) => {
        const hasChildren = props.folders.some((candidate) => candidate.parentId === folder.id)
        return (
          <li role="none" key={folder.id}>
            {renaming === folder.id ? (
              <form className="folder-form" onSubmit={(event) => void finishRename(event)}>
                <input
                  autoFocus
                  aria-label="重命名文件夹"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </form>
            ) : (
              <button
                ref={(node) => registerItem(folder.id, node)}
                role="treeitem"
                aria-selected={props.activeId === folder.id}
                aria-expanded={hasChildren ? true : undefined}
                aria-keyshortcuts="Control+M"
                tabIndex={focusedKey === folder.id ? 0 : -1}
                draggable
                className="folder-tree__item"
                type="button"
                onFocus={() => setFocusedKey(folder.id)}
                onKeyDown={(event) => handleTreeKey(event, folder.id)}
                onClick={() => props.onSelect(folder.id)}
                onDragStart={(event) => event.dataTransfer.setData('text/plain', folder.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => void dropFolder(event, folder.id)}
              >
                <span aria-hidden="true">▱</span> {folder.name}
              </button>
            )}
            {hasChildren && <ul role="group">{renderBranch(folder.id)}</ul>}
          </li>
        )
      })

  const excludedMoveTargets = moving === null ? new Set<FolderId>() : descendantIds(moving, props.folders)

  return (
    <nav aria-label="文件夹" className="folder-tree">
      <header className="library-pane__header">
        <div>
          <span className="library-pane__eyebrow">资料库</span>
          <h1>Simple Notes</h1>
        </div>
        <button className="icon-button" type="button" aria-label="新建文件夹" onClick={() => setCreating(true)}>
          +
        </button>
      </header>
      <div className="folder-actions" aria-label="文件夹操作">
        <button
          type="button"
          aria-label="重命名文件夹"
          disabled={!selected}
          onClick={() => {
            if (!selected) return
            setRenaming(selected.id)
            setName(selected.name)
          }}
        >
          重命名
        </button>
        <button
          type="button"
          aria-label="移动文件夹"
          disabled={!selected}
          onClick={() => {
            if (!selected) return
            setMoving(selected.id)
            setMoveTarget(selected.parentId)
          }}
        >
          移动
        </button>
        <button type="button" aria-label="删除空文件夹" disabled={!selected} onClick={() => void runDelete()}>
          删除
        </button>
      </div>
      {creating && (
        <form className="folder-form" onSubmit={(event) => void finishCreate(event)}>
          <input autoFocus aria-label="文件夹名称" value={name} onChange={(event) => setName(event.target.value)} />
        </form>
      )}
      {moving && (
        <form className="folder-move" onSubmit={(event) => void finishMove(event)}>
          <select
            autoFocus
            aria-label="移动到"
            value={moveTarget ?? ''}
            onChange={(event) => setMoveTarget((event.target.value || null) as FolderId | null)}
          >
            <option value="">顶层</option>
            {props.folders
              .filter((folder) => !excludedMoveTargets.has(folder.id))
              .map((folder) => (
                <option value={folder.id} key={folder.id}>
                  {folder.name}
                </option>
              ))}
          </select>
          <button type="submit">确认移动</button>
          <button type="button" onClick={() => setMoving(null)}>取消</button>
        </form>
      )}
      {props.state === 'loading' && <p className="library-status">正在加载文件夹…</p>}
      {props.state === 'error' && <p className="library-status library-status--error">无法加载文件夹。</p>}
      <ul role="tree" aria-label="笔记文件夹" className="folder-tree__list">
        <li role="none">
          <button
            ref={(node) => registerItem('root', node)}
            role="treeitem"
            aria-selected={props.activeId === null && !props.temporaryInboxActive && !props.trashActive}
            tabIndex={focusedKey === 'root' ? 0 : -1}
            className="folder-tree__item"
            type="button"
            onFocus={() => setFocusedKey('root')}
            onKeyDown={(event) => handleTreeKey(event, 'root')}
            onClick={() => props.onSelect(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => void dropFolder(event, null)}
          >
            <span aria-hidden="true">⌂</span> 所有笔记
          </button>
        </li>
        {props.onTemporaryInbox && (
          <li role="none">
            <button
              ref={(node) => registerItem('temporary-inbox', node)}
              role="treeitem"
              aria-selected={props.temporaryInboxActive === true}
              tabIndex={focusedKey === 'temporary-inbox' ? 0 : -1}
              className="folder-tree__item"
              type="button"
              onFocus={() => setFocusedKey('temporary-inbox')}
              onKeyDown={(event) => handleTreeKey(event, 'temporary-inbox')}
              onClick={props.onTemporaryInbox}
            >
              <span aria-hidden="true">✦</span> 临时收集箱
            </button>
          </li>
        )}
        {props.onTrash && (
          <li role="none">
            <button
              ref={(node) => registerItem('trash', node)}
              role="treeitem"
              aria-selected={props.trashActive === true}
              tabIndex={focusedKey === 'trash' ? 0 : -1}
              className="folder-tree__item"
              type="button"
              onFocus={() => setFocusedKey('trash')}
              onKeyDown={(event) => handleTreeKey(event, 'trash')}
              onClick={props.onTrash}
            >
              <span aria-hidden="true">♲</span> 回收站
            </button>
          </li>
        )}
        {renderBranch(null)}
      </ul>
      {error && <p role="alert" className="library-status library-status--error">文件夹操作未完成。</p>}
    </nav>
  )
}

type TreeItemKey = 'root' | 'temporary-inbox' | 'trash' | FolderId

function flattenFolders(folders: Folder[], parentId: FolderId | null = null): FolderId[] {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    .flatMap((folder) => [folder.id, ...flattenFolders(folders, folder.id)])
}

function descendantIds(id: FolderId, folders: Folder[]): Set<FolderId> {
  const result = new Set<FolderId>([id])
  const visit = (parentId: FolderId) => {
    for (const folder of folders.filter((candidate) => candidate.parentId === parentId)) {
      result.add(folder.id)
      visit(folder.id)
    }
  }
  visit(id)
  return result
}
