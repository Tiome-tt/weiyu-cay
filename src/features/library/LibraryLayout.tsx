import { useEffect, useRef, useState } from 'react'
import type { AssetPort, FolderPort, LibraryColumnPreference, SearchPort, SystemPort } from '../../domain/ports'
import { SplitPane, type SplitPaneSizes } from '../../shared/SplitPane'
import { EditorPane, type EditorPaneHandle } from '../editor/EditorPane'
import { SearchBar } from '../search/SearchBar'
import { FolderTree } from './FolderTree'
import { NoteList } from './NoteList'
import { useLibrary, type LibraryNotePort } from './useLibrary'

interface LibraryLayoutProps {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
  assets?: AssetPort
  search?: SearchPort
}

export function LibraryLayout({ notes, folders, system, assets, search }: LibraryLayoutProps) {
  const library = useLibrary(notes, folders)
  const [columnPreference, setColumnPreference] = useState<LibraryColumnPreference | null>(null)
  const preferenceRequest = useRef(0)
  const editorRef = useRef<EditorPaneHandle>(null)
  const navigationRequest = useRef(0)

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
    const canNavigate = (await editorRef.current?.flush()) ?? true
    if (canNavigate && request === navigationRequest.current) navigate()
  }

  return (
    <div className="library-shell">
      {search && <SearchBar search={search} onSelect={(noteId) => void navigateAfterSave(() => library.selectNote(noteId))} />}
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
          state={library.folderState}
          onSelect={(folderId) => void navigateAfterSave(() => library.selectFolder(folderId))}
          onCreate={library.createFolder}
          onRename={library.renameFolder}
          onMove={library.moveFolder}
          onDelete={library.deleteFolder}
        />
      </aside>
      <aside data-testid="note-list-pane" className="library-pane library-pane--notes">
        <NoteList
          notes={library.notes}
          activeId={library.activeNoteId}
          state={library.noteListState}
          onSelect={(noteId) => void navigateAfterSave(() => library.selectNote(noteId))}
        />
      </aside>
      <section data-testid="content-pane" className="library-content" aria-label="笔记内容">
        {library.documentState === 'loading' && <p className="content-placeholder">正在打开笔记…</p>}
        {library.documentState === 'error' && <p className="content-placeholder content-placeholder--error">无法打开笔记。</p>}
        {library.documentState === 'ready' && library.document === null && (
          <div className="content-placeholder">
            <span aria-hidden="true" className="content-placeholder__leaf">⌁</span>
            <p>选择一篇笔记开始阅读。</p>
          </div>
        )}
        {library.document && (
          <EditorPane
            key={`${library.document.id}:${library.document.revision}`}
            ref={editorRef}
            document={library.document}
            notes={notes}
            assets={assets}
            search={search}
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
