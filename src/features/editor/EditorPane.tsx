import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import type { EditorMode, Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import type { AssetPort, ImageReadPort, LinkPort, NotePort, RenameNoteResult, SearchPort, SystemPort } from '../../domain/ports'
import { TagsEditor } from '../search/TagsEditor'
import { Backlinks } from './Backlinks'
import { EditorActionsMenu } from './EditorActionsMenu'
import { MarkdownPreview } from './MarkdownPreview'
import { MarkdownSource, type MarkdownSourceHandle } from './MarkdownSource'
import { useAutosave, type SaveState } from './useAutosave'
import { StatusNotice, type StatusNoticeState } from '../../shared/StatusNotice'
import { Icon, type IconName } from '../../shared/Icon'

interface EditorPaneProps {
  document: NoteDocument
  notes: Pick<NotePort, 'saveNote' | 'loadNote'>
  assets?: AssetPort
  assetReader?: ImageReadPort
  search?: SearchPort
  onDocumentAdopt?: (document: NoteDocument) => void
  autosaveDelayMs?: number
  initialMode?: EditorMode
  links?: LinkPort
  linkCache?: ReadonlyMap<NoteId, NoteSummary>
  onNavigateNote?(noteId: NoteId): void | Promise<void>
  folders?: Folder[]
  onRenameNote?(title: string): Promise<RenameNoteResult>
  onMoveNote?(folderId: FolderId | null): Promise<NoteDocument>
  external?: Pick<SystemPort, 'openExternal'>
  onSaveStateChange?(status: SaveState['status']): void
}

export interface EditorPaneHandle {
  flush: () => Promise<boolean>
  beginEditBarrier: () => Promise<void>
  endEditBarrier: () => void
  navigateToHeading: (line: number, headingIndex: number) => void
}

const modes: ReadonlyArray<{ mode: EditorMode; label: string; icon: IconName }> = [
  { mode: 'source', label: '源码视图', icon: 'source' },
  { mode: 'split', label: '分栏视图', icon: 'split' },
  { mode: 'preview', label: '预览视图', icon: 'preview' },
]

const minimumSplitPercent = 25
const maximumSplitPercent = 75
const defaultSplitPercent = 50

export const EditorPane = forwardRef<EditorPaneHandle, EditorPaneProps>(function EditorPane(
  {
    document,
    notes,
    assets,
    assetReader,
    search,
    links,
    linkCache,
    onNavigateNote,
    folders,
    onRenameNote,
    onMoveNote,
    external,
    onDocumentAdopt,
    onSaveStateChange,
    autosaveDelayMs,
    initialMode = 'source',
  },
  ref,
) {
  const [mode, setMode] = useState<EditorMode>(initialMode)
  const [splitPercent, setSplitPercent] = useState(defaultSplitPercent)
  const [imageError, setImageError] = useState<string | null>(null)
  const [tagTransactionActive, setTagTransactionActive] = useState(false)
  const [titleDraft, setTitleDraft] = useState(document.title)
  const [metadataBusy, setMetadataBusy] = useState(false)
  const [metadataNotice, setMetadataNotice] = useState<string | null>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [linkTargets, setLinkTargets] = useState<NoteSummary[]>([])
  const [selectedLinkTarget, setSelectedLinkTarget] = useState<NoteId | ''>('')
  const [linkActionError, setLinkActionError] = useState<string | null>(null)
  const previewRef = useRef<HTMLElement>(null)
  const sourceScrollRef = useRef<HTMLElement | null>(null)
  const sourceRef = useRef<MarkdownSourceHandle>(null)
  const splitPointerRef = useRef<number | null>(null)
  const autosave = useAutosave(document, notes, { delayMs: autosaveDelayMs })
  const tagRequestRef = useRef(0)
  const hasSecondaryActions = links !== undefined || (folders !== undefined && onMoveNote !== undefined) || search !== undefined

  useEffect(() => setImageError(null), [document.id])
  useEffect(() => onSaveStateChange?.(autosave.state.status), [autosave.state.status, onSaveStateChange])
  useEffect(() => setTitleDraft(document.title), [document.id, document.title])
  useEffect(() => {
    let current = true
    setLinkTargets([])
    setSelectedLinkTarget('')
    if (links === undefined) return () => { current = false }
    void links.listTargets().then(
      (targets) => {
        if (!current) return
        setLinkTargets(targets)
        setSelectedLinkTarget(targets[0]?.id ?? '')
      },
      () => { if (current) setLinkActionError('无法加载内部链接目标。') },
    )
    return () => { current = false }
  }, [document.id, links])
  useEffect(() => {
    tagRequestRef.current += 1
    return () => {
      tagRequestRef.current += 1
    }
  }, [document.id])

  useImperativeHandle(ref, () => ({
    flush: autosave.flush,
    beginEditBarrier: () => sourceRef.current?.beginEditBarrier() ?? Promise.resolve(),
    endEditBarrier: () => sourceRef.current?.endEditBarrier(),
    navigateToHeading: (line, headingIndex) => {
      sourceRef.current?.navigateToLine(line)
      const heading = previewRef.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').item(headingIndex)
      heading?.scrollIntoView({ block: 'center' })
    },
  }), [autosave.flush])

  const updateTags = async (tags: string[]) => {
    if (search === undefined) return
    const noteId = document.id
    const request = ++tagRequestRef.current
    const source = sourceRef.current
    setTagTransactionActive(true)
    try {
      await source?.beginEditBarrier()
      if (tagRequestRef.current !== request) return
      if (!(await autosave.flush())) throw new Error('markdown flush failed')
      if (tagRequestRef.current !== request) return
      await search.updateTags(noteId, tags)
      if (tagRequestRef.current !== request) return
      const authoritative = await notes.loadNote(noteId)
      if (tagRequestRef.current !== request || authoritative.id !== noteId) return
      onDocumentAdopt?.(authoritative)
    } finally {
      source?.endEditBarrier()
      setTagTransactionActive(false)
    }
  }

  const renameNote = async () => {
    const title = titleDraft.trim()
    if (onRenameNote === undefined || metadataBusy || title.length === 0 || title === document.title) return
    setMetadataBusy(true)
    setMetadataError(null)
    setMetadataNotice(null)
    try {
      const result = await onRenameNote(title)
      setTitleDraft(result.document.title)
      setMetadataNotice(
        result.linkRepair.failure !== null || result.linkRepair.failedSourceIds.length > 0
          ? `标题已更新；${result.linkRepair.failedSourceIds.length} 个引用标签将在重试时修复。`
          : `标题已更新；已刷新 ${result.linkRepair.updated} 个引用标签。`,
      )
    } catch {
      setMetadataError('无法重命名笔记，请解决保存错误后重试。')
    } finally {
      setMetadataBusy(false)
    }
  }

  const moveNote = async (folderId: FolderId | null) => {
    if (onMoveNote === undefined || metadataBusy || folderId === document.folderId) return
    setMetadataBusy(true)
    setMetadataError(null)
    setMetadataNotice(null)
    try {
      await onMoveNote(folderId)
      setMetadataNotice('笔记已移动。')
    } catch {
      setMetadataError('无法移动笔记，请解决保存错误后重试。')
    } finally {
      setMetadataBusy(false)
    }
  }

  const applyLinkAction = (action: 'insert' | 'retarget') => {
    const target = linkTargets.find((candidate) => candidate.id === selectedLinkTarget)
    if (target === undefined) return
    const applied = action === 'insert'
      ? sourceRef.current?.insertInternalLink(target)
      : sourceRef.current?.retargetInternalLink(target)
    setLinkActionError(applied ? null : '请先把光标放在要重定向的内部链接上。')
  }

  const syncSourceToPreview = (scrollTop: number) => {
    if (mode !== 'split' || previewRef.current === null || sourceScrollRef.current === null) return
    syncScrollPosition(sourceScrollRef.current, previewRef.current, scrollTop)
  }

  const syncPreviewToSource = () => {
    if (mode !== 'split' || previewRef.current === null || sourceScrollRef.current === null) return
    syncScrollPosition(previewRef.current, sourceScrollRef.current, previewRef.current.scrollTop)
  }

  const resizeFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (splitPointerRef.current !== event.pointerId) return
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
    if (bounds === undefined || bounds.width <= 0) return
    const requested = Math.round(((event.clientX - bounds.left) / bounds.width) * 100)
    setSplitPercent(clampSplitPercent(requested))
  }

  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSplitPercent((value) => clampSplitPercent(value - 2))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSplitPercent((value) => clampSplitPercent(value + 2))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setSplitPercent(minimumSplitPercent)
    } else if (event.key === 'End') {
      event.preventDefault()
      setSplitPercent(maximumSplitPercent)
    }
  }

  return (
    <div className="editor-pane">
      <header className="editor-toolbar" role="toolbar" aria-label="编辑器视图">
        <div className="editor-toolbar__title">
          <span className="library-pane__eyebrow">笔记</span>
          <h2>{document.title}</h2>
          {onRenameNote && (
            <form onSubmit={(event) => { event.preventDefault(); void renameNote() }}>
              <label className="sr-only" htmlFor={`note-title-${document.id}`}>笔记标题</label>
              <input
                id={`note-title-${document.id}`}
                aria-label="笔记标题"
                value={titleDraft}
                disabled={metadataBusy}
                onChange={(event) => setTitleDraft(event.target.value)}
              />
            </form>
          )}
        </div>
        <div className="editor-toolbar__actions">
          <div className="editor-toolbar__primary">
            {hasSecondaryActions && (
              <EditorActionsMenu>
                {(close) => (
                  <>
                    {links && (
                      <div className="editor-actions-menu__section editor-link-actions" role="group" aria-label="内部链接">
                        <span className="editor-actions-menu__heading">内部链接</span>
                        <label>
                          <span className="sr-only">内部链接目标</span>
                          <select
                            aria-label="内部链接目标"
                            value={selectedLinkTarget}
                            disabled={linkTargets.length === 0}
                            onChange={(event) => setSelectedLinkTarget(event.target.value as NoteId)}
                          >
                            {linkTargets.length === 0 && <option value="">没有可链接的笔记</option>}
                            {linkTargets.map((target) => <option key={target.id} value={target.id}>{target.title}</option>)}
                          </select>
                        </label>
                        <div className="editor-actions-menu__buttons">
                          <button type="button" role="menuitem" disabled={selectedLinkTarget === ''} onClick={() => { applyLinkAction('insert'); close() }}>插入内部链接</button>
                          <button type="button" role="menuitem" disabled={selectedLinkTarget === ''} onClick={() => { applyLinkAction('retarget'); close() }}>重定向内部链接</button>
                        </div>
                      </div>
                    )}
                    {folders && onMoveNote && (
                      <div className="editor-actions-menu__section" role="group" aria-label="目录">
                        <span className="editor-actions-menu__heading">目录</span>
                        <label>
                          <span className="sr-only">笔记文件夹</span>
                          <select
                            aria-label="笔记文件夹"
                            value={document.folderId ?? ''}
                            disabled={metadataBusy}
                            onChange={(event) => void moveNote(event.target.value === '' ? null : event.target.value as FolderId)}
                          >
                            <option value="">未归档笔记</option>
                            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                          </select>
                        </label>
                      </div>
                    )}
                    {search && (
                      <div className="editor-actions-menu__section" role="group" aria-label="标签">
                        <span className="editor-actions-menu__heading">标签</span>
                        <TagsEditor tags={document.tags} onChange={updateTags} />
                      </div>
                    )}
                  </>
                )}
              </EditorActionsMenu>
            )}
            <CompactSaveStatus state={autosave.state} />
            {modes.map((item) => (
              <button
                key={item.mode}
                type="button"
                className="editor-mode-button"
                aria-label={item.label}
                aria-pressed={mode === item.mode}
                title={item.label}
                onClick={() => setMode(item.mode)}
              >
                <Icon name={item.icon} size={17} />
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="editor-notices">
        {autosave.state.status === 'error' && <SaveStatus state={autosave.state} />}
        {imageError && <p className="editor-metadata-status editor-save--error" role="alert">{imageError}</p>}
        {metadataNotice && <p className="editor-metadata-status" role="status">{metadataNotice}</p>}
        {metadataError && <p className="editor-metadata-status editor-save--error" role="alert">{metadataError}</p>}
        {linkActionError && <p className="editor-metadata-status editor-save--error" role="alert">{linkActionError}</p>}
      </div>
      <div
        className={`editor-document editor-document--${mode}`}
        style={
          mode === 'split'
            ? { gridTemplateColumns: `${splitPercent}fr 8px ${100 - splitPercent}fr` }
            : undefined
        }
      >
        <div className="editor-document__source" hidden={mode === 'preview'}>
          <MarkdownSource
            ref={sourceRef}
            markdown={autosave.markdown}
            noteId={document.id}
            assets={assets}
            onImageError={setImageError}
            onChange={autosave.updateMarkdown}
            onScroll={syncSourceToPreview}
            onScrollElement={(element) => {
              sourceScrollRef.current = element
            }}
            readOnly={tagTransactionActive}
            links={links}
            linkCache={linkCache}
            onNavigateLink={(noteId) => void onNavigateNote?.(noteId)}
          />
        </div>
        <div
          className="editor-split-divider"
          role="separator"
          aria-label="Resize editor split"
          aria-orientation="vertical"
          aria-valuemin={minimumSplitPercent}
          aria-valuemax={maximumSplitPercent}
          aria-valuenow={splitPercent}
          hidden={mode !== 'split'}
          tabIndex={mode === 'split' ? 0 : -1}
          onPointerDown={(event) => {
            splitPointerRef.current = event.pointerId
            event.currentTarget.setPointerCapture?.(event.pointerId)
          }}
          onPointerMove={resizeFromPointer}
          onPointerUp={(event) => {
            if (splitPointerRef.current !== event.pointerId) return
            splitPointerRef.current = null
            event.currentTarget.releasePointerCapture?.(event.pointerId)
          }}
          onDoubleClick={() => setSplitPercent(defaultSplitPercent)}
          onKeyDown={resizeFromKeyboard}
        />
        <div className="editor-document__preview" hidden={mode === 'source'}>
          <MarkdownPreview
            ref={previewRef}
            markdown={autosave.markdown}
            onScroll={syncPreviewToSource}
            links={links}
            linkCache={linkCache}
            onNavigateLink={(noteId) => void onNavigateNote?.(noteId)}
            noteId={document.id}
            assetReader={assetReader}
            external={external}
          />
        </div>
      </div>
      {links && onNavigateNote && (
        <Backlinks noteId={document.id} links={links} onNavigate={onNavigateNote} />
      )}
    </div>
  )
})

function SaveStatus({ state }: { state: SaveState }) {
  const notice: StatusNoticeState = state.status === 'idle'
    ? { status: 'idle' }
    : state.status === 'error'
      ? state
      : {
          status: state.status === 'saved' ? 'success' : 'status',
          message: { dirty: '待保存', saving: '保存中…', saved: '已保存' }[state.status],
        }
  return <StatusNotice state={notice} className="editor-metadata-status editor-save-notice editor-save--error" />
}

function CompactSaveStatus({ state }: { state: SaveState }) {
  if (state.status === 'idle') return null
  const message = state.status === 'error'
    ? '保存失败'
    : { dirty: '待保存', saving: '保存中…', saved: '已保存' }[state.status]
  return (
    <span
      className={`editor-save${state.status === 'error' ? ' editor-save--error' : ''}`}
      role="status"
      aria-label={state.status === 'error' ? '保存失败' : '编辑器保存状态'}
      aria-live="polite"
    >
      {message}
    </span>
  )
}

function syncScrollPosition(source: HTMLElement, target: HTMLElement, sourceTop: number) {
  const sourceRange = Math.max(0, source.scrollHeight - source.clientHeight)
  const targetRange = Math.max(0, target.scrollHeight - target.clientHeight)
  target.scrollTop = sourceRange === 0 ? sourceTop : (sourceTop / sourceRange) * targetRange
}

function clampSplitPercent(value: number) {
  return Math.min(maximumSplitPercent, Math.max(minimumSplitPercent, value))
}
