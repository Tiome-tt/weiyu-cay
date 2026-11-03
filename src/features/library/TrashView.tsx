import {UI_LOCALE} from '../../shared/i18n'
import {text as uiText} from '../../shared/i18n'
import { ErrorNotification, OperationNotification } from '../../shared/notifications'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Folder, NoteId } from '../../domain/model'
import type { TrashEntry, TrashPort } from '../../domain/ports'

interface TrashViewProps {
  trash: TrashPort
  folders: Folder[]
  onLibraryChanged?: () => Promise<void> | void
}

type LoadState = 'loading' | 'ready' | 'error'
type BusyAction = 'restore' | 'purge' | null

export function TrashView({ trash, folders, onLibraryChanged }: TrashViewProps) {
  const [entries, setEntries] = useState<TrashEntry[]>([])
  const [selected, setSelected] = useState<ReadonlySet<NoteId>>(new Set())
  const [state, setState] = useState<LoadState>('loading')
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedbackState] = useState<{ message: string } | null>(null)
  const setFeedback = useCallback((message: string | null) => setFeedbackState(message === null ? null : { message }), [])
  const [purgeTarget, setPurgeTarget] = useState<ReadonlyArray<NoteId> | null>(null)
  const requestRef = useRef(0)
  const busyRef = useRef<BusyAction>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const mountedRef = useRef(false)

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    const silent = options.silent === true
    if (!mountedRef.current) return
    const request = ++requestRef.current
    if (!silent) setState('loading')
    try {
      const listed = await trash.list()
      if (request !== requestRef.current) return
      const sorted = [...listed].sort((left, right) => right.deletedAt.localeCompare(left.deletedAt) || left.noteId.localeCompare(right.noteId))
      setEntries(sorted)
      setSelected((current) => new Set([...current].filter((id) => sorted.some((entry) => entry.noteId === id))))
      setState('ready')
    } catch {
      if (request === requestRef.current && !silent) setState('error')
    }
  }, [trash])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const interval = window.setInterval(() => {
      if (busyRef.current === null) void refresh({ silent: true })
    }, 1000)
    return () => {
      mountedRef.current = false
      requestRef.current += 1
      window.clearInterval(interval)
    }
  }, [refresh])

  useEffect(() => {
    if (feedback !== null) headingRef.current?.focus()
  }, [feedback])

  const selectedIds = useMemo(
    () => entries.filter((entry) => selected.has(entry.noteId)).map((entry) => entry.noteId),
    [entries, selected],
  )
  const openPurgeDialog = (ids: ReadonlyArray<NoteId>) => {
    if (busyRef.current !== null || ids.length === 0 || trash.purge === undefined) return
    setPurgeTarget(ids)
  }

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
      if (surroundingRefreshFailed) errors.push(uiText("项目已恢复，但资料库刷新失败，请手动刷新。","Items were restored, but the library could not refresh. Refresh it manually."))
      if (errors.length > 0) setError(errors.join('；'))
      if (restoredIds.size > 0) {
        setFeedback(uiText(`已恢复 ${restoredIds.size} 项。${usedRecoveryFolder ? uiText("原文件夹不可用的项目已放入“已恢复”。","Items whose original folders are unavailable were placed in Recovered.") : ''}`,`Restored ${restoredIds.size} items.${usedRecoveryFolder ? uiText("原文件夹不可用的项目已放入“已恢复”。","Items whose original folders are unavailable were placed in Recovered.") : ''}`))
      }
      setState('ready')
    } catch {
      if (mountedRef.current) {
        setError(uiText("无法恢复所选项目，请重试。","Could not restore selected items. Try again."))
        setState('ready')
      }
    } finally {
      busyRef.current = null
      if (mountedRef.current) setBusy(null)
    }
  }

  const purgePermanently = async () => {
    if (busyRef.current !== null || purgeTarget === null || trash.purge === undefined) return
    const ids = [...purgeTarget]
    setPurgeTarget(null)
    requestRef.current += 1
    busyRef.current = 'purge'
    setBusy('purge')
    setError(null)
    setFeedback(null)
    try {
      const result = await trash.purge(ids)
      if (!mountedRef.current) return
      const purged = new Set(result.purged)
      setEntries((current) => current.filter((entry) => !purged.has(entry.noteId)))
      setSelected((current) => new Set([...current].filter((id) => !purged.has(id))))
      if (result.failed.length > 0) setError(result.failed.map((failure) => failure.message).join('；'))
      if (purged.size > 0) setFeedback(uiText(`已永久删除 ${purged.size} 项，之后无法恢复。`,`Permanently deleted ${purged.size} items. This cannot be undone.`))
      setState('ready')
    } catch {
      if (mountedRef.current) {
        setError(uiText("无法永久删除所选项目，请重试。","Could not permanently delete selected items. Try again."))
        setState('ready')
      }
    } finally {
      busyRef.current = null
      if (mountedRef.current) setBusy(null)
    }
  }

  return (
    <section className="trash-view" aria-label={uiText("回收站","Trash")}>
      <header className="trash-view__header">
        <div>
          <span className="library-pane__eyebrow">{uiText("安全恢复","Restore safely")}</span>
          <h2 ref={headingRef} tabIndex={-1}>{uiText("回收站","Trash")}</h2>
        </div>
      </header>
      <div className="trash-view__actions" aria-label={uiText("回收站操作","Trash actions")}>
        <button
          type="button"
          disabled={busy !== null || entries.length === 0}
          onClick={() => setSelected(new Set(entries.map((entry) => entry.noteId)))}
        >{uiText("全选","Select all")}</button>
        <button type="button" disabled={busy !== null || selectedIds.length === 0} onClick={() => setSelected(new Set())}>{uiText("清除选择","Clear selection")}</button>
        <button type="button" disabled={busy !== null || selectedIds.length === 0} onClick={() => void restoreSelected()}>
          {busy === 'restore' ? uiText("正在恢复…","Restoring…") : uiText("恢复所选","Restore selected")}
        </button>
        <button type="button" className="trash-view__danger-action" disabled={busy !== null || selectedIds.length === 0 || trash.purge === undefined} onClick={() => openPurgeDialog(selectedIds)}>{uiText("永久删除","Delete permanently")}</button>
        <button type="button" className="trash-view__danger-action" disabled={busy !== null || entries.length === 0 || trash.purge === undefined} onClick={() => openPurgeDialog(entries.map((entry) => entry.noteId))}>{uiText("清空回收站","Empty Trash")}</button>
      </div>
      <OperationNotification notice={feedback} />
      <ErrorNotification error={error} />
      {state === 'loading' && <p role="status" className="library-status">{uiText("正在加载回收站…","Loading Trash…")}</p>}
      <ErrorNotification error={state === 'error' ? uiText("无法加载回收站。","Could not load Trash.") : null} />
      {state === 'ready' && entries.length === 0 && <p className="library-status">{uiText("回收站为空。","Trash is empty.")}</p>}
      {state === 'ready' && entries.length > 0 && (
        <div className="trash-view__sections" aria-label={uiText("已删除项目","Deleted items")}>
          {(['temporary', 'formal'] as const).map((kind) => {
            const sectionEntries = entries.filter((entry) => entry.kind === kind)
            if (sectionEntries.length === 0) return null
            const label = kind === 'temporary' ? uiText("临时便笺","Sticky notes") : uiText("笔记","Note")
            return (
              <section key={kind} className="trash-view__section" aria-labelledby={`trash-${kind}-heading`}>
                <header className="trash-view__section-header">
                  <h3 id={`trash-${kind}-heading`}>{label}</h3>
                  <span>{sectionEntries.length}{uiText(" 条"," items")}</span>
                </header>
                <ul className="trash-view__list">
                  {sectionEntries.map((entry) => {
                    const missingFolder = isMissingFolder(entry, folders)
                    return (
                      <li key={entry.noteId}>
                        <label>
                          <input
                            type="checkbox"
                            aria-label={uiText(`选择 ${entry.title}`,`Select ${entry.title}`)}
                            checked={selected.has(entry.noteId)}
                            disabled={busy !== null}
                            onChange={() => toggleSelected(entry.noteId)}
                          />
                          <span className="trash-view__item">
                            <strong>{entry.title}</strong>
                            <span>{missingFolder ? missingFolderMessage(entry) : uiText(`原位置：${folderName(entry, folders)}`,`Original location: ${folderName(entry, folders)}`)}</span>
                            <time dateTime={entry.deletedAt}>{uiText("删除于 ","Deleted ")}{formatDate(entry.deletedAt)}</time>
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
      {purgeTarget !== null && (
        <div className="trash-view__dialog-backdrop" role="presentation">
          <section className="trash-view__dialog" role="alertdialog" aria-modal="true" aria-labelledby="trash-purge-heading">
            <span className="library-pane__eyebrow">{uiText("不可撤销","Cannot be undone")}</span>
            <h3 id="trash-purge-heading">{uiText("确定永久删除这些笔记吗？","Permanently delete these notes?")}</h3>
            <p>{uiText("删除后将清除笔记及其附件，之后无法恢复。","The notes and their attachments will be removed and cannot be recovered.")}</p>
            <footer>
              <button type="button" onClick={() => setPurgeTarget(null)}>{uiText("先不删除","Keep for now")}</button>
              <button type="button" className="trash-view__danger-action" onClick={() => void purgePermanently()}>{uiText("永久删除","Delete permanently")}</button>
            </footer>
          </section>
        </div>
      )}
    </section>
  )
}

function isMissingFolder(entry: TrashEntry, folders: Folder[]) {
  return entry.previousFolderId !== null && !folders.some((folder) => folder.id === entry.previousFolderId)
}

function folderName(entry: TrashEntry, folders: Folder[]) {
  if (entry.kind === 'temporary') return uiText("临时便笺","Sticky notes")
  if (entry.previousFolderId === null) return uiText("未归档笔记","Unfiled notes")
  return folders.find((folder) => folder.id === entry.previousFolderId)?.name ?? uiText("已恢复","Recovered")
}

function missingFolderMessage(entry: TrashEntry) {
  if (entry.kind === 'temporary') return uiText("原文件夹不可用，将恢复到“已恢复”","The original folder is unavailable. Restores to Recovered.")
  return entry.previousFolderName
    ? uiText(`原文件夹“${entry.previousFolderName}”已被删除，恢复时将重新创建该文件夹`,`The original folder “${entry.previousFolderName}” was deleted and will be recreated on restore`)
    : uiText("原文件夹已被删除，恢复时将放入“已恢复”","The original folder was deleted. Restores to Recovered.")
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return uiText("未知时间","Unknown time")
  return new Intl.DateTimeFormat(UI_LOCALE, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
