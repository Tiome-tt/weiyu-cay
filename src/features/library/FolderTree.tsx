import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Folder, FolderId, NoteId } from '../../domain/model'
import { Icon } from '../../shared/Icon'
import { FolderActionMenu } from './FolderActionMenu'

interface FolderTreeProps {
  folders: Folder[]
  activeId: FolderId | null
  temporaryInboxActive?: boolean
  trashActive?: boolean
  showUnfiled?: boolean
  state: 'loading' | 'ready' | 'error'
  onSelect: (id: FolderId | null) => void
  onTemporaryInbox?: () => void
  onTrash?: () => void
  onCollapse?: () => void
  onCreate: (parentId: FolderId | null, name: string) => Promise<void>
  onRename: (id: FolderId, name: string) => Promise<void>
  onMove: (id: FolderId, parentId: FolderId | null) => Promise<void>
  onReorder?: (parentId: FolderId | null, orderedIds: FolderId[]) => Promise<void>
  onDelete: (id: FolderId) => Promise<void>
  onCreateNote?: (folderId: FolderId | null) => void
  onToggleStar?: (id: FolderId, starred: boolean) => Promise<void>
  folderContents?: ReactNode | ((folderId: FolderId | null) => ReactNode | undefined)
  onMoveNote?: (id: NoteId, folderId: FolderId) => Promise<void>
}

export function FolderTree(props: FolderTreeProps) {
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<FolderId | null>(null)
  const [moving, setMoving] = useState<FolderId | null>(null)
  const [moveTarget, setMoveTarget] = useState<FolderId | null>(null)
  const [focusedKey, setFocusedKey] = useState<TreeItemKey>('root')
  const [name, setName] = useState('')
  const [createParent, setCreateParent] = useState<FolderId | null>(null)
  const [error, setError] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<FolderId | null>(null)
  const [contextTarget, setContextTarget] = useState<FolderId | null>(null)
  const [contextPosition, setContextPosition] = useState<{ x: number; y: number } | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<FolderId>>(() => defaultCollapsedFolders(props.folders, props.folderContents, props.activeId))
  const [mountedFolders, setMountedFolders] = useState<Set<FolderId>>(() => mountedFolderIds(props.folders, props.folderContents, props.activeId))
  const userToggledFoldersRef = useRef(new Set<FolderId>())
  const previousActiveIdRef = useRef<FolderId | null | undefined>(undefined)
  const itemRefs = useRef(new Map<TreeItemKey, HTMLButtonElement>())
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const pointerStartRef = useRef<{ id: FolderId; x: number; y: number } | null>(null)
  const pointerDragRef = useRef<FolderId | null>(null)
  const suppressClickRef = useRef(false)
  const pointerTargetRef = useRef<{ folderId?: FolderId; parentId?: string } | null>(null)
  const [pointerDragging, setPointerDragging] = useState<FolderId | null>(null)

  // Folder and note data are loaded asynchronously. Seed newly expandable folders as
  // collapsed while leaving a user's explicit expand/collapse choice untouched.
  useEffect(() => {
    const expandable = defaultCollapsedFolders(props.folders, props.folderContents, props.activeId)
    const shouldCollapse = [...expandable].filter((id) => !userToggledFoldersRef.current.has(id) && !collapsedFolders.has(id))
    if (shouldCollapse.length === 0) return
    setCollapsedFolders((current) => {
      const next = new Set(current)
      for (const id of shouldCollapse) next.add(id)
      return next
    })
  }, [collapsedFolders, props.activeId, props.folderContents, props.folders])

  useEffect(() => {
    const expandable = defaultCollapsedFolders(props.folders, props.folderContents, props.activeId)
    const initiallyVisible = props.folders.filter((folder) => !expandable.has(folder.id)).map((folder) => folder.id)
    if (initiallyVisible.length === 0) return
    setMountedFolders((current) => {
      const next = new Set(current)
      initiallyVisible.forEach((id) => next.add(id))
      return next.size === current.size ? current : next
    })
  }, [collapsedFolders, props.activeId, props.folderContents, props.folders])

  useEffect(() => {
    if (props.activeId === null) {
      previousActiveIdRef.current = null
      return
    }
    if (previousActiveIdRef.current === props.activeId) return
    const folder = props.folders.find((candidate) => candidate.id === props.activeId)
    if (folder === undefined) return
    previousActiveIdRef.current = props.activeId
    // A click already records the user's explicit expansion choice before the
    // parent updates activeId. Do not undo a collapse while that selection
    // change is being reflected in refreshed folder data.
    if (userToggledFoldersRef.current.has(folder.id)) return
    userToggledFoldersRef.current.add(folder.id)
    setMountedFolders((current) => new Set(current).add(folder.id))
    setCollapsedFolders((current) => {
      if (!current.has(folder.id)) return current
      const next = new Set(current)
      next.delete(folder.id)
      return next
    })
  }, [props.activeId, props.folders])

  const finishCreate = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await props.onCreate(createParent, name)
      setCreating(false)
      setName('')
      setCreateParent(null)
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
    if (deleteTarget === null) return
    try {
      await props.onDelete(deleteTarget)
      setError(false)
      setDeleteTarget(null)
      setContextTarget(null)
      setContextPosition(null)
      focusItem('root')
    } catch {
      setError(true)
    }
  }

  const runToggleStar = async (id: FolderId) => {
    if (props.onToggleStar === undefined) return
    const folder = props.folders.find((candidate) => candidate.id === id)
    if (folder === undefined) return
    try {
      await props.onToggleStar(id, folder.starred !== true)
      setError(false)
      setContextTarget(null)
      setContextPosition(null)
    } catch {
      setError(true)
    }
  }

  useEffect(() => {
    if (!creating && contextPosition === null) return
    const cancelDraft = (event: PointerEvent) => {
      const target = event.target as Node
      if (creating && !document.querySelector('.folder-form')?.contains(target)) {
        setCreating(false)
        setName('')
        setCreateParent(null)
      }
      if (contextPosition !== null && !document.querySelector('.folder-context-menu')?.contains(target)) {
        setContextTarget(null)
        setContextPosition(null)
      }
    }
    document.addEventListener('pointerdown', cancelDraft)
    return () => document.removeEventListener('pointerdown', cancelDraft)
  }, [creating, contextPosition])

  useEffect(() => {
    if (deleteTarget === null) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setDeleteTarget(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [deleteTarget])

  useLayoutEffect(() => {
    if (contextPosition === null || contextMenuRef.current === null) return
    const menu = contextMenuRef.current.getBoundingClientRect()
    const margin = 8
    const x = Math.max(margin, Math.min(contextPosition.x, window.innerWidth - menu.width - margin))
    const y = Math.max(margin, Math.min(contextPosition.y, window.innerHeight - menu.height - margin))
    if (x !== contextPosition.x || y !== contextPosition.y) setContextPosition({ x, y })
  }, [contextTarget, contextPosition])

  const revealFolder = (id: FolderId) => {
    setCollapsedFolders((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
    setMountedFolders((current) => new Set(current).add(id))
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

  const dropFolder = async (event: DragEvent, targetId: FolderId | null) => {
    event.preventDefault()
    event.stopPropagation()
    const isNoteDrag = Array.from(event.dataTransfer.types ?? []).includes('application/x-cay-note')
    const noteId = isNoteDrag ? event.dataTransfer.getData('application/x-cay-note') as NoteId : ''
    if (isNoteDrag && noteId) {
      if (targetId !== null && props.onMoveNote !== undefined) await props.onMoveNote(noteId, targetId)
      return
    }
    const id = event.dataTransfer.getData('text/plain') as FolderId
    if (!id) return
    try {
      const source = props.folders.find((folder) => folder.id === id)
      const target = targetId === null ? null : props.folders.find((folder) => folder.id === targetId)
      if (source && target && source.parentId === target.parentId && props.onReorder) {
        const targetBox = (event.currentTarget as HTMLElement).getBoundingClientRect()
        // jsdom and a few embedded webviews can report a zero-sized target.
        // Treat that as an above-target drop so reordering still has a stable
        // result instead of being mistaken for a move-into-folder action.
        const relativeY = targetBox.height === 0 ? 0 : (event.clientY - targetBox.top) / targetBox.height
        if (relativeY > 0.25 && relativeY < 0.75) {
          await props.onMove(id, target.id)
          revealFolder(target.id)
          setError(false)
          return
        }
        const siblings = props.folders
          .filter((folder) => folder.parentId === source.parentId)
          .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
          .map((folder) => folder.id)
        const withoutSource = siblings.filter((folderId) => folderId !== id)
        const targetIndex = withoutSource.indexOf(target.id)
        const insertAfter = event.clientY >= targetBox.top + targetBox.height / 2
        withoutSource.splice(targetIndex < 0 ? withoutSource.length : targetIndex + (insertAfter ? 1 : 0), 0, id)
        await props.onReorder(source.parentId, withoutSource)
      } else {
        await props.onMove(id, targetId)
        if (targetId !== null) revealFolder(targetId)
      }
      setError(false)
    } catch {
      setError(true)
    }
  }

  const finishPointerDrop = useCallback(async (id: FolderId, x: number, y: number, targetHint?: { folderId?: FolderId; parentId?: string }) => {
    const element = document.elementFromPoint(x, y)
    const folderTarget = element?.closest<HTMLElement>('[data-folder-id]')
    const listTarget = element?.closest<HTMLElement>('[data-folder-parent-id]')
    const targetId = targetHint?.folderId ?? folderTarget?.dataset.folderId as FolderId | undefined
    const source = props.folders.find((folder) => folder.id === id)
    const target = targetId === undefined ? undefined : props.folders.find((folder) => folder.id === targetId)
    if (!source || targetId === id) return
    try {
      if (target && target.parentId === source.parentId && props.onReorder) {
        const targetBox = folderTarget?.getBoundingClientRect()
        const relativeY = targetBox === undefined || targetBox.height === 0 ? 0 : (y - targetBox.top) / targetBox.height
        if (relativeY > 0.25 && relativeY < 0.75) {
          await props.onMove(id, target.id)
          revealFolder(target.id)
          setError(false)
          return
        }
        const siblings = props.folders.filter((folder) => folder.parentId === source.parentId).sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)).map((folder) => folder.id)
        const ordered = siblings.filter((folderId) => folderId !== id)
        const targetIndex = ordered.indexOf(target.id)
        const insertAfter = targetBox !== undefined && y >= targetBox.top + targetBox.height / 2
        ordered.splice(targetIndex < 0 ? ordered.length : targetIndex + (insertAfter ? 1 : 0), 0, id)
        await props.onReorder(source.parentId, ordered)
      } else if (target) {
        await props.onMove(id, target.id)
      } else if (listTarget || targetHint?.parentId) {
        const parentValue = targetHint?.parentId ?? listTarget?.dataset.folderParentId
        await props.onMove(id, parentValue === 'root' ? null : parentValue as FolderId)
      }
      setError(false)
    } catch {
      setError(true)
    }
  }, [props])

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: FolderId) => {
    if (event.button !== 0) return
    pointerStartRef.current = { id, x: event.clientX, y: event.clientY }
    pointerDragRef.current = null
    pointerTargetRef.current = null
    event.preventDefault()
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const start = pointerStartRef.current
      if (!start) return
      if (pointerDragRef.current === null && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) >= 5) {
        pointerDragRef.current = start.id
        setPointerDragging(start.id)
        suppressClickRef.current = true
      }
      if (pointerDragRef.current !== null) {
        moveEvent.preventDefault()
        const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        const folderTarget = element?.closest<HTMLElement>('[data-folder-id]')
        const listTarget = element?.closest<HTMLElement>('[data-folder-parent-id]')
        pointerTargetRef.current = folderTarget?.dataset.folderId
          ? { folderId: folderTarget.dataset.folderId as FolderId }
          : listTarget?.dataset.folderParentId
            ? { parentId: listTarget.dataset.folderParentId }
            : null
      }
    }
    const onUp = (upEvent: globalThis.PointerEvent) => {
      const dragged = pointerDragRef.current
      const target = pointerTargetRef.current
      pointerStartRef.current = null
      pointerDragRef.current = null
      pointerTargetRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setPointerDragging(null)
      if (dragged !== null) void finishPointerDrop(dragged, upEvent.clientX, upEvent.clientY, target ?? undefined)
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp, { once: true })
  }

  const selected = props.folders.find((folder) => folder.id === props.activeId)
  const visibleKeys = useMemo<TreeItemKey[]>(
    () => [
      ...(props.showUnfiled !== false ? ['root' as const] : []),
      ...(props.onTemporaryInbox ? ['temporary-inbox' as const] : []),
      ...(props.onTrash ? ['trash' as const] : []),
      ...flattenVisibleFolders(props.folders, collapsedFolders),
    ],
    [props.folders, props.onTemporaryInbox, props.onTrash, collapsedFolders],
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
        if (key !== 'root' && key !== 'temporary-inbox' && key !== 'trash' && target !== undefined && collapsedFolders.has(key)) {
          userToggledFoldersRef.current.add(key)
          setMountedFolders((current) => new Set(current).add(key))
          setCollapsedFolders((current) => {
            const next = new Set(current)
            next.delete(key)
            return next
          })
        }
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

  const openContextMenu = (event: ReactMouseEvent<HTMLElement>, target: FolderId | null) => {
    event.preventDefault()
    event.stopPropagation()
    setContextTarget(target)
    setContextPosition({ x: event.clientX, y: event.clientY })
  }

  const renderBranch = (parentId: FolderId | null): React.ReactNode =>
    props.folders
      .filter((folder) => folder.parentId === parentId)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
      .map((folder) => {
        const hasChildren = props.folders.some((candidate) => candidate.parentId === folder.id)
        const folderContents = typeof props.folderContents === 'function' ? props.folderContents(folder.id) : props.activeId === folder.id ? props.folderContents : undefined
        const hasFolderContents = folderContents !== undefined
        // A contents resolver means notes are lazy-loaded per folder. Treat every
        // folder as expandable up front so the disclosure does not appear only
        // after the first selection (which would require a second click).
        const canContainNotes = typeof props.folderContents === 'function'
        const expandable = hasChildren || hasFolderContents || canContainNotes
        const expanded = !expandable || !collapsedFolders.has(folder.id)
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
                aria-expanded={expandable ? expanded : undefined}
                aria-keyshortcuts="Control+M"
                tabIndex={focusedKey === folder.id ? 0 : -1}
                draggable={false}
                className={`folder-tree__item${pointerDragging === folder.id ? ' folder-tree__item--dragging' : ''}`}
                type="button"
                data-folder-id={folder.id}
                onPointerDown={(event) => handlePointerDown(event, folder.id)}
                onPointerEnter={() => {
                  if (pointerDragRef.current !== null && pointerDragRef.current !== folder.id) {
                    pointerTargetRef.current = { folderId: folder.id }
                  }
                }}
                onFocus={() => setFocusedKey(folder.id)}
                onKeyDown={(event) => handleTreeKey(event, folder.id)}
                onClick={() => {
                  if (suppressClickRef.current) return
                  userToggledFoldersRef.current.add(folder.id)
                  setMountedFolders((current) => new Set(current).add(folder.id))
                  props.onSelect(folder.id)
                  if (expandable) setCollapsedFolders((current) => {
                    const next = new Set(current)
                    if (next.has(folder.id)) next.delete(folder.id)
                    else next.add(folder.id)
                    return next
                  })
                }}
                onContextMenu={(event) => openContextMenu(event, folder.id)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', folder.id)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => void dropFolder(event, folder.id)}
              >
                <Icon name="folder" size={16} />
                <span>{folder.name}</span>
                {expandable && (
                  <span
                    aria-hidden="true"
                    className="folder-tree__disclosure"
                    data-expanded={String(expanded)}
                    data-testid={`folder-disclosure-${folder.name}`}
                  />
                )}
              </button>
            )}
            {hasChildren && (expanded || mountedFolders.has(folder.id)) && <ul role="group" data-folder-parent-id={folder.id} data-collapsed={String(!expanded)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropFolder(event, folder.id)}>{renderBranch(folder.id)}</ul>}
            {hasFolderContents && (expanded || mountedFolders.has(folder.id)) && <div className="folder-tree__folder-notes" data-collapsed={String(!expanded)}>{folderContents}</div>}
          </li>
        )
      })

  const excludedMoveTargets = moving === null ? new Set<FolderId>() : descendantIds(moving, props.folders)

  return (
    <nav aria-label="文件夹" className="folder-tree" onContextMenu={(event) => { if (event.target === event.currentTarget) openContextMenu(event, null) }}>
      <header className="library-pane__header">
        <div>
          <span className="library-pane__eyebrow">本地笔记</span>
          <h1>资料库</h1>
        </div>
        <div className="library-pane__header-actions">
          {props.onCollapse && (
            <button className="icon-button" type="button" aria-label="折叠资料库" onClick={props.onCollapse}>
              <Icon name="collapse" size={18} />
            </button>
          )}
          <button className="icon-button" type="button" aria-label="新建文件夹" onClick={() => { setCreateParent(props.activeId); setCreating(true) }}>
            <Icon name="plus" size={18} />
          </button>
          <FolderActionMenu
            enabled={selected !== undefined}
            starred={selected?.starred === true}
            onRename={() => {
              if (!selected) return
              setRenaming(selected.id)
              setName(selected.name)
            }}
            onMove={() => {
              if (!selected) return
              setMoving(selected.id)
              setMoveTarget(selected.parentId)
            }}
            onDelete={() => props.activeId !== null && setDeleteTarget(props.activeId)}
            onToggleStar={() => { if (selected) void runToggleStar(selected.id) }}
          />
        </div>
      </header>
      {creating && (
        <form className="folder-form" onSubmit={(event) => void finishCreate(event)}>
          <input autoFocus aria-label="文件夹名称" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setCreating(false); setName(''); setCreateParent(null) } }} />
        </form>
      )}
      {contextPosition !== null && (
        <div ref={contextMenuRef} className="folder-context-menu" role="menu" aria-label="文件夹快捷操作" style={{ left: contextPosition?.x ?? 8, top: contextPosition?.y ?? 8 }} onContextMenu={(event) => event.preventDefault()}>
          <button type="button" role="menuitem" onClick={() => { setCreateParent(contextTarget); setCreating(true); setName(''); setContextTarget(null); setContextPosition(null) }}>新建文件夹</button>
          {props.onCreateNote && contextTarget !== null && <button type="button" role="menuitem" onClick={() => { props.onCreateNote?.(contextTarget); setContextTarget(null); setContextPosition(null) }}>新建笔记</button>}
          {contextTarget !== null && <button type="button" role="menuitem" onClick={() => { const folder = props.folders.find((candidate) => candidate.id === contextTarget); if (folder) { setRenaming(folder.id); setName(folder.name) }; setContextTarget(null); setContextPosition(null) }}>重命名文件夹</button>}
          {contextTarget !== null && <button type="button" role="menuitem" onClick={() => void runToggleStar(contextTarget)}>{props.folders.find((folder) => folder.id === contextTarget)?.starred === true ? '取消星标' : '添加星标'}</button>}
          {contextTarget !== null && <button type="button" role="menuitem" onClick={() => { setDeleteTarget(contextTarget); setContextTarget(null); setContextPosition(null) }}>删除文件夹</button>}
        </div>
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
      <ul role="tree" aria-label="笔记文件夹" className="folder-tree__list" data-folder-parent-id="root" onContextMenu={(event) => { if (event.target === event.currentTarget) openContextMenu(event, null) }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropFolder(event, null)}>
        {props.showUnfiled !== false && <li role="none">
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
            <Icon name="folder" size={16} />
            <span>未归档笔记</span>
          </button>
        </li>}
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
              <Icon name="inbox" size={16} />
              <span>临时便签</span>
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
              <Icon name="trash" size={16} />
              <span>回收站</span>
            </button>
          </li>
        )}
        {props.folders.some((folder) => folder.parentId === null) && <li role="separator" className="folder-tree__separator" aria-label="系统入口与文件夹分隔线" />}
        {renderBranch(null)}
        {props.activeId === null && props.folderContents !== undefined && <li role="none" className="folder-tree__root-notes">{typeof props.folderContents === 'function' ? props.folderContents(null) : props.folderContents}</li>}
      </ul>
      {error && <p role="alert" className="library-status library-status--error">文件夹操作未完成。</p>}
      {deleteTarget !== null && (
        <div className="folder-delete-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null) }}>
          <section className="folder-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="folder-delete-heading">
            <div className="folder-delete-dialog__icon" aria-hidden="true"><Icon name="trash" size={20} /></div>
            <div className="folder-delete-dialog__body">
              <span className="folder-delete-dialog__eyebrow">删除文件夹</span>
              <h2 id="folder-delete-heading">确定删除“{props.folders.find((folder) => folder.id === deleteTarget)?.name ?? '此文件夹'}”？</h2>
              <p>文件夹及其全部笔记和子文件夹会移入回收站，之后仍可恢复。</p>
            </div>
            <div className="folder-delete-dialog__actions">
              <button type="button" onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="folder-delete-dialog__confirm" onClick={() => void runDelete()}>删除文件夹</button>
            </div>
          </section>
        </div>
      )}
    </nav>
  )
}

type TreeItemKey = 'root' | 'temporary-inbox' | 'trash' | FolderId

function defaultCollapsedFolders(
  folders: Folder[],
  folderContents: FolderTreeProps['folderContents'],
  activeId: FolderId | null,
): Set<FolderId> {
  return new Set(folders.filter((folder) => {
    const hasChildren = folders.some((candidate) => candidate.parentId === folder.id)
    const lazyContents = typeof folderContents === 'function'
    const contents = typeof folderContents === 'function'
      ? folderContents(folder.id)
      : activeId === folder.id
        ? folderContents
        : undefined
    return hasChildren || lazyContents || contents !== undefined
  }).map((folder) => folder.id))
}

function mountedFolderIds(
  folders: Folder[],
  folderContents: FolderTreeProps['folderContents'],
  activeId: FolderId | null,
): Set<FolderId> {
  const collapsed = defaultCollapsedFolders(folders, folderContents, activeId)
  return new Set(folders.filter((folder) => !collapsed.has(folder.id)).map((folder) => folder.id))
}

function flattenVisibleFolders(folders: Folder[], collapsed: Set<FolderId>, parentId: FolderId | null = null): FolderId[] {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    .flatMap((folder) => [folder.id, ...(collapsed.has(folder.id) ? [] : flattenVisibleFolders(folders, collapsed, folder.id))])
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
