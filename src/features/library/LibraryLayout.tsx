import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssetPort, FolderPort, LibraryColumnPreference, LinkPort, SearchPort, SystemPort, TemporaryPort, TrashPort } from '../../domain/ports'
import { SplitPane, type SplitPaneSizes } from '../../shared/SplitPane'
import { EditorPane, type EditorPaneHandle } from '../editor/EditorPane'
import { SearchBox } from '../search/SearchBox'
import { FolderTree } from './FolderTree'
import { NoteList } from './NoteList'
import { useLibrary, type LibraryNotePort } from './useLibrary'
import { TemporaryInbox, type TemporaryInboxHandle } from '../temporary/TemporaryInbox'
import { TrashView } from './TrashView'

interface LibraryLayoutProps {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
  assets?: AssetPort
  search?: SearchPort
  links?: LinkPort
  temporary?: TemporaryPort
  trash?: TrashPort
}

export function LibraryLayout({ notes, folders, system, assets, search, links, temporary, trash }: LibraryLayoutProps) {
  const library = useLibrary(notes, folders)
  const [activeView, setActiveView] = useState<'library' | 'temporary' | 'trash'>('library')
  const [columnPreference, setColumnPreference] = useState<LibraryColumnPreference | null>(null)
  const preferenceRequest = useRef(0)
  const editorRef = useRef<EditorPaneHandle>(null)
  const temporaryInboxRef = useRef<TemporaryInboxHandle>(null)
  const navigationRequest = useRef(0)
  const linkCache = useMemo(
    () => new Map(library.notes.map((note) => [note.id, note] as const)),
    [library.notes],
  )

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

  const navigateAfterSave = async (navigate: () => void) => {
    const request = ++navigationRequest.current
    const activeEditor = activeView === 'temporary' ? temporaryInboxRef.current : editorRef.current
    const canNavigate = (await activeEditor?.flush()) ?? true
    if (canNavigate && request === navigationRequest.current) navigate()
  }

  return (
    <div className="library-shell">
      {search && <SearchBox search={search} onSelect={(noteId) => void navigateAfterSave(() => library.selectNote(noteId))} />}
      <SplitPane
      defaultSizes={[240, 300]}
      minimumSizes={[180, 220, 420]}
      dividerLabels={['调整文件夹栏宽度', '调整笔记列表栏宽度']}
      proportions={columnPreference ? [columnPreference.folder, columnPreference.noteList] : undefined}
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
          />
        )}
      </aside>
      <section data-testid="content-pane" className="library-content" aria-label="笔记内容">
        {activeView === 'temporary' && temporary && <TemporaryInbox ref={temporaryInboxRef} temporary={temporary} folders={library.folders} assets={assets} />}
        {activeView === 'trash' && trash && <TrashView trash={trash} folders={library.folders} />}
        {activeView === 'library' && library.documentState === 'loading' && <p className="content-placeholder">正在打开笔记…</p>}
        {activeView === 'library' && library.documentState === 'error' && <p className="content-placeholder content-placeholder--error">无法打开笔记。</p>}
        {activeView === 'library' && library.documentState === 'ready' && library.document === null && (
          <div className="content-placeholder">
            <span aria-hidden="true" className="content-placeholder__leaf">⌁</span>
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
            search={search}
            links={links}
            linkCache={linkCache}
            onNavigateNote={(noteId) => navigateAfterSave(() => library.selectNote(noteId))}
            onDocumentAdopt={library.adoptDocument}
          />
        )}
      </section>
      </SplitPane>
    </div>
  )
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
