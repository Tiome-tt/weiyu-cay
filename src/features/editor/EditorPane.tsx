import { ErrorNotification } from '../../shared/notifications'
import { TypedEditorPane } from '../content/TypedEditorPane'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import type { EditorMode, Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import type { AiPort, AssetPort, ImageReadPort, LinkPort, NotePort, RenameNoteResult, SearchPort, SystemPort } from '../../domain/ports'
import { TagsEditor } from '../search/TagsEditor'
import { EditorStatusBar, type EditorStatusBarHandle } from './EditorStatusBar'
import { Backlinks } from './Backlinks'
import { EditorActionsMenu } from './EditorActionsMenu'
import { InternalLinkDialog } from './InternalLinkDialog'
import { MarkdownPreview } from './MarkdownPreview'
import { MarkdownSource, type MarkdownSourceHandle } from './MarkdownSource'
import { useAutosave, type SaveState } from './useAutosave'
import { StatusNotice, type StatusNoticeState } from '../../shared/StatusNotice'
import { Icon, type IconName } from '../../shared/Icon'
import { AiSummaryWidget } from '../ai/AiSummaryWidget'
import { waitForImageAssets } from '../content/imageAssetLoader'

export interface EditorPaneProps {
  onConvertFileToDocument?(source: NoteDocument, bytes: Uint8Array): Promise<void>
  files?: import('../../domain/ports').FilePort
  document: NoteDocument
  notes: Pick<NotePort, 'saveNote' | 'loadNote'>
  assets?: AssetPort
  assetReader?: ImageReadPort
  search?: SearchPort
  onDocumentAdopt?: (document: NoteDocument) => void
  autosaveDelayMs?: number
  ai?: AiPort
  deepseekModel?: string
  onOpenSettings?(): void
  initialMode?: EditorMode
  links?: LinkPort
  linkCache?: ReadonlyMap<NoteId, NoteSummary>
  onNavigateNote?(noteId: NoteId): void | Promise<void>
  folders?: Folder[]
  onRenameNote?(title: string): Promise<RenameNoteResult>
  onMoveNote?(folderId: FolderId | null): Promise<NoteDocument>
  external?: Pick<SystemPort, 'openExternal'>
  onSaveStateChange?(status: SaveState['status']): void
  onDraftChange?(markdown: string): void
}

export interface EditorPaneHandle {
  flush: () => Promise<boolean>
  beginEditBarrier: () => Promise<void>
  endEditBarrier: () => void
  navigateToHeading: (line: number, headingIndex: number) => void
  exportDocument: (kind: 'word' | 'pdf') => Promise<boolean>
}

const modes: ReadonlyArray<{ mode: EditorMode; label: string; icon: IconName }> = [
  { mode: 'source', label: '文档编辑', icon: 'source' },
  { mode: 'split', label: '分栏校对', icon: 'split' },
  { mode: 'preview', label: '阅读视图', icon: 'preview' },
]

const minimumSplitPercent = 25
const maximumSplitPercent = 75
const defaultSplitPercent = 50
const previewRefreshDelayMs = 240

const MarkdownEditorPane = forwardRef<EditorPaneHandle, EditorPaneProps>(function MarkdownEditorPane(
  {
    document,
    notes,
    files,
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
    onDraftChange,
    autosaveDelayMs,
    ai,
    deepseekModel,
    onOpenSettings,
    initialMode = 'source',
  },
  ref,
) {
  const statisticsRef = useRef<EditorStatusBarHandle>(null)
  const [selectedText, setSelectedText] = useState('')
  const [mode, setMode] = useState<EditorMode>(initialMode)
  useEffect(() => setSelectedText(''), [mode])
  const [splitPercent, setSplitPercent] = useState(defaultSplitPercent)
  const [imageError, setImageError] = useState<string | null>(null)
  const [tagTransactionActive, setTagTransactionActive] = useState(false)
  const [titleDraft, setTitleDraft] = useState(document.title)
  const [metadataBusy, setMetadataBusy] = useState(false)
  const [metadataNotice, setMetadataNotice] = useState<string | null>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [linkTargets, setLinkTargets] = useState<NoteSummary[]>([])
  const [linkActionError, setLinkActionError] = useState<string | null>(null)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const previewRef = useRef<HTMLElement>(null)
  const sourceScrollRef = useRef<HTMLElement | null>(null)
  const sourceRef = useRef<MarkdownSourceHandle>(null)
  const splitPointerRef = useRef<number | null>(null)
  const autosave = useAutosave(document, notes, { delayMs: autosaveDelayMs, publishDraftState: false })
  const [previewMarkdown, setPreviewMarkdown] = useState(document.markdown)
  const draftMarkdownRef = useRef(document.markdown)
  const previewMarkdownRef = useRef(document.markdown)
  const previewTimerRef = useRef<number | null>(null)
  const draftReportMarkdownRef = useRef(document.markdown)
  const draftReportTimerRef = useRef<number | null>(null)
  const onDraftChangeRef = useRef(onDraftChange)
  const previousModeRef = useRef(mode)
  const modeRef = useRef(mode)
  const tagRequestRef = useRef(0)
  const exportRef = useRef<(kind: 'word' | 'pdf') => Promise<boolean>>(() => Promise.resolve(false))
  const hasSecondaryActions = (folders !== undefined && onMoveNote !== undefined)
    || search !== undefined
  const breadcrumbs = documentBreadcrumb(document, folders)
  const displayTitle = localizedDocumentTitle(document)
  modeRef.current = mode
  onDraftChangeRef.current = onDraftChange
  const waitForImages = assetReader === undefined ? undefined : () => waitForImageAssets(assetReader, document.id)

  useEffect(() => setImageError(null), [document.id])
  useEffect(() => setLinkDialogOpen(false), [document.id])
  useEffect(() => setMode(initialMode), [document.id, initialMode])
  const schedulePreview = useCallback((markdown: string, immediate = false) => {
    previewMarkdownRef.current = markdown
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    if (modeRef.current === 'source') return
    if (immediate) {
      setPreviewMarkdown(markdown)
      return
    }
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null
      setPreviewMarkdown(previewMarkdownRef.current)
    }, previewRefreshDelayMs)
  }, [])
  const scheduleDraftReport = useCallback((markdown: string) => {
    draftReportMarkdownRef.current = markdown
    if (draftReportTimerRef.current !== null) window.clearTimeout(draftReportTimerRef.current)
    draftReportTimerRef.current = window.setTimeout(() => {
      draftReportTimerRef.current = null
      onDraftChangeRef.current?.(draftReportMarkdownRef.current)
    }, previewRefreshDelayMs)
  }, [])
  useEffect(() => {
    const modeChanged = previousModeRef.current !== mode
    previousModeRef.current = mode
    schedulePreview(draftMarkdownRef.current, modeChanged)
  }, [mode, schedulePreview])
  useEffect(() => {
    if (autosave.markdown === draftMarkdownRef.current) return
    draftMarkdownRef.current = autosave.markdown
    schedulePreview(autosave.markdown, true)
  }, [autosave.markdown, schedulePreview])
  useEffect(() => () => {
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current)
    if (draftReportTimerRef.current !== null) window.clearTimeout(draftReportTimerRef.current)
  }, [])
  useEffect(() => onSaveStateChange?.(autosave.state.status), [autosave.state.status, onSaveStateChange])
  useEffect(() => setTitleDraft(document.title), [document.id, document.title])
  useEffect(() => {
    let current = true
    setLinkTargets([])
    if (links === undefined) return () => { current = false }
    void links.listTargets().then(
      (targets) => {
        if (!current) return
        setLinkTargets(targets)
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
    exportDocument: (kind) => exportRef.current(kind),
  }), [autosave.flush])

  const exportMarkdownPdf = async (): Promise<boolean> => {
    if (metadataBusy) return false
    setMetadataBusy(true)
    setMetadataError(null)
    const source = sourceRef.current
    try {
      await source?.beginEditBarrier()
      if (!await autosave.flush()) throw new Error('Save failed')
      const current = await notes.loadNote(document.id)
      const { exportMarkdownDocumentToPdf } = await import('../content/pdfExport')
      if (!files?.savePdfExport) throw new Error('Direct PDF export is unavailable')
      return await exportMarkdownDocumentToPdf(current, assetReader, files)
    } catch {
      setMetadataError('操作未完成，原笔记已保留。请检查保存状态后重试。')
      return false
    } finally {
      source?.endEditBarrier()
      setMetadataBusy(false)
    }
  }
  exportRef.current = (kind) => kind === 'pdf' ? exportMarkdownPdf() : Promise.resolve(false)

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
    } catch {
      setMetadataError('无法移动笔记，请解决保存错误后重试。')
    } finally {
      setMetadataBusy(false)
    }
  }

  const openInternalLinkDialog = () => {
    setLinkActionError(null)
    setLinkDialogOpen(true)
  }

  const insertInternalLinkFromDialog = (target: NoteSummary) => {
    const applied = sourceRef.current?.insertInternalLink(target) === true
    setLinkActionError(applied ? null : '无法在当前位置插入内部链接。')
    return applied
  }
  const syncSourceToPreview = useCallback((scrollTop: number) => {
    if (mode !== 'split' || previewRef.current === null || sourceScrollRef.current === null) return
    syncScrollPosition(sourceScrollRef.current, previewRef.current, scrollTop)
  }, [mode])

  const syncPreviewToSource = useCallback(() => {
    if (mode !== 'split' || previewRef.current === null || sourceScrollRef.current === null) return
    syncScrollPosition(previewRef.current, sourceScrollRef.current, previewRef.current.scrollTop)
  }, [mode])

  const handleSourceChange = useCallback((markdown: string) => {
    draftMarkdownRef.current = markdown
    statisticsRef.current?.updateText(markdown)
    autosave.updateMarkdown(markdown)
    scheduleDraftReport(markdown)
    schedulePreview(markdown)
  }, [autosave.updateMarkdown, scheduleDraftReport, schedulePreview])

  const handleNavigateLink = useCallback((noteId: NoteId) => {
    void onNavigateNote?.(noteId)
  }, [onNavigateNote])

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
        <nav className="editor-breadcrumbs" aria-label="当前位置">
          {breadcrumbs.map((label, index) => (
            <span key={`${label}-${index}`}>
              {index > 0 && <span className="editor-breadcrumbs__separator" aria-hidden="true">/</span>}
              <span>{label}</span>
            </span>
          ))}
        </nav>
        <div className="editor-toolbar__actions">
          <div className="editor-toolbar__primary">
            {hasSecondaryActions && (
              <EditorActionsMenu>
                {() => (
                  <>
                    {folders && onMoveNote && (
                      <div className="editor-actions-menu__section" role="group" aria-label="目录">
                        <span className="editor-actions-menu__heading">目录</span>
                        <label>
                          <span className="sr-only">笔记文件夹</span>
                          <select
                            aria-label="笔记文件夹"
                            value={document.folderId ?? ''}
                            disabled={metadataBusy}
                            onChange={(event) => { if (event.target.value !== '') void moveNote(event.target.value as FolderId) }}
                          >
                            <option value="" disabled hidden>请选择文件夹</option>
                            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                          </select>
                        </label>
                      </div>
                    )}

                  </>
                )}
              </EditorActionsMenu>
            )}

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
        <ErrorNotification error={imageError} />
        {metadataNotice && <p className="editor-metadata-status" role="status">{metadataNotice}</p>}
        <ErrorNotification error={metadataError} />
        <ErrorNotification error={linkActionError} />
      </div>
      <div
        className={`editor-document editor-document--${mode}`}
      >
        <div className="editor-document-heading">
          {onRenameNote ? (
            <form onSubmit={(event) => { event.preventDefault(); void renameNote() }}>
              <label className="sr-only" htmlFor={`note-title-${document.id}`}>笔记标题</label>
              <h1>
                <input
                  id={`note-title-${document.id}`}
                  aria-label="笔记标题"
                  value={titleDraft}
                  disabled={metadataBusy}
                  onChange={(event) => setTitleDraft(event.target.value)}
                />
              </h1>
            </form>
          ) : (
            <h1>{displayTitle}</h1>
          )}
          <div className="editor-document-heading__meta">
            {search ? <TagsEditor tags={document.tags} onChange={updateTags} /> : document.tags.length > 0 && (
              <ul className="editor-document-heading__tags" aria-label="笔记标签">
                {document.tags.map((tag) => <li key={tag}>#{tag}</li>)}
              </ul>
            )}
          </div>
        </div>
        <div
          className={`editor-document__body editor-document__body--${mode}`}
          style={
            mode === 'split'
              ? { gridTemplateColumns: `${splitPercent}fr 8px ${100 - splitPercent}fr` }
              : undefined
          }
        >
          <div className="editor-document__source" hidden={mode === 'preview'}>
          <MarkdownSource
            ref={sourceRef}
            onSelectionChange={setSelectedText}
            markdown={autosave.markdown}
            noteId={document.id}
            assets={assets}
            assetReader={assetReader}
            onImageError={setImageError}
            onChange={handleSourceChange}
            onScroll={syncSourceToPreview}
            onScrollElement={(element) => {
              sourceScrollRef.current = element
            }}
            readOnly={tagTransactionActive}
            links={links}
            linkCache={linkCache}
            onNavigateLink={handleNavigateLink}
            presentation={mode === 'split' ? 'source' : 'document'}
            external={external}
            onInsertInternalLinkRequest={links ? openInternalLinkDialog : undefined}
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
            markdown={previewMarkdown}
            onScroll={syncPreviewToSource}
            links={links}
            linkCache={linkCache}
            onNavigateLink={handleNavigateLink}
            noteId={document.id}
            assetReader={assetReader}
            external={external}
            />
          </div>
        </div>
        {document.kind !== 'temporary' && <AiSummaryWidget noteId={document.id} title={displayTitle} markdown={draftMarkdownRef.current} ai={ai} model={deepseekModel} onOpenSettings={onOpenSettings} waitForImages={waitForImages} />}
      </div>
      {linkDialogOpen && links && (
        <InternalLinkDialog
          currentNoteId={document.id}
          folders={folders ?? []}
          targets={linkTargets}
          onInsert={insertInternalLinkFromDialog}
          onCancel={() => setLinkDialogOpen(false)}
        />
      )}
      <EditorStatusBar ref={statisticsRef} text={autosave.markdown} selectedText={selectedText} updatedAt={autosave.updatedAt} state={autosave.state} related={links && onNavigateNote ? (
        <Backlinks
          noteId={document.id}
          links={links}
          onNavigate={onNavigateNote}
          refreshToken={`${autosave.updatedAt}:${autosave.state.status}`}
        />
      ) : undefined} />
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

function syncScrollPosition(source: HTMLElement, target: HTMLElement, sourceTop: number) {
  const sourceRange = Math.max(0, source.scrollHeight - source.clientHeight)
  const targetRange = Math.max(0, target.scrollHeight - target.clientHeight)
  target.scrollTop = sourceRange === 0 ? sourceTop : (sourceTop / sourceRange) * targetRange
}

function clampSplitPercent(value: number) {
  return Math.min(maximumSplitPercent, Math.max(minimumSplitPercent, value))
}

function documentBreadcrumb(document: NoteDocument, folders?: Folder[]) {
  const labels: string[] = []
  const byId = new Map(folders?.map((folder) => [folder.id, folder]) ?? [])
  const visited = new Set<FolderId>()
  let folderId = document.folderId
  while (folderId !== null && !visited.has(folderId)) {
    visited.add(folderId)
    const folder = byId.get(folderId)
    if (folder === undefined) break
    labels.unshift(folder.name)
    folderId = folder.parentId
  }
  if (labels.length === 0) labels.push('未归档')
  labels.push(localizedDocumentTitle(document))
  return labels
}

function localizedDocumentTitle(document: NoteDocument) {
  return document.kind === 'temporary' && document.title === 'Temporary capture'
    ? '临时便笺'
    : document.title
}

export const EditorPane = forwardRef<EditorPaneHandle, EditorPaneProps>(function EditorPane(props, ref) {
  return props.document.content
    ? <TypedEditorPane key={props.document.id} {...props} ref={ref} />
    : <MarkdownEditorPane key={props.document.id} {...props} ref={ref} />
})
