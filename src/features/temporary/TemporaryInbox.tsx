import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { AssetPort, TemporaryPort } from '../../domain/ports'
import type { Folder, FolderId, NoteDocument, NoteId } from '../../domain/model'
import { EditorPane, type EditorPaneHandle } from '../editor/EditorPane'
import { ConvertDialog } from './ConvertDialog'

interface TemporaryInboxProps {
  temporary: TemporaryPort
  folders: Folder[]
  assets?: AssetPort
  autosaveDelayMs?: number
}

export interface TemporaryInboxHandle {
  flush(): Promise<boolean>
  beginEditBarrier(): Promise<void>
  endEditBarrier(): void
  refresh(): Promise<void>
}

type LoadState = 'loading' | 'ready' | 'error'

export const TemporaryInbox = forwardRef<TemporaryInboxHandle, TemporaryInboxProps>(function TemporaryInbox(
  { temporary, folders, assets, autosaveDelayMs },
  ref,
) {
  const [items, setItems] = useState<NoteDocument[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [selected, setSelected] = useState<ReadonlySet<NoteId>>(new Set())
  const [dismissed, setDismissed] = useState<ReadonlySet<NoteId>>(new Set())
  const [activeId, setActiveId] = useState<NoteId | null>(null)
  const [document, setDocument] = useState<NoteDocument | null>(null)
  const [documentState, setDocumentState] = useState<LoadState>('ready')
  const [busy, setBusy] = useState<'delete' | 'convert' | 'undo' | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [undoOperationId, setUndoOperationId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)
  const documentRequestRef = useRef(0)
  const busyRef = useRef<'delete' | 'convert' | 'undo' | null>(null)
  const editorRef = useRef<EditorPaneHandle>(null)

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    setState('loading')
    try {
      const result = await temporary.list()
      if (request !== requestRef.current) return
      const visible = result.filter((item) => item.kind === 'temporary').sort(newestFirst)
      setItems(visible)
      setSelected((current) => new Set([...current].filter((id) => visible.some((item) => item.id === id))))
      if (activeId !== null && !visible.some((item) => item.id === activeId)) {
        documentRequestRef.current += 1
        setActiveId(null)
        setDocument(null)
        setDocumentState('ready')
      }
      setState('ready')
    } catch {
      if (request === requestRef.current) setState('error')
    }
  }, [activeId, temporary])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visibleItems = useMemo(() => items.filter((item) => !dismissed.has(item.id)), [dismissed, items])
  const selectedIds = useMemo(() => visibleItems.filter((item) => selected.has(item.id)).map((item) => item.id), [selected, visibleItems])
  const temporaryNotes = useMemo(() => ({ saveNote: temporary.save, loadNote: temporary.load }), [temporary])

  const toggleSelected = (noteId: NoteId) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return next
    })
  }

  const openCapture = async (noteId: NoteId) => {
    if (busyRef.current !== null) return
    const request = ++documentRequestRef.current
    if (activeId !== null && !(await editorRef.current?.flush() ?? true)) {
      if (request === documentRequestRef.current) {
        setError('当前临时捕捉无法保存。请重试保存后再切换。')
      }
      return
    }
    if (request !== documentRequestRef.current || busyRef.current !== null) return
    setError(null)
    setActiveId(noteId)
    setDocument(null)
    setDocumentState('loading')
    temporary.load(noteId).then(
      (loaded) => {
        if (request !== documentRequestRef.current || loaded.id !== noteId || loaded.kind !== 'temporary') return
        setDocument(loaded)
        setDocumentState('ready')
      },
      () => {
        if (request === documentRequestRef.current) setDocumentState('error')
      },
    )
  }

  const flushOpenSelection = async (ids: readonly NoteId[]) => {
    if (activeId === null || !ids.includes(activeId)) return true
    return (await editorRef.current?.flush()) ?? true
  }

  useImperativeHandle(ref, () => ({
    flush: () => busyRef.current === null
      ? editorRef.current?.flush() ?? Promise.resolve(true)
      : Promise.resolve(false),
    beginEditBarrier: () => editorRef.current?.beginEditBarrier() ?? Promise.resolve(),
    endEditBarrier: () => editorRef.current?.endEditBarrier(),
    refresh,
  }), [refresh])

  const showFailure = (failures: Array<{ message: string }>) => {
    setError(failures.length === 0 ? null : failures.map((failure) => failure.message).join('；'))
  }

  const removeSuccessful = (ids: NoteId[]) => {
    const successful = new Set(ids)
    setDismissed((current) => new Set([...current, ...successful]))
    setSelected((current) => new Set([...current].filter((id) => !successful.has(id))))
    if (activeId !== null && successful.has(activeId)) {
      documentRequestRef.current += 1
      setActiveId(null)
      setDocument(null)
      setDocumentState('ready')
    }
  }

  const deleteSelected = async () => {
    if (selectedIds.length === 0 || busyRef.current !== null) return
    const ids = [...selectedIds]
    busyRef.current = 'delete'
    setBusy('delete')
    setError(null)
    try {
      if (!(await flushOpenSelection(ids))) {
        setError('请先解决保存错误，再删除临时捕捉。')
        return
      }
      const result = await temporary.delete(ids)
      removeSuccessful(result.deleted)
      setUndoOperationId(result.deleted.length > 0 ? result.operationId : null)
      showFailure(result.failed)
      void refresh()
    } catch {
      setError('无法删除临时捕捉。')
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  const convertSelected = async (folderId: FolderId) => {
    if (selectedIds.length === 0 || busyRef.current !== null) return
    const ids = [...selectedIds]
    busyRef.current = 'convert'
    setBusy('convert')
    setError(null)
    try {
      if (!(await flushOpenSelection(ids))) {
        setError('请先解决保存错误，再转换临时捕捉。')
        return
      }
      const result = await temporary.convert({ ids, folderId })
      removeSuccessful(result.converted.map((item) => item.temporaryId))
      showFailure(result.failed)
      setDialogOpen(false)
      void refresh()
    } catch {
      setError('无法转换临时捕捉。')
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  const undoDelete = async () => {
    if (undoOperationId === null || busyRef.current !== null) return
    busyRef.current = 'undo'
    setBusy('undo')
    setError(null)
    try {
      const result = await temporary.undoDelete(undoOperationId)
      const restored = new Set(result.restored)
      setDismissed((current) => new Set([...current].filter((id) => !restored.has(id))))
      setUndoOperationId(result.failed.length === 0 ? null : undoOperationId)
      showFailure(result.failed)
      await refresh()
    } catch {
      setError('无法撤销删除。')
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  return (
    <section className="temporary-inbox" aria-label="临时收集箱">
      <header className="temporary-inbox__header">
        <div>
          <span className="library-pane__eyebrow">临时捕捉</span>
          <h2>临时收集箱</h2>
        </div>
        <button type="button" aria-label="刷新临时收集箱" disabled={busy !== null} onClick={() => void refresh()}>刷新</button>
      </header>
      <div className="temporary-inbox__actions" aria-label="临时收集箱操作">
        <button type="button" disabled={busy !== null || visibleItems.length === 0} onClick={() => setSelected(new Set(visibleItems.map((item) => item.id)))}>全选</button>
        <button type="button" disabled={busy !== null || selectedIds.length === 0} onClick={() => setSelected(new Set())}>清除选择</button>
        <button type="button" disabled={busy !== null || selectedIds.length === 0} onClick={() => setDialogOpen(true)}>转为笔记</button>
        <button type="button" disabled={busy !== null || selectedIds.length === 0} onClick={() => void deleteSelected()}>{busy === 'delete' ? '正在删除…' : '删除所选'}</button>
        {undoOperationId && <button type="button" disabled={busy !== null} onClick={() => void undoDelete()}>{busy === 'undo' ? '正在恢复…' : '撤销删除'}</button>}
      </div>
      {error && <p role="alert" className="library-status library-status--error">{error}</p>}
      {state === 'loading' && <p role="status" className="library-status">正在加载临时捕捉…</p>}
      {state === 'error' && <p role="alert" className="library-status library-status--error">无法加载临时捕捉。</p>}
      {state === 'ready' && visibleItems.length === 0 && <p className="library-status">临时收集箱为空。</p>}
      {state === 'ready' && visibleItems.length > 0 && (
        <ul className="temporary-inbox__list" aria-label="临时捕捉列表">
          {visibleItems.map((item) => {
            const title = safeTitle(item)
            return (
              <li key={item.id} className={activeId === item.id ? 'is-active' : undefined}>
                <label>
                  <input type="checkbox" aria-label={`选择 ${title}`} checked={selected.has(item.id)} disabled={busy !== null} onChange={() => toggleSelected(item.id)} />
                  <span className="sr-only">选择 {title}</span>
                </label>
                <button type="button" className="temporary-inbox__capture" aria-current={activeId === item.id ? 'true' : undefined} disabled={busy !== null} onClick={() => void openCapture(item.id)}>
                  <strong>{title}</strong>
                  <span>{preview(item.markdown)}</span>
                  <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="temporary-inbox__editor" aria-label="临时捕捉编辑器">
        {documentState === 'loading' && <p className="content-placeholder">正在打开临时捕捉…</p>}
        {documentState === 'error' && <p role="alert" className="content-placeholder content-placeholder--error">无法打开临时捕捉。</p>}
        {document && <EditorPane ref={editorRef} key={`${document.id}:${document.revision}`} document={document} notes={temporaryNotes} assets={assets} autosaveDelayMs={autosaveDelayMs} onDocumentAdopt={(authoritative) => {
          setDocument(authoritative)
          setItems((current) => current.map((item) => item.id === authoritative.id ? authoritative : item))
        }} />}
      </div>
      <ConvertDialog folders={folders} open={dialogOpen} busy={busy === 'convert'} onCancel={() => setDialogOpen(false)} onConfirm={(folderId) => void convertSelected(folderId)} />
    </section>
  )
})

function newestFirst(left: NoteDocument, right: NoteDocument) {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)
}

function safeTitle(document: NoteDocument) {
  return deriveTemporaryPreviewTitle(document.markdown, document.createdAt)
}

/** Mirrors Rust's explicit Unicode-scalar title derivation for inbox previews. */
export function deriveTemporaryPreviewTitle(markdown: string, timestamp: string) {
  const first = markdown
    .split(/\r?\n/u)
    .map(trimApplicationWhitespace)
    .find((line) => line.length > 0)
  if (first === undefined) return untitledTimestamp(timestamp)

  let value = first
  const characters = Array.from(value)
  let hashes = 0
  while (characters[hashes] === '#') hashes += 1
  if (hashes >= 1 && hashes <= 6 && characters[hashes] !== undefined && isApplicationWhitespace(characters[hashes])) {
    value = trimStartApplicationWhitespace(characters.slice(hashes).join(''))
  }

  let collapsed = ''
  let pendingSpace = false
  for (const character of value) {
    if (isApplicationWhitespace(character)) {
      pendingSpace = collapsed.length > 0
    } else {
      if (pendingSpace) collapsed += ' '
      collapsed += character
      pendingSpace = false
    }
  }
  const title = trimApplicationWhitespace(Array.from(collapsed).slice(0, 80).join(''))
  return title || untitledTimestamp(timestamp)
}

function isApplicationWhitespace(character: string) {
  const scalar = character.codePointAt(0)
  return scalar !== undefined && (
    (scalar >= 0x09 && scalar <= 0x0d) ||
    scalar === 0x20 ||
    scalar === 0x85 ||
    scalar === 0xa0 ||
    scalar === 0x1680 ||
    (scalar >= 0x2000 && scalar <= 0x200a) ||
    scalar === 0x2028 ||
    scalar === 0x2029 ||
    scalar === 0x202f ||
    scalar === 0x205f ||
    scalar === 0x3000 ||
    scalar === 0xfeff
  )
}

function trimApplicationWhitespace(value: string) {
  const characters = Array.from(value)
  let start = 0
  let end = characters.length
  while (start < end && isApplicationWhitespace(characters[start])) start += 1
  while (end > start && isApplicationWhitespace(characters[end - 1])) end -= 1
  return characters.slice(start, end).join('')
}

function trimStartApplicationWhitespace(value: string) {
  const characters = Array.from(value)
  let index = 0
  while (index < characters.length && isApplicationWhitespace(characters[index])) index += 1
  return characters.slice(index).join('')
}

function untitledTimestamp(timestamp: string) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/u.exec(timestamp)
  return match === null ? '未命名笔记' : `未命名笔记 ${match[1]} ${match[2]}-${match[3]}`
}

function preview(markdown: string) {
  return markdown.replace(/\s+/gu, ' ').trim().slice(0, 96)
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
