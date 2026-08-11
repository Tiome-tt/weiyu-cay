import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Folder, NoteId } from '../../domain/model'
import type { TrashEntry, TrashPort } from '../../domain/ports'

interface TrashViewProps {
  trash: TrashPort
  folders: Folder[]
  recentOperationId?: string | null
  onLibraryChanged?: () => Promise<void> | void
  onUndoCompleted?: (operationId: string) => void
}

type LoadState = 'loading' | 'ready' | 'error'
type BusyAction = 'restore' | 'undo' | null

export function TrashView({ trash, folders, recentOperationId = null, onLibraryChanged, onUndoCompleted }: TrashViewProps) {
  const [entries, setEntries] = useState<TrashEntry[]>([])
  const [selected, setSelected] = useState<ReadonlySet<NoteId>>(new Set())
  const [state, setState] = useState<LoadState>('loading')
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [dismissedUndoOperations, setDismissedUndoOperations] = useState<ReadonlySet<string>>(new Set())
  const requestRef = useRef(0)
  const busyRef = useRef<BusyAction>(null)
  const feedbackRef = useRef<HTMLParagraphElement>(null)
  const mountedRef = useRef(false)

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return
    const request = ++requestRef.current
    setState('loading')
    try {
      const listed = await trash.list()
      if (request !== requestRef.current) return
      const sorted = [...listed].sort((left, right) => right.deletedAt.localeCompare(left.deletedAt) || left.noteId.localeCompare(right.noteId))
      setEntries(sorted)
      setSelected((current) => new Set([...current].filter((id) => sorted.some((entry) => entry.noteId === id))))
      setState('ready')
    } catch {
      if (request === requestRef.current) setState('error')
    }
  }, [trash])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [refresh])

  useEffect(() => {
    if (feedback !== null) feedbackRef.current?.focus()
  }, [feedback])

  const selectedIds = useMemo(
    () => entries.filter((entry) => selected.has(entry.noteId)).map((entry) => entry.noteId),
    [entries, selected],
  )
  const undoOperationId = recentOperationId ?? entries[0]?.operationId ?? null
  const undoAvailable = undoOperationId !== null && !dismissedUndoOperations.has(undoOperationId)

  const toggleSelected = (noteId: NoteId) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return next
    })
  }

  const restoreSelected = async () => {
    if (busyRef.current !== null || selectedIds.length === 0) return
    const ids = [...selectedIds]
    const selectedEntries = entries.filter((entry) => selected.has(entry.noteId))
    requestRef.current += 1
    busyRef.current = 'restore'
    setBusy('restore')
    setError(null)
    setFeedback(null)
    try {
      const result = await trash.restore(ids)
      let surroundingRefreshFailed = false
      try {
        await onLibraryChanged?.()
      } catch {
        surroundingRefreshFailed = true
      }
      if (!mountedRef.current) return
      const restoredIds = new Set(result.restored.map((document) => document.id))
      const usedRecoveryFolder = selectedEntries.some(
        (entry) => restoredIds.has(entry.noteId) && isMissingFolder(entry, folders),
      )
      setEntries((current) => current.filter((entry) => !restoredIds.has(entry.noteId)))
      setSelected((current) => new Set([...current].filter((id) => !restoredIds.has(id))))
      const errors = result.failed.map((failure) => failure.message)
      if (surroundingRefreshFailed) errors.push('项目已恢复，但资料库刷新失败，请手动刷新。')
      if (errors.length > 0) setError(errors.join('；'))
      if (restoredIds.size > 0) {
        setFeedback(`已恢复 ${restoredIds.size} 项。${usedRecoveryFolder ? '原文件夹不可用的项目已放入“已恢复”。' : ''}`)
      }
      setState('ready')
    } catch {
      if (mountedRef.current) {
        setError('无法恢复所选项目，请重试。')
        setState('ready')
      }
    } finally {
      busyRef.current = null
      if (mountedRef.current) setBusy(null)
    }
  }

  const undoRecentDeletion = async () => {
    if (undoOperationId === null || !undoAvailable || busyRef.current !== null) return
    const operationId = undoOperationId
    requestRef.current += 1
    busyRef.current = 'undo'
    setBusy('undo')
    setError(null)
    setFeedback(null)
    try {
      const result = await trash.undo(operationId)
      let surroundingRefreshFailed = false
      try {
        await onLibraryChanged?.()
      } catch {
        surroundingRefreshFailed = true
      }
      if (!mountedRef.current) return
      if (result.failed.length > 0) {
        setError(result.failed.map((failure) => failure.message).join('；'))
      } else {
        setDismissedUndoOperations((current) => new Set([...current, operationId]))
        onUndoCompleted?.(operationId)
      }
      if (surroundingRefreshFailed) setError((current) => [current, '项目已恢复，但资料库刷新失败，请手动刷新。'].filter(Boolean).join('；'))
      if (result.restored.length > 0) setFeedback(`已撤销最近删除，恢复 ${result.restored.length} 项。`)
      await refresh()
    } catch {
      if (mountedRef.current) {
        setError('无法撤销最近删除，请重试。')
        setState('ready')
      }
    } finally {
      busyRef.current = null
      if (mountedRef.current) setBusy(null)
    }
  }

  return (
    <section className="trash-view" aria-label="回收站">
      <header className="trash-view__header">
        <div>
          <span className="library-pane__eyebrow">安全恢复</span>
          <h2>回收站</h2>
        </div>
        <button type="button" disabled={busy !== null} onClick={() => void refresh()}>刷新</button>
      </header>
      <div className="trash-view__actions" aria-label="回收站操作">
        <button
          type="button"
          disabled={busy !== null || entries.length === 0}
          onClick={() => setSelected(new Set(entries.map((entry) => entry.noteId)))}
        >
          全选
        </button>
        <button type="button" disabled={busy !== null || selectedIds.length === 0} onClick={() => setSelected(new Set())}>清除选择</button>
        <button type="button" disabled={busy !== null || selectedIds.length === 0} onClick={() => void restoreSelected()}>
          {busy === 'restore' ? '正在恢复…' : '恢复所选'}
        </button>
        {undoAvailable && (
          <button type="button" disabled={busy !== null} onClick={() => void undoRecentDeletion()}>
            {busy === 'undo' ? '正在撤销…' : '撤销最近删除'}
          </button>
        )}
      </div>
      {feedback !== null && <p ref={feedbackRef} tabIndex={-1} role="status" className="library-status">{feedback}</p>}
      {error !== null && <p role="alert" className="library-status library-status--error">{error}</p>}
      {state === 'loading' && <p role="status" className="library-status">正在加载回收站…</p>}
      {state === 'error' && <p role="alert" className="library-status library-status--error">无法加载回收站。</p>}
      {state === 'ready' && entries.length === 0 && <p className="library-status">回收站为空。</p>}
      {state === 'ready' && entries.length > 0 && (
        <ul className="trash-view__list" aria-label="已删除项目">
          {entries.map((entry) => {
            const missingFolder = isMissingFolder(entry, folders)
            return (
              <li key={entry.noteId}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${entry.title}`}
                    checked={selected.has(entry.noteId)}
                    disabled={busy !== null}
                    onChange={() => toggleSelected(entry.noteId)}
                  />
                  <span className="trash-view__item">
                    <strong>{entry.title}</strong>
                    <span>{entry.kind === 'formal' ? '正式笔记' : '临时捕捉'}</span>
                    <span>{missingFolder ? '原文件夹不可用，将恢复到“已恢复”' : `原位置：${folderName(entry, folders)}`}</span>
                    <time dateTime={entry.deletedAt}>删除于 {formatDate(entry.deletedAt)}</time>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function isMissingFolder(entry: TrashEntry, folders: Folder[]) {
  return entry.previousFolderId !== null && !folders.some((folder) => folder.id === entry.previousFolderId)
}

function folderName(entry: TrashEntry, folders: Folder[]) {
  if (entry.kind === 'temporary') return '临时收集箱'
  if (entry.previousFolderId === null) return '未归档笔记'
  return folders.find((folder) => folder.id === entry.previousFolderId)?.name ?? '已恢复'
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
