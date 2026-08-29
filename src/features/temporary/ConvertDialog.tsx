import { useEffect, useMemo, useRef, useState } from 'react'
import type { Folder, FolderId } from '../../domain/model'

interface ConvertDialogProps {
  folders: Folder[]
  open: boolean
  busy: boolean
  onCancel(): void
  initialTitle?: string
  initialTags?: string[]
  onConfirm(folderId: FolderId, title: string, tags: string[]): void
}

export function ConvertDialog({ folders, open, busy, initialTitle = '', initialTags = [], onCancel, onConfirm }: ConvertDialogProps) {
  const [folderId, setFolderId] = useState<FolderId | null>(null)
  const [title, setTitle] = useState('')
  const [tagsText, setTagsText] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)
  const tagsRef = useRef<HTMLInputElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const options = useMemo(() => flattenFolders(folders), [folders])

  useEffect(() => {
    if (!open) return
    setFolderId(options[0]?.id ?? null)
    setTitle(initialTitle)
    setTagsText(initialTags.join(', '))
    queueMicrotask(() => selectRef.current?.focus())
  // Initial metadata is captured when the dialog opens. It must not reset
  // while the editor flushes and updates the selected capture underneath us.
  }, [open, options])

  if (!open) return null
  return (
    <div className="temporary-dialog-backdrop" role="presentation" onMouseDown={() => !busy && onCancel()}>
      <section
        className="temporary-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onCancel()
          if (event.key !== 'Tab') return
          const focusable = [titleRef.current, tagsRef.current, selectRef.current, cancelRef.current, confirmRef.current]
            .filter((element): element is HTMLButtonElement | HTMLInputElement | HTMLSelectElement => element !== null && !element.disabled)
          const current = focusable.indexOf(document.activeElement as HTMLButtonElement | HTMLInputElement | HTMLSelectElement)
          if (current === -1) return
          const next = event.shiftKey
            ? (current - 1 + focusable.length) % focusable.length
            : (current + 1) % focusable.length
          event.preventDefault()
          focusable[next]?.focus()
        }}
      >
        <h2 id="convert-dialog-title">转为笔记</h2>
        <p>所选临时捕捉将分别创建为笔记。</p>
        {options.length > 0 && <>
          <label>
            笔记标题
            <input ref={titleRef} aria-label="笔记标题" value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} placeholder="留空则使用正文首行" />
          </label>
          <label>
            笔记标签
            <input ref={tagsRef} aria-label="笔记标签" value={tagsText} disabled={busy} onChange={(event) => setTagsText(event.target.value)} placeholder="用逗号分隔多个标签" />
          </label>
        </>}
        <label>
          目标文件夹
          <select
            ref={selectRef}
            aria-label="目标文件夹"
            disabled={busy}
            value={folderId ?? ''}
            onChange={(event) => setFolderId(event.target.value as FolderId)}
          >
            {options.map((folder) => (
              <option key={folder.id} value={folder.id}>{folder.label}</option>
            ))}
          </select>
        </label>
        <footer>
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button ref={confirmRef} type="button" disabled={busy || folderId === null} onClick={() => folderId !== null && onConfirm(folderId, title.trim(), parseTags(tagsText))}>
            {busy ? '正在转换…' : '确认转换'}
          </button>
        </footer>
      </section>
    </div>
  )
}

function parseTags(value: string) {
  return [...new Set(value.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean))]
}

function flattenFolders(folders: Folder[], parentId: FolderId | null = null, prefix = ''): Array<{ id: FolderId; label: string }> {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    .flatMap((folder) => [
      { id: folder.id, label: `${prefix}${folder.name}` },
      ...flattenFolders(folders, folder.id, `${prefix}${folder.name} / `),
    ])
}
