import {text as uiText} from '../../shared/i18n'
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
        <h2 id="convert-dialog-title">{uiText("转为笔记","Convert to note")}</h2>
        <p>{uiText("所选临时捕捉将分别创建为笔记。","Each selected capture will become a separate note.")}</p>
        {options.length > 0 && <>
          <label>{uiText("笔记标题","Note title")}<input ref={titleRef} aria-label={uiText("笔记标题","Note title")} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} placeholder={uiText("留空则使用正文首行","Leave blank to use the first line")} />
          </label>
          <label>{uiText("笔记标签","Note tags")}<input ref={tagsRef} aria-label={uiText("笔记标签","Note tags")} value={tagsText} disabled={busy} onChange={(event) => setTagsText(event.target.value)} placeholder={uiText("用逗号分隔多个标签","Separate tags with commas")} />
          </label>
        </>}
        <label>{uiText("目标文件夹","Destination folder")}<select
            ref={selectRef}
            aria-label={uiText("目标文件夹","Destination folder")}
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
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>{uiText("取消","Cancel")}</button>
          <button ref={confirmRef} type="button" disabled={busy || folderId === null} onClick={() => folderId !== null && onConfirm(folderId, title.trim(), parseTags(tagsText))}>
            {busy ? uiText("正在转换…","Converting…") : uiText("确认转换","Confirm conversion")}
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
