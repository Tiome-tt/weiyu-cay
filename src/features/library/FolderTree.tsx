import { useState, type DragEvent, type FormEvent } from 'react'
import type { Folder, FolderId } from '../../domain/model'

interface FolderTreeProps {
  folders: Folder[]
  activeId: FolderId | null
  state: 'loading' | 'ready' | 'error'
  onSelect: (id: FolderId | null) => void
  onCreate: (parentId: FolderId | null, name: string) => Promise<void>
  onRename: (id: FolderId, name: string) => Promise<void>
  onMove: (id: FolderId, parentId: FolderId | null) => Promise<void>
  onDelete: (id: FolderId) => Promise<void>
}

export function FolderTree(props: FolderTreeProps) {
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<FolderId | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState(false)

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
        <button type="button" aria-label="删除空文件夹" disabled={!selected} onClick={() => void runDelete()}>
          删除
        </button>
      </div>
      {creating && (
        <form className="folder-form" onSubmit={(event) => void finishCreate(event)}>
          <input autoFocus aria-label="文件夹名称" value={name} onChange={(event) => setName(event.target.value)} />
        </form>
      )}
      {props.state === 'loading' && <p className="library-status">正在加载文件夹…</p>}
      {props.state === 'error' && <p className="library-status library-status--error">无法加载文件夹。</p>}
      <ul role="tree" aria-label="笔记文件夹" className="folder-tree__list">
        <li role="none">
          <button
            role="treeitem"
            aria-selected={props.activeId === null}
            className="folder-tree__item"
            type="button"
            onClick={() => props.onSelect(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => void dropFolder(event, null)}
          >
            <span aria-hidden="true">⌂</span> 所有笔记
          </button>
        </li>
        {renderBranch(null, props.folders, props.activeId, renaming, name, setName, finishRename, props.onSelect, dropFolder)}
      </ul>
      {error && <p role="alert" className="library-status library-status--error">文件夹操作未完成。</p>}
    </nav>
  )
}

function renderBranch(
  parentId: FolderId | null,
  folders: Folder[],
  activeId: FolderId | null,
  renaming: FolderId | null,
  name: string,
  setName: (value: string) => void,
  finishRename: (event: FormEvent) => Promise<void>,
  onSelect: (id: FolderId | null) => void,
  dropFolder: (event: DragEvent, parentId: FolderId | null) => Promise<void>,
) {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    .map((folder) => {
      const hasChildren = folders.some((candidate) => candidate.parentId === folder.id)
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
              role="treeitem"
              aria-selected={activeId === folder.id}
              aria-expanded={hasChildren ? true : undefined}
              draggable
              className="folder-tree__item"
              type="button"
              onClick={() => onSelect(folder.id)}
              onDragStart={(event) => event.dataTransfer.setData('text/plain', folder.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void dropFolder(event, folder.id)}
            >
              <span aria-hidden="true">▱</span> {folder.name}
            </button>
          )}
          {hasChildren && (
            <ul role="group">
              {renderBranch(folder.id, folders, activeId, renaming, name, setName, finishRename, onSelect, dropFolder)}
            </ul>
          )}
        </li>
      )
    })
}
