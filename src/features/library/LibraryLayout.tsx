import type { FolderPort, SystemPort } from '../../domain/ports'
import { SplitPane, type SplitPaneSizes } from '../../shared/SplitPane'
import { FolderTree } from './FolderTree'
import { NoteList } from './NoteList'
import { useLibrary, type LibraryNotePort } from './useLibrary'

interface LibraryLayoutProps {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
}

export function LibraryLayout({ notes, folders, system }: LibraryLayoutProps) {
  const library = useLibrary(notes, folders)

  const persistColumns = (sizes: SplitPaneSizes, containerWidth: number) => {
    const total = containerWidth > 0 ? containerWidth : window.innerWidth
    const value = {
      folder: sizes[0] / total,
      noteList: sizes[1] / total,
    }
    void system.setWindowPreference('library-columns', value).catch(() => undefined)
  }

  return (
    <SplitPane
      defaultSizes={[240, 300]}
      minimumSizes={[180, 220, 420]}
      dividerLabels={['调整文件夹栏宽度', '调整笔记列表栏宽度']}
      onCommit={persistColumns}
    >
      <aside data-testid="folder-pane" className="library-pane library-pane--folders">
        <FolderTree
          folders={library.folders}
          activeId={library.activeFolderId}
          state={library.folderState}
          onSelect={library.selectFolder}
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
          onSelect={library.selectNote}
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
          <article className="document-placeholder">
            <span className="library-pane__eyebrow">笔记</span>
            <h2>{library.document.title}</h2>
            <p>编辑器将在下一阶段接入。</p>
          </article>
        )}
      </section>
    </SplitPane>
  )
}
