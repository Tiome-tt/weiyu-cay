import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { EditorMode, NoteId } from '../../domain/model'
import type { AssetPort, FolderPort, ImageReadPort, LibraryCollapsedPreference, LibraryColumnPreference, LinkPort, LinkRepairReport, SearchPort, SystemPort, TemporaryPort, TemporaryWindowPort, TrashPort } from '../../domain/ports'
import { SplitPane, type SplitPaneSizes } from '../../shared/SplitPane'
import { EditorPane, type EditorPaneHandle } from '../editor/EditorPane'
import { FolderTree } from './FolderTree'
import { NoteList } from './NoteList'
import { useLibrary, type LibraryNotePort } from './useLibrary'
import { TemporaryInbox, type TemporaryInboxHandle } from '../temporary/TemporaryInbox'
import { TrashView } from './TrashView'
import { APP_TAGLINE } from '../../shared/brand'

interface LibraryLayoutProps {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
  assets?: AssetPort & ImageReadPort
  search?: SearchPort
  links?: LinkPort
  temporary?: TemporaryPort
  temporaryWindows?: Pick<TemporaryWindowPort, 'show'>
  trash?: TrashPort
  defaultEditorMode?: EditorMode
  autosaveDelayMs?: number
}

export interface LibraryLayoutHandle {
  prepareStorageMove(): Promise<(() => void) | null>
  prepareExit(): Promise<(() => void) | null>
  refreshAfterRecovery(): Promise<void>
  selectSearchResult(noteId: NoteId): void
  createNote(): void
}

export const LibraryLayout = forwardRef<LibraryLayoutHandle, LibraryLayoutProps>(function LibraryLayout({ notes, folders, system, assets, search, links, temporary, temporaryWindows, trash, defaultEditorMode, autosaveDelayMs }, ref) {
  const library = useLibrary(notes, folders)
  const [activeView, setActiveView] = useState<'library' | 'temporary' | 'trash'>('library')
  const [trashBusy, setTrashBusy] = useState<'delete' | 'undo' | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState(false)
  const [metadataNotice, setMetadataNotice] = useState<string | null>(null)
  const [linkRepairRetry, setLinkRepairRetry] = useState<{ noteId: NoteId; title: string } | null>(null)
  const [linkRepairBusy, setLinkRepairBusy] = useState(false)
  const [deletingNoteId, setDeletingNoteId] = useState<NoteId | null>(null)
  const [trashError, setTrashError] = useState<string | null>(null)
  const [trashFeedback, setTrashFeedback] = useState<string | null>(null)
  const [recentTrashOperationId, setRecentTrashOperationId] = useState<string | null>(null)
  const [columnPreference, setColumnPreference] = useState<LibraryColumnPreference | null>(null)
  const [collapsed, setCollapsed] = useState<LibraryCollapsedPreference>({ folder: false, noteList: false })
  const preferenceRequest = useRef(0)
  const collapsedPreferenceRequest = useRef(0)
  const editorRef = useRef<EditorPaneHandle>(null)
  const temporaryInboxRef = useRef<TemporaryInboxHandle>(null)
  const navigationRequest = useRef(0)
  const trashBusyRef = useRef<'delete' | 'undo' | null>(null)
  const trashMutationRef = useRef(0)
  const storageMoveLockedRef = useRef(false)
  const linkRepairBusyRef = useRef(false)
  const mountedRef = useRef(false)
  const linkCache = useMemo(
    () => new Map(library.notes.map((note) => [note.id, note] as const)),
    [library.notes],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      navigationRequest.current += 1
      trashMutationRef.current += 1
    }
  }, [])

  useEffect(() => {
    setMetadataNotice(null)
    setLinkRepairRetry(null)
  }, [library.activeNoteId])

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
          setCollapsed(value)
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

  const toggleColumn = (column: keyof LibraryCollapsedPreference) => {
    collapsedPreferenceRequest.current += 1
    setCollapsed((current) => {
      const next = { ...current, [column]: !current[column] }
      void system.setWindowPreference('library-collapsed', next).catch(() => undefined)
      return next
    })
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
    createNote: () => {
      void createFormalNote('未命名笔记')
    },
  }))

  async function prepareEditorFlush(): Promise<(() => void) | null> {
      if (storageMoveLockedRef.current) return null
      storageMoveLockedRef.current = true
      const formal = editorRef.current
      const temporaryEditor = temporaryInboxRef.current
      const releases: Array<() => void> = []
      const releaseAll = () => {
        while (releases.length > 0) releases.pop()?.()
        storageMoveLockedRef.current = false
      }
      try {
        if (formal !== null) {
          await formal.beginEditBarrier()
          releases.push(() => formal.endEditBarrier())
        }
        if (temporaryEditor !== null) {
          await temporaryEditor.beginEditBarrier()
          releases.push(() => temporaryEditor.endEditBarrier())
        }
        const formalSaved = (await formal?.flush()) ?? true
        const temporarySaved = (await temporaryEditor?.flush()) ?? true
        if (!formalSaved || !temporarySaved) {
          releaseAll()
          return null
        }
        let released = false
        return () => {
          if (released) return
          released = true
          releaseAll()
        }
      } catch {
        releaseAll()
        return null
      }
  }

  const deleteFormalNote = async (noteId: NoteId, title: string) => {
    if (!mountedRef.current || trash === undefined || trashBusyRef.current !== null) return
    const request = ++trashMutationRef.current
    navigationRequest.current += 1
    const editor = editorRef.current
    const activeEditorExists = activeView === 'library' && editor !== null
    const deletingCurrentDocument = activeView === 'library' && library.activeNoteId === noteId && editor !== null
    let barrierHeld = false
    trashBusyRef.current = 'delete'
    setTrashBusy('delete')
    setDeletingNoteId(noteId)
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
      const result = await trash.trash([noteId])
      if (!mountedRef.current || trashMutationRef.current !== request) return
      const deleted = result.trashed.includes(noteId)
      if (deleted) {
        if (deletingCurrentDocument) barrierHeld = false
        library.clearDeletedNote(noteId)
        setRecentTrashOperationId(result.operationId)
        setTrashFeedback(`“${title}”已移入回收站。`)
      }
      if (result.failed.length > 0) {
        setTrashError(result.failed.map((failure) => failure.message).join('；'))
      } else if (!deleted) {
        setTrashError('笔记未能移入回收站，请重试。')
      }
      if (deleted) await library.refreshNotes()
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

  const createFormalNote = async (title: string) => {
    if (createBusy) return
    setCreateBusy(true)
    setCreateError(false)
    try {
      await navigateAfterSave(() => library.createNote(title))
    } catch {
      setCreateError(true)
    } finally {
      setCreateBusy(false)
    }
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
      <div className="library-collapse-controls" role="toolbar" aria-label="侧栏显示">
        <button
          type="button"
          aria-label={collapsed.folder ? '展开文件夹栏' : '折叠文件夹栏'}
          aria-pressed={collapsed.folder}
          onClick={() => toggleColumn('folder')}
        >
          <span aria-hidden="true">{collapsed.folder ? '▸' : '◂'}</span>
        </button>
        <button
          type="button"
          aria-label={collapsed.noteList ? '展开笔记列表栏' : '折叠笔记列表栏'}
          aria-pressed={collapsed.noteList}
          onClick={() => toggleColumn('noteList')}
        >
          <span aria-hidden="true">{collapsed.noteList ? '▸' : '◂'}</span>
        </button>
      </div>
      <SplitPane
        defaultSizes={[240, 300]}
        minimumSizes={[180, 220, 420]}
        dividerLabels={['调整文件夹栏宽度', '调整笔记列表栏宽度']}
        proportions={columnPreference ? [columnPreference.folder, columnPreference.noteList] : undefined}
        collapsed={[collapsed.folder, collapsed.noteList]}
        onCommit={persistColumns}
      >
      <aside data-testid="folder-pane" className="library-pane library-pane--folders">
        <FolderTree
          folders={library.folders}
          activeId={library.activeFolderId}
          temporaryInboxActive={activeView === 'temporary'}
          trashActive={activeView === 'trash'}
          state={library.folderState}
          onSelect={(folderId) => void navigateAfterSave(() => {
            setActiveView('library')
            library.selectFolder(folderId)
          })}
          onTemporaryInbox={temporary === undefined ? undefined : () => void navigateAfterSave(() => setActiveView('temporary'))}
          onTrash={trash === undefined ? undefined : () => void navigateAfterSave(() => setActiveView('trash'))}
          onCreate={library.createFolder}
          onRename={library.renameFolder}
          onMove={library.moveFolder}
          onDelete={library.deleteFolder}
        />
      </aside>
      <aside data-testid="note-list-pane" className="library-pane library-pane--notes">
        {activeView === 'temporary' ? (
          <section className="note-list" aria-label="临时收集箱导航">
            <header className="library-pane__header library-pane__header--compact">
              <div><span className="library-pane__eyebrow">临时捕捉</span><h2>收集箱</h2></div>
            </header>
            <p className="library-status">在右侧查看、编辑和整理临时捕捉。</p>
          </section>
        ) : activeView === 'trash' ? (
          <section className="note-list" aria-label="回收站导航">
            <header className="library-pane__header library-pane__header--compact">
              <div><span className="library-pane__eyebrow">安全恢复</span><h2>回收站</h2></div>
            </header>
            <p className="library-status">已删除项目默认保留 30 天，可在右侧恢复。</p>
          </section>
        ) : (
          <NoteList
            notes={library.notes}
            activeId={library.activeNoteId}
            state={library.noteListState}
            onSelect={(noteId) => void navigateAfterSave(() => library.selectNote(noteId))}
            onCreate={(title) => void createFormalNote(title)}
            creating={createBusy}
            createError={createError}
            onDelete={trash === undefined ? undefined : (noteId, title) => void deleteFormalNote(noteId, title)}
            deletingId={deletingNoteId}
            deleteError={trashError}
            deleteFeedback={trashFeedback}
            undoAvailable={recentTrashOperationId !== null}
            undoBusy={trashBusy === 'undo'}
            onUndoDelete={() => void undoFormalDelete()}
          />
        )}
      </aside>
      <section data-testid="content-pane" className="library-content" aria-label="笔记内容">
        {activeView === 'temporary' && temporary && <TemporaryInbox ref={temporaryInboxRef} temporary={temporary} folders={library.folders} assets={assets} assetReader={assets} windows={temporaryWindows} external={system} autosaveDelayMs={autosaveDelayMs} />}
        {activeView === 'trash' && trash && (
          <TrashView
            trash={trash}
            folders={library.folders}
            recentOperationId={recentTrashOperationId}
            onLibraryChanged={library.refreshLibrary}
            onUndoCompleted={(operationId) => {
              if (operationId === recentTrashOperationId) setRecentTrashOperationId(null)
            }}
          />
        )}
        {activeView === 'library' && library.documentState === 'loading' && <p className="content-placeholder">正在打开笔记…</p>}
        {activeView === 'library' && library.documentState === 'error' && <p className="content-placeholder content-placeholder--error">无法打开笔记。</p>}
        {activeView === 'library' && library.documentState === 'ready' && library.document === null && (
          <div className="content-placeholder">
            <span aria-hidden="true" className="content-placeholder__leaf">⌁</span>
            <p>{APP_TAGLINE}</p>
            <p>选择一篇笔记开始阅读。</p>
          </div>
        )}
        {activeView === 'library' && library.document && (
          <EditorPane
            key={`${library.document.id}:${library.document.revision}`}
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
            initialMode={defaultEditorMode}
            autosaveDelayMs={autosaveDelayMs}
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
  )
})

function linkRepairNeedsRetry(report: LinkRepairReport) {
  return report.failure !== null || report.failedSourceIds.length > 0
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

function isCollapsedPreference(value: unknown): value is LibraryCollapsedPreference {
  if (typeof value !== 'object' || value === null) return false
  const folder = 'folder' in value ? value.folder : undefined
  const noteList = 'noteList' in value ? value.noteList : undefined
  return typeof folder === 'boolean' && typeof noteList === 'boolean'
}
