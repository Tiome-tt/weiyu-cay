import { contentOutlineMarkdown, type NewNoteFormat } from '../../domain/content'
import { emptyRichDocument } from '../../domain/content'
import { docxToRichDocument, materializeDocumentImages } from '../content/officeConversion'
import { forwardRef, startTransition, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EditorMode, FolderId, NoteId } from '../../domain/model'
import type { AssetPort, FilePort, FolderPort, ImageReadPort, LibraryCollapsedPreference, LibraryColumnPreference, LibraryOutlineCollapsedPreference, LinkPort, LinkRepairReport, SearchPort, StartupGuidePort, SystemPort, TemporaryPort, TemporaryWindowPort, TrashPort } from '../../domain/ports'
import { SplitPane, type SplitPaneSizes } from '../../shared/SplitPane'
import { EditorPane, type EditorPaneHandle } from '../editor/EditorPane'
import type { SaveState } from '../editor/useAutosave'
import { FolderTree } from './FolderTree'
import { NoteList } from './NoteList'
import { useLibrary, type LibraryNotePort } from './useLibrary'
import { TemporaryInbox, type TemporaryInboxHandle } from '../temporary/TemporaryInbox'
import { TrashView } from './TrashView'
import { DirectoryRail } from './DirectoryRail'
import { LibraryRail, type LibraryRailEntry } from './LibraryRail'
import { useResponsiveColumns } from './useResponsiveColumns'
import { Icon } from '../../shared/Icon'
import { CreateNotePopover, type CreateNoteDraft, type CreateNoteStatus } from './CreateNotePopover'
import { MainWindowEmptyState } from './MainWindowEmptyState'
import { NoteOutline, parseNoteHeadings } from './NoteOutline'

interface LibraryLayoutProps {
  files?: FilePort
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
  assets?: AssetPort & ImageReadPort
  search?: SearchPort
  links?: LinkPort
  temporary?: TemporaryPort
  temporaryWindows?: Pick<TemporaryWindowPort, 'show'>
  trash?: TrashPort
  startupGuide?: StartupGuidePort
  defaultEditorMode?: EditorMode
  autosaveDelayMs?: number
  onSaveStateChange?(status: Exclude<SaveState['status'], 'idle'> | 'hidden'): void
  onCreatePopoverOpen?(): void
}

export interface LibraryLayoutHandle {
  prepareStorageMove(signal?: AbortSignal): Promise<(() => void) | null>
  prepareExit(signal?: AbortSignal): Promise<(() => void) | null>
  refreshAfterRecovery(): Promise<void>
  selectSearchResult(noteId: NoteId): void
  createNote(trigger: HTMLButtonElement): void
  openTemporaryInbox(): void
}

export const LibraryLayout = forwardRef<LibraryLayoutHandle, LibraryLayoutProps>(function LibraryLayout({ files, notes, folders, system, assets, search, links, temporary, temporaryWindows, trash, startupGuide, defaultEditorMode, autosaveDelayMs, onSaveStateChange, onCreatePopoverOpen }, ref) {
  const library = useLibrary(notes, folders, startupGuide)
  const [importBusy, setImportBusy] = useState(false)
  const [importNotice, setImportNotice] = useState<{ kind: 'status' | 'alert'; message: string } | null>(null)
  const [activeView, setActiveView] = useState<'library' | 'temporary' | 'trash'>('library')
  const [trashBusy, setTrashBusy] = useState<'delete' | 'undo' | null>(null)
  const [createPopoverOpen, setCreatePopoverOpen] = useState(false)
  const [createOperation, setCreateOperation] = useState<CreateNoteDraft & { status: CreateNoteStatus }>({
    title: '',
    folderId: null,
    tags: '',
    format: 'document',
    status: 'idle',
  })
  const [metadataNotice, setMetadataNotice] = useState<string | null>(null)
  const [linkRepairRetry, setLinkRepairRetry] = useState<{ noteId: NoteId; title: string } | null>(null)
  const [linkRepairBusy, setLinkRepairBusy] = useState(false)
  const [deletingNoteId, setDeletingNoteId] = useState<NoteId | null>(null)
  const [trashError, setTrashError] = useState<string | null>(null)
  const [trashFeedback, setTrashFeedback] = useState<string | null>(null)
  const [recentTrashOperationId, setRecentTrashOperationId] = useState<string | null>(null)
  const [outlineDraft, setOutlineDraft] = useState<{ noteId: NoteId; markdown: string } | null>(null)
  const [pendingEditorAction, setPendingEditorAction] = useState<{ noteId: NoteId; kind: 'word' | 'pdf' } | null>(null)
  const [columnPreference, setColumnPreference] = useState<LibraryColumnPreference | null>(null)
  const manualCollapsedRef = useRef<LibraryCollapsedPreference>({ folder: false, noteList: false })
  const [manualCollapsed, setManualCollapsed] = useState<LibraryCollapsedPreference>(manualCollapsedRef.current)
  const preferenceRequest = useRef(0)
  const collapsedPreferenceRequest = useRef(0)
  const [outlineCollapsedPreference, setOutlineCollapsedPreference] = useState<LibraryOutlineCollapsedPreference>({})
  const outlineCollapsedPreferenceRef = useRef<LibraryOutlineCollapsedPreference>({})
  const outlineCollapsedPreferenceRequest = useRef(0)
  const editorRef = useRef<EditorPaneHandle>(null)
  const createTriggerRef = useRef<HTMLButtonElement | null>(null)
  const createPopoverOpenRef = useRef(false)
  const createOperationRef = useRef(createOperation)
  const createInFlightRef = useRef<Promise<void> | null>(null)
  const createOperationRequest = useRef(0)
  const temporaryInboxRef = useRef<TemporaryInboxHandle>(null)
  const navigationRequest = useRef(0)
  const trashBusyRef = useRef<'delete' | 'undo' | null>(null)
  const trashMutationRef = useRef(0)
  const storageMoveLockedRef = useRef(false)
  const linkRepairBusyRef = useRef(false)
  const mountedRef = useRef(false)
  const columnsRef = useRef<HTMLDivElement>(null)
  const outlineDraftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outlineHeadingSignatureRef = useRef('')
  const activeFolderIdRef = useRef<FolderId | null>(library.activeFolderId)
  const importPathsRef = useRef<(paths: string[], position?: { x: number; y: number }) => void>(() => undefined)
  const metadataNoticeTargetRef = useRef<NoteId | undefined>(undefined)
  activeFolderIdRef.current = library.activeFolderId
  const responsiveCollapsed = useResponsiveColumns(columnsRef)
  const collapsed: LibraryCollapsedPreference = {
    folder: manualCollapsed.folder || responsiveCollapsed.folder,
    noteList: manualCollapsed.noteList || responsiveCollapsed.noteList || (activeView === 'library' && ['file', 'text'].includes(library.document?.content?.type ?? '')),
  }
  const linkCache = useMemo(
    () => new Map(library.notes.map((note) => [note.id, note] as const)),
    [library.notes],
  )
  const reportEditorSaveState = useCallback(
    (status: SaveState['status']) => onSaveStateChange?.(status === 'idle' ? 'hidden' : status),
    [onSaveStateChange],
  )
  const reportOutlineDraft = useCallback((noteId: NoteId, markdown: string) => {
    if (outlineDraftTimerRef.current !== null) clearTimeout(outlineDraftTimerRef.current)
    outlineDraftTimerRef.current = setTimeout(() => {
      outlineDraftTimerRef.current = null
      const nextSignature = outlineHeadingSignature(markdown)
      if (outlineHeadingSignatureRef.current === nextSignature) return
      outlineHeadingSignatureRef.current = nextSignature
      startTransition(() => {
        setOutlineDraft((current) => current?.noteId === noteId && current.markdown === markdown
          ? current
          : { noteId, markdown })
      })
    }, 100)
  }, [])
  const outlineDocument = library.document
  const outlineDocumentMarkdown = useMemo(() => contentOutlineMarkdown(outlineDocument ?? {}), [outlineDocument])
  const outlineMarkdown = outlineDraft !== null && outlineDraft.noteId === outlineDocument?.id
    ? outlineDraft.markdown
    : outlineDocumentMarkdown
  const outlineNoteId = outlineDocument?.id

  useEffect(() => {
    if (activeView !== 'library' || library.documentState !== 'ready' || library.document === null) {
      onSaveStateChange?.('hidden')
    }
  }, [activeView, library.document, library.documentState, onSaveStateChange])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      navigationRequest.current += 1
      trashMutationRef.current += 1
      createOperationRequest.current += 1
      if (outlineDraftTimerRef.current !== null) clearTimeout(outlineDraftTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (metadataNoticeTargetRef.current === library.activeNoteId) {
      metadataNoticeTargetRef.current = undefined
      return
    }
    setMetadataNotice(null)
    setLinkRepairRetry(null)
  }, [library.activeNoteId])

  useEffect(() => {
    outlineHeadingSignatureRef.current = outlineHeadingSignature(contentOutlineMarkdown(library.document ?? {}))
  }, [library.document?.id])

  useEffect(() => {
    const pending = pendingEditorAction
    if (pending === null || library.documentState !== 'ready' || library.document?.id !== pending.noteId) return
    setPendingEditorAction(null)
    void editorRef.current?.exportDocument(pending.kind).then((success) => {
      if (!success && mountedRef.current) setMetadataNotice(pending.kind === 'word' ? '此笔记无法导出为 Word。' : '导出未完成，原笔记已保留。')
    }).catch(() => {
      if (mountedRef.current) setMetadataNotice('导出未完成，原笔记已保留。')
    })
  }, [library.document, library.documentState, pendingEditorAction])

  useEffect(() => {
    const request = ++preferenceRequest.current
    let current = true
    void system
      .getWindowPreference('library-columns')
      .then((value) => {
        if (current && preferenceRequest.current === request && isColumnPreference(value)) {
          setColumnPreference(value)
        }
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [system])

  useEffect(() => {
    const request = ++collapsedPreferenceRequest.current
    let current = true
    void system
      .getWindowPreference('library-collapsed')
      .then((value) => {
        if (current && collapsedPreferenceRequest.current === request && isCollapsedPreference(value)) {
          manualCollapsedRef.current = value
          setManualCollapsed(value)
        }
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [system])

  useEffect(() => {
    const request = ++outlineCollapsedPreferenceRequest.current
    let current = true
    void system
      .getWindowPreference('library-outline-collapsed')
      .then((value) => {
        if (current && outlineCollapsedPreferenceRequest.current === request && isOutlineCollapsedPreference(value)) {
          outlineCollapsedPreferenceRef.current = value
          setOutlineCollapsedPreference(value)
        }
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [system])

  const persistColumns = (sizes: SplitPaneSizes, containerWidth: number) => {
    preferenceRequest.current += 1
    const total = containerWidth > 0 ? containerWidth : window.innerWidth
    const value = {
      folder: sizes[0] / total,
      noteList: sizes[1] / total,
    }
    setColumnPreference(value)
    void system.setWindowPreference('library-columns', value).catch(() => undefined)
  }

  const setColumnCollapsed = (column: keyof LibraryCollapsedPreference, value: boolean) => {
    collapsedPreferenceRequest.current += 1
    const next = { ...manualCollapsedRef.current, [column]: value }
    manualCollapsedRef.current = next
    setManualCollapsed(next)
    void system.setWindowPreference('library-collapsed', next).catch(() => undefined)
  }

  const setOutlineCollapsed = (noteId: NoteId, keys: string[]) => {
    outlineCollapsedPreferenceRequest.current += 1
    const next = {
      ...outlineCollapsedPreferenceRef.current,
      [noteId]: [...new Set(keys)],
    }
    outlineCollapsedPreferenceRef.current = next
    setOutlineCollapsedPreference(next)
    void system.setWindowPreference('library-outline-collapsed', next).catch(() => undefined)
  }

  const activeRailEntry: LibraryRailEntry = activeView === 'temporary'
    ? 'temporary'
      : activeView === 'trash'
      ? 'trash'
      : library.activeFolderId === null ? 'unfiled' : 'folder'

  const updateCreateOperation = (
    update: (current: CreateNoteDraft & { status: CreateNoteStatus }) => CreateNoteDraft & { status: CreateNoteStatus },
  ) => {
    const next = update(createOperationRef.current)
    createOperationRef.current = next
    setCreateOperation(next)
  }

  const closeCreatePopover = () => {
    createPopoverOpenRef.current = false
    setCreatePopoverOpen(false)
  }

  const navigateAfterSave = async <Result,>(navigate: () => Result | Promise<Result>): Promise<Result | null> => {
    if (trashBusyRef.current === 'delete' || storageMoveLockedRef.current) return null
    const request = ++navigationRequest.current
    const activeEditor = activeView === 'temporary' ? temporaryInboxRef.current : editorRef.current
    let barrierHeld = false
    try {
      if (activeEditor !== null) {
        barrierHeld = true
        await activeEditor.beginEditBarrier()
      }
      const canNavigate = (await activeEditor?.flush()) ?? true
      if (mountedRef.current && canNavigate && request === navigationRequest.current) return await navigate()
      return null
    } finally {
      if (barrierHeld) activeEditor?.endEditBarrier()
    }
  }

  const retryLinkRepair = async () => {
    const pending = linkRepairRetry
    if (pending === null || linkRepairBusyRef.current) return
    linkRepairBusyRef.current = true
    setLinkRepairBusy(true)
    try {
      const result = await navigateAfterSave(() => library.renameNote(pending.noteId, pending.title))
      if (result === null) throw new Error('link repair retry was blocked')
      if (linkRepairNeedsRetry(result.linkRepair)) {
        setLinkRepairRetry({ noteId: result.document.id, title: result.document.title })
        setMetadataNotice('标题已提交；链接修复仍未完成，可再次重试。')
      } else {
        setLinkRepairRetry(null)
        setMetadataNotice(`链接修复已完成；已刷新 ${result.linkRepair.updated} 篇引用笔记。`)
      }
    } catch {
      setMetadataNotice('标题保持已提交状态；链接修复重试失败，可再次重试。')
    } finally {
      linkRepairBusyRef.current = false
      setLinkRepairBusy(false)
    }
  }

  const openCreatePopover = (trigger: HTMLButtonElement | null, folderId: FolderId | null = library.activeFolderId ?? library.document?.folderId ?? library.folders[0]?.id ?? null) => {
    onCreatePopoverOpen?.()
    createTriggerRef.current = trigger
    if (createOperationRef.current.status === 'idle' && createOperationRef.current.title.trim().length === 0) {
      updateCreateOperation((current) => ({ ...current, folderId }))
    }
    createPopoverOpenRef.current = true
    setCreatePopoverOpen(true)
  }

  useImperativeHandle(ref, () => ({
    refreshAfterRecovery: async () => {
      await Promise.all([
        library.refreshLibrary(),
        temporaryInboxRef.current?.refresh() ?? Promise.resolve(),
      ])
    },
    prepareStorageMove: prepareEditorFlush,
    prepareExit: prepareEditorFlush,
    selectSearchResult: (noteId) => {
      void navigateAfterSave(() => {
        setActiveView('library')
        library.selectNote(noteId)
      })
    },
    createNote: (trigger) => openCreatePopover(trigger),
    openTemporaryInbox: () => {
      if (temporary !== undefined) void navigateAfterSave(() => setActiveView('temporary'))
    },
  }))

  async function prepareEditorFlush(signal?: AbortSignal): Promise<(() => void) | null> {
      if (storageMoveLockedRef.current) return null
      storageMoveLockedRef.current = true
      const formal = editorRef.current
      const temporaryEditor = temporaryInboxRef.current
      const releases: Array<() => void> = []
      let released = false
      const releaseAll = () => {
        if (released) return
        released = true
        while (releases.length > 0) releases.pop()?.()
        storageMoveLockedRef.current = false
      }
      const cancelled = () => signal?.aborted === true
      signal?.addEventListener('abort', releaseAll, { once: true })
      try {
        if (cancelled()) return null
        if (formal !== null) {
          releases.push(() => formal.endEditBarrier())
          await formal.beginEditBarrier()
          if (cancelled()) return null
        }
        if (temporaryEditor !== null) {
          releases.push(() => temporaryEditor.endEditBarrier())
          await temporaryEditor.beginEditBarrier()
          if (cancelled()) return null
        }
        const formalSaved = (await formal?.flush()) ?? true
        if (cancelled()) return null
        const temporarySaved = (await temporaryEditor?.flush()) ?? true
        if (cancelled() || !formalSaved || !temporarySaved) {
          releaseAll()
          return null
        }
        return () => {
          signal?.removeEventListener('abort', releaseAll)
          releaseAll()
        }
      } catch {
        releaseAll()
        return null
      }
  }

  const deleteFormalNotes = async (entries: Array<{ id: NoteId; title: string }>) => {
    if (!mountedRef.current || trash === undefined || trashBusyRef.current !== null || entries.length === 0) return
    const noteIds = entries.map((entry) => entry.id)
    const request = ++trashMutationRef.current
    navigationRequest.current += 1
    const editor = editorRef.current
    const activeEditorExists = activeView === 'library' && editor !== null
    const activeNoteId = library.activeNoteId
    const deletingCurrentDocument = activeView === 'library' && activeNoteId !== null && noteIds.includes(activeNoteId) && editor !== null
    let barrierHeld = false
    trashBusyRef.current = 'delete'
    setTrashBusy('delete')
    setDeletingNoteId(noteIds[0] ?? null)
    setTrashError(null)
    setTrashFeedback(null)
    try {
      if (activeEditorExists) {
        barrierHeld = true
        await editor.beginEditBarrier()
      }
      if (!mountedRef.current || trashMutationRef.current !== request) return
      const saved = (await editor?.flush()) ?? true
      if (!mountedRef.current || trashMutationRef.current !== request) return
      if (!saved) {
        setTrashError('请先解决保存错误，再删除笔记。')
        return
      }
      const result = await trash.trash(noteIds)
      if (!mountedRef.current || trashMutationRef.current !== request) return
      const deletedIds = result.trashed.filter((id) => noteIds.includes(id))
      if (deletedIds.length > 0) {
        if (deletingCurrentDocument && activeNoteId !== null && deletedIds.includes(activeNoteId)) barrierHeld = false
        deletedIds.forEach((id) => library.clearDeletedNote(id))
        setRecentTrashOperationId(result.operationId)
        const deletedTitle = entries.find((entry) => entry.id === deletedIds[0])?.title ?? entries[0]?.title ?? ''
        setTrashFeedback(deletedIds.length === 1 ? `“${deletedTitle}”已移入回收站。` : `${deletedIds.length} 项已移入回收站。`)
      }
      if (result.failed.length > 0) {
        setTrashError(result.failed.map((failure) => failure.message).join('；'))
      } else if (deletedIds.length === 0) {
        setTrashError('笔记未能移入回收站，请重试。')
      }
      if (deletedIds.length > 0) await library.refreshNotes()
    } catch {
      if (mountedRef.current && trashMutationRef.current === request) setTrashError('无法删除笔记，请重试。')
    } finally {
      if (barrierHeld) editor?.endEditBarrier()
      trashBusyRef.current = null
      if (mountedRef.current && trashMutationRef.current === request) {
        setTrashBusy(null)
        setDeletingNoteId(null)
      }
    }
  }

  const deleteFormalNote = (noteId: NoteId, title: string) => deleteFormalNotes([{ id: noteId, title }])

  const createFormalNote = (title: string, folderId: FolderId | null, tags: string[], format: NewNoteFormat) => {
    if (createInFlightRef.current !== null) return
    const request = ++createOperationRequest.current
    updateCreateOperation((current) => ({ ...current, status: 'pending' }))
    const operation = (async () => {
      try {
        const result = await navigateAfterSave(() => library.createNote(title, folderId, format))
        if (result === null) throw new Error('create was blocked by an unsaved editor')
        if (tags.length > 0 && search !== undefined) {
          await search.updateTags(result.id, tags)
          library.selectNote(result.id)
        }
        if (!mountedRef.current || createOperationRequest.current !== request) return
        updateCreateOperation(() => ({ title: '', folderId, tags: '', format: 'document', status: 'idle' }))
        if (createPopoverOpenRef.current) {
          closeCreatePopover()
          createTriggerRef.current?.focus()
        }
      } catch {
        if (mountedRef.current && createOperationRequest.current === request) {
          updateCreateOperation((current) => ({ ...current, status: 'error' }))
        }
      } finally {
        if (createOperationRequest.current === request) createInFlightRef.current = null
      }
    })()
    createInFlightRef.current = operation
  }

  const startImport = (providedPaths?: string[], destination = activeFolderIdRef.current) => {
    if (!files || importBusy || createInFlightRef.current || storageMoveLockedRef.current || destination === null) return
    const folderId = destination
    setImportBusy(true)
    setImportNotice(null)
    const operation = (async () => {
      try {
        const paths = providedPaths ?? await files.chooseFiles()
        if (paths.length === 0) return
        const result = await files.importFiles({ paths, folderId })
        await library.refreshNotes(folderId, folderId !== activeFolderIdRef.current)
        if (mountedRef.current) {
          setImportNotice({
            kind: result.failed.length > 0 ? 'alert' : 'status',
            message: '已导入 ' + result.imported.length + ' 项' + (result.failed.length ? '；失败：' + result.failed.map(failure => failure.name + '：' + failure.message).join('；') : '。'),
          })
        }
      } catch {
        if (mountedRef.current) setImportNotice({ kind: 'alert', message: '导入失败，原文件已保留。' })
      } finally {
        createInFlightRef.current = null
        if (mountedRef.current) setImportBusy(false)
      }
    })()
    createInFlightRef.current = operation
  }
  importPathsRef.current = (paths, position) => {
    const folderId = position === undefined
      ? activeFolderIdRef.current
      : (document.elementFromPoint(position.x, position.y)?.closest<HTMLElement>('[data-folder-id]')?.dataset.folderId as FolderId | undefined) ?? activeFolderIdRef.current
    if (folderId !== null && folderId !== undefined) startImport(paths, folderId)
  }

  useEffect(() => {
    if (files?.onDroppedFiles === undefined) return
    let active = true
    let unlisten: (() => void) | undefined
    void files.onDroppedFiles((paths, position) => {
      if (active && paths.length > 0) importPathsRef.current(paths, position)
    }).then((stop) => {
      if (active) unlisten = stop
      else stop()
    }).catch(() => {
      if (active) setImportNotice({ kind: 'alert', message: '暂时无法接收拖入文件，请使用“导入文件”。' })
    })
    return () => {
      active = false
      unlisten?.()
    }
  }, [files])

  const requestNoteExport = (note: { id: NoteId; folderId: FolderId | null }, kind: 'word' | 'pdf') => {
    const reuseActiveNote = activeView === 'library'
      && library.activeNoteId === note.id
      && activeFolderIdRef.current === note.folderId
    void navigateAfterSave(() => {
      setActiveView('library')
      if (note.folderId !== activeFolderIdRef.current) library.selectFolder(note.folderId)
      if (shouldSelectNoteForExport(reuseActiveNote ? note.id : null, note.id)) library.selectNote(note.id)
      return true
    }).then((result) => {
      if (result === null) {
        setPendingEditorAction(null)
        return
      }
      setPendingEditorAction({ noteId: note.id, kind })
    }).catch(() => setPendingEditorAction(null))
  }
  const convertWordFile = async (source: Awaited<ReturnType<typeof notes.loadNote>>, bytes: Uint8Array) => {
    if (source.content?.type !== 'file' || !/\.docx?$/i.test(source.content.file.originalName)) throw new Error('仅支持 Word 文档转换。')
    if (trash === undefined) throw new Error('回收站不可用，无法自动移除原文件。')
    const title = source.title.replace(/\.docx?$/i, '').trim() || source.title
    const copy = await notes.createNote({ folderId: source.folderId, title: `${title}（可编辑）`, format: 'document' })
    if (copy.id === source.id || copy.content?.type !== 'document') throw new Error('未创建独立文档。')
    try {
      const converted = bytes.byteLength === 0
        ? emptyRichDocument()
        : await docxToRichDocument(bytes)
      const document = await materializeDocumentImages(converted, copy.id, assets)
      await notes.saveNote({
        ...copy,
        tags: [...source.tags],
        markdown: '',
        content: { type: 'document', document },
      })
    } catch (cause) {
      try { await trash.trash([copy.id]) } catch { /* keep the original file reachable when cleanup is unavailable */ }
      if (cause instanceof Error && cause.message.startsWith('Word 文档中的图片')) throw cause
      throw new Error('无法解析此 Word 文件，请确认它是完整的 .docx 文件后重试。')
    }
    const removed = await trash.trash([source.id])
    if (!removed.trashed.includes(source.id)) {
      try { await trash.trash([copy.id]) } catch { /* preserve the converted copy if rollback is unavailable */ }
      throw new Error(removed.failed[0]?.message ?? '原 Word 文件未能移入回收站，转换已取消。')
    }
    library.clearDeletedNote(source.id)
    await library.refreshNotes(copy.folderId, copy.folderId !== activeFolderIdRef.current)
    setActiveView('library')
    if (copy.folderId !== activeFolderIdRef.current) library.selectFolder(copy.folderId)
    metadataNoticeTargetRef.current = copy.id
    library.selectNote(copy.id)
    setMetadataNotice('Word 已转换为可编辑文档，原文件已移入回收站。')
  }
  const renderFolderNotes = (folderId: FolderId | null): ReactNode | undefined => {
    const folderNotes = library.notesByFolder[folderId ?? '__unfiled__']
    const loadFailed = library.folderNoteErrors[folderId ?? '__unfiled__'] === true
    if (folderId === null && !loadFailed && library.noteListState === 'ready' && library.activeNoteId === null && trashFeedback === null && recentTrashOperationId === null && (folderNotes === undefined || folderNotes.length === 0)) return undefined
    if (folderNotes === undefined && folderId !== library.activeFolderId && !loadFailed) return undefined
    const isActiveFolder = folderId === library.activeFolderId
    return <NoteList
      notes={folderNotes ?? (isActiveFolder ? library.notes : [])}
      activeId={library.activeNoteId}
      state={isActiveFolder ? library.noteListState : loadFailed && folderNotes === undefined ? 'error' : 'ready'}
      onSelect={(noteId) => void navigateAfterSave(() => {
        if (folderId !== library.activeFolderId) library.selectFolder(folderId)
        library.selectNote(noteId)
      })}
      onDelete={trash === undefined ? undefined : (noteId, title) => void deleteFormalNote(noteId, title)}
      onDeleteSelection={trash === undefined ? undefined : (entries) => void deleteFormalNotes(entries)}
      deletingId={deletingNoteId}
      deleteError={isActiveFolder ? trashError : null}
      deleteFeedback={isActiveFolder ? trashFeedback : null}
      undoAvailable={isActiveFolder && recentTrashOperationId !== null}
      undoBusy={trashBusy === 'undo'}
      onUndoDelete={() => void undoFormalDelete()}
      onDismissFeedback={() => setTrashFeedback(null)}
      folderId={folderId}
      folders={library.folders}
      showEmptyState={folderId !== null}
      onReorder={library.reorderNotes}
      onMoveToFolder={async (noteId, targetFolderId) => { await navigateAfterSave(() => library.moveNote(noteId, targetFolderId)) }}
      onMoveSelection={async (noteIds, targetFolderId) => {
        const result = await navigateAfterSave(async () => {
          for (const noteId of noteIds) await library.moveNote(noteId, targetFolderId)
        })
        if (result === null) throw new Error('move was blocked by an unsaved editor')
        setMetadataNotice(`${noteIds.length} 项已移动。`)
      }}
      onExport={requestNoteExport}
    />
  }

  const undoFormalDelete = async () => {
    if (!mountedRef.current || trash === undefined || recentTrashOperationId === null || trashBusyRef.current !== null) return
    const request = ++trashMutationRef.current
    const operationId = recentTrashOperationId
    trashBusyRef.current = 'undo'
    setTrashBusy('undo')
    setTrashError(null)
    try {
      const result = await trash.undo(operationId)
      if (!mountedRef.current || trashMutationRef.current !== request) return
      await library.refreshLibrary()
      if (!mountedRef.current || trashMutationRef.current !== request) return
      if (result.restored.length > 0) setTrashFeedback(`已撤销删除，恢复 ${result.restored.length} 项。`)
      if (result.failed.length > 0) {
        setTrashError(result.failed.map((failure) => failure.message).join('；'))
      } else {
        setRecentTrashOperationId(null)
      }
    } catch {
      if (mountedRef.current && trashMutationRef.current === request) setTrashError('无法撤销删除，请重试。')
    } finally {
      trashBusyRef.current = null
      if (mountedRef.current && trashMutationRef.current === request) setTrashBusy(null)
    }
  }

  return (
    <div className="library-shell">
      {!createPopoverOpen && createOperation.status === 'pending' && (
        <p className="sr-only" role="status">正在创建“{createOperation.title.trim()}”…</p>
      )}
      {!createPopoverOpen && createOperation.status === 'error' && (
        <p className="sr-only" role="alert">
          无法新建“{createOperation.title.trim()}”。请重新打开“新建笔记”重试。
        </p>
      )}
      {createPopoverOpen && (
        <CreateNotePopover
          folders={library.folders}
          draft={{ title: createOperation.title, folderId: createOperation.folderId, tags: createOperation.tags, format: createOperation.format }}
          status={createOperation.status}
          triggerRef={createTriggerRef}
          onDraftChange={(draft) => updateCreateOperation((current) => (
            current.status === 'pending' ? current : { ...draft, status: 'idle' }
          ))}
          onCreate={createFormalNote}
          onClose={closeCreatePopover}
        />
      )}
      <div ref={columnsRef} className="library-columns">
      {collapsed.folder && (
        <LibraryRail
          activeEntry={activeRailEntry}
          activeFolderId={library.activeFolderId}
          starredFolders={library.folders.filter((folder) => folder.starred === true).sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))}
          onUnfiled={() => {
            if (activeRailEntry === 'unfiled') return
            void navigateAfterSave(() => {
              setActiveView('library')
              library.selectFolder(null)
            })
          }}
          onTemporary={temporary === undefined ? undefined : () => void navigateAfterSave(() => setActiveView('temporary'))}
          onTrash={trash === undefined ? undefined : () => void navigateAfterSave(() => setActiveView('trash'))}
          onFolder={(folderId) => void navigateAfterSave(() => {
            setActiveView('library')
            library.selectFolder(folderId)
          })}
          onMoreFolders={() => setColumnCollapsed('folder', false)}
          onExpand={() => setColumnCollapsed('folder', false)}
        />
      )}
      <SplitPane
        defaultSizes={[240, 190]}
        minimumSizes={[180, 160, 420]}
        dividerLabels={['调整文件夹栏宽度', '调整笔记列表栏宽度']}
        proportions={columnPreference ? [columnPreference.folder, columnPreference.noteList] : undefined}
        collapsed={[collapsed.folder, collapsed.noteList]}
        collapsedSecondRail={<DirectoryRail onExpand={() => setColumnCollapsed('noteList', false)} />}
        onCommit={persistColumns}
      >
      <aside data-testid="folder-pane" className="library-pane library-pane--folders">
        <div className="library-folder-pane-stack">
        <FolderTree
          folders={library.folders}
          activeId={activeView === 'library' ? library.activeFolderId : null}
          showUnfiled={false}
          temporaryInboxActive={activeView === 'temporary'}
          trashActive={activeView === 'trash'}
          state={library.folderState}
          onCollapse={() => setColumnCollapsed('folder', true)}
          onSelect={(folderId) => void navigateAfterSave(() => {
            setActiveView('library')
            library.selectFolder(folderId)
          })}
          onTemporaryInbox={temporary === undefined ? undefined : () => void navigateAfterSave(() => setActiveView('temporary'))}
          onTrash={trash === undefined ? undefined : () => void navigateAfterSave(() => setActiveView('trash'))}
          onCreate={library.createFolder}
          onRename={library.renameFolder}
          onMove={library.moveFolder}
          onReorder={library.reorderFolders}
          onDelete={async (id) => {
            const operationId = await navigateAfterSave(() => library.deleteFolder(id))
            if (typeof operationId === 'string' && trash !== undefined) {
              setRecentTrashOperationId(operationId)
              setTrashFeedback('文件夹已移入回收站。')
            }
          }}
          onCreateNote={(folderId) => openCreatePopover(null, folderId)}
          onImportFiles={files === undefined ? undefined : (folderId) => startImport(undefined, folderId)}
          onToggleStar={library.toggleFolderStar}
          onMoveNote={async (noteId, folderId) => {
            await navigateAfterSave(() => library.moveNote(noteId, folderId))
          }}
          folderContents={activeView === 'library' ? renderFolderNotes : undefined}
        />
        {importNotice && <p className={`library-status${importNotice.kind === 'alert' ? ' library-status--error' : ''}`} role={importNotice.kind}>{importNotice.message}</p>}
        </div>
      </aside>
      <aside data-testid="note-list-pane" className="library-pane library-pane--notes">
        {activeView === 'temporary' ? (
          <section className="note-list" aria-label="临时便笺导航">
            <header className="library-pane__header library-pane__header--compact">
              <div><span className="library-pane__eyebrow">临时捕捉</span><h2>临时便笺</h2></div>
              <button className="icon-button" type="button" aria-label="折叠目录" onClick={() => setColumnCollapsed('noteList', true)}><Icon name="collapse" size={18} /></button>
            </header>
            <p className="library-status">在右侧查看、编辑和整理临时捕捉。</p>
          </section>
        ) : activeView === 'trash' ? (
          <section className="note-list" aria-label="回收站导航">
            <header className="library-pane__header library-pane__header--compact">
              <div><span className="library-pane__eyebrow">安全恢复</span><h2>回收站</h2></div>
              <button className="icon-button" type="button" aria-label="折叠目录" onClick={() => setColumnCollapsed('noteList', true)}><Icon name="collapse" size={18} /></button>
            </header>
            <p className="library-status">已删除项目默认保留 30 天，可在右侧恢复。</p>
          </section>
        ) : (
          <NoteOutline key={outlineNoteId ?? 'empty'} markdown={outlineMarkdown} collapsedKeys={outlineNoteId ? outlineCollapsedPreference[outlineNoteId] : undefined} onCollapsedKeysChange={outlineNoteId ? (keys) => setOutlineCollapsed(outlineNoteId, keys) : undefined} onNavigate={(line, headingIndex) => editorRef.current?.navigateToHeading(line, headingIndex)} onCollapse={() => setColumnCollapsed('noteList', true)} />
        )}
      </aside>
      <section data-testid="content-pane" className="library-content" aria-label="笔记内容">
        {activeView === 'temporary' && temporary && <TemporaryInbox ref={temporaryInboxRef} temporary={temporary} folders={library.folders} assets={assets} assetReader={assets} windows={temporaryWindows} external={system} autosaveDelayMs={autosaveDelayMs} onConversionComplete={async (noteId, folderId) => {
          await library.refreshLibrary()
          setActiveView('library')
          library.selectFolder(folderId)
          library.selectNote(noteId)
        }} />}
        {activeView === 'trash' && trash && (
          <TrashView
            trash={trash}
            folders={library.folders}
            onLibraryChanged={library.refreshLibrary}
          />
        )}
        {activeView === 'library' && library.documentState === 'loading' && <p className="content-placeholder">正在打开笔记…</p>}
        {activeView === 'library' && library.documentState === 'error' && <p className="content-placeholder content-placeholder--error">无法打开笔记。</p>}
        {activeView === 'library' && library.documentState === 'ready' && library.document === null && (
          <MainWindowEmptyState onCreateNote={openCreatePopover} />
        )}
        {activeView === 'library' && library.document && (
          <EditorPane
            files={files}
            key={library.document.id}
            ref={editorRef}
            document={library.document}
            notes={notes}
            assets={assets}
            assetReader={assets}
            search={search}
            links={links}
            linkCache={linkCache}
            onNavigateNote={async (noteId) => { await navigateAfterSave(() => library.selectNote(noteId)) }}
            folders={library.folders}
            onRenameNote={async (title) => {
              const result = await navigateAfterSave(() => library.renameNote(library.document!.id, title))
              if (result === null) throw new Error('rename was blocked by an unsaved editor')
              const retryRequired = linkRepairNeedsRetry(result.linkRepair)
              setLinkRepairRetry(retryRequired ? { noteId: result.document.id, title: result.document.title } : null)
              setMetadataNotice(retryRequired
                ? '标题已提交；链接修复未完成，可安全重试。'
                : `标题已更新；已刷新 ${result.linkRepair.updated} 个引用标签。`)
              return result
            }}
            onMoveNote={async (folderId) => {
              const result = await navigateAfterSave(() => library.moveNote(library.document!.id, folderId))
              if (result === null) throw new Error('move was blocked by an unsaved editor')
              setMetadataNotice('笔记已移动。')
              return result
            }}
            external={system}
            onDocumentAdopt={library.adoptDocument}
            onConvertFileToDocument={convertWordFile}
            initialMode={defaultEditorMode}
            autosaveDelayMs={autosaveDelayMs}
            onSaveStateChange={reportEditorSaveState}
            onDraftChange={(markdown) => reportOutlineDraft(library.document!.id, markdown)}
          />
        )}
        {activeView === 'library' && metadataNotice && <p className="editor-metadata-status" role="status">{metadataNotice}</p>}
        {activeView === 'library' && linkRepairRetry && (
          <button type="button" disabled={linkRepairBusy} onClick={() => void retryLinkRepair()}>
            重试链接修复
          </button>
        )}
      </section>
      </SplitPane>
      </div>
    </div>
  )
})

export function shouldSelectNoteForExport(activeNoteId: NoteId | null, targetNoteId: NoteId): boolean {
  return activeNoteId !== targetNoteId
}

function linkRepairNeedsRetry(report: LinkRepairReport) {
  return report.failure !== null || report.failedSourceIds.length > 0
}

export function outlineHeadingSignature(markdown: string) {
  return parseNoteHeadings(markdown)
    .map((heading) => `${heading.line}:${heading.level}:${heading.text}`)
    .join('|')
}

function isColumnPreference(value: unknown): value is LibraryColumnPreference {
  if (typeof value !== 'object' || value === null) return false
  const folder = 'folder' in value ? value.folder : undefined
  const noteList = 'noteList' in value ? value.noteList : undefined
  return (
    typeof folder === 'number' &&
    Number.isFinite(folder) &&
    folder > 0 &&
    folder < 1 &&
    typeof noteList === 'number' &&
    Number.isFinite(noteList) &&
    noteList > 0 &&
    noteList < 1 &&
    folder + noteList < 1
  )
}

function isOutlineCollapsedPreference(value: unknown): value is LibraryOutlineCollapsedPreference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((keys) => Array.isArray(keys) && keys.every((key) => typeof key === 'string'))
}

function isCollapsedPreference(value: unknown): value is LibraryCollapsedPreference {
  if (typeof value !== 'object' || value === null) return false
  const folder = 'folder' in value ? value.folder : undefined
  const noteList = 'noteList' in value ? value.noteList : undefined
  return typeof folder === 'boolean' && typeof noteList === 'boolean'
}
