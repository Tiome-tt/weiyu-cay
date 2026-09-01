import { markdown as markdownLanguage } from '@codemirror/lang-markdown'
import { Annotation, Compartment, EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { GFM } from '@lezer/markdown'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { AssetPort, ImageReadPort, LinkPort, SystemPort } from '../../domain/ports'
import { handleImagePaste, type ImagePasteResult } from './imagePaste'
import { insertInternalLink, internalLinkExtension, refreshInternalLinkContext, retargetInternalLink } from './internalLinks'
import {
  createDocumentMarkdownExtension,
  refreshDocumentMarkdownContext,
  type MarkdownPresentation,
} from './documentMarkdown'
import {
  formatMarkdownSelection,
  markdownSnippets,
  tableMarkdownFromModel,
  type MarkdownSelectionStyle,
  type MarkdownTable,
} from './markdownActions'
import { TableEditorDialog } from './TableEditorDialog'

const pasteTokenAnnotation = Annotation.define<symbol>()

interface MarkdownSourceProps {
  markdown: string
  onChange(markdown: string): void
  noteId?: NoteId
  assets?: AssetPort
  assetReader?: ImageReadPort
  onImageError?(message: string | null): void
  onScroll?(scrollTop: number): void
  onScrollElement?(element: HTMLElement | null): void
  readOnly?: boolean
  links?: Pick<LinkPort, 'resolve'>
  linkCache?: ReadonlyMap<NoteId, NoteSummary>
  onNavigateLink?(noteId: NoteId): void
  presentation?: MarkdownPresentation
  showBlockHandle?: boolean
  external?: Pick<SystemPort, 'openExternal'>
  onInsertInternalLinkRequest?(): void
}

export interface MarkdownSourceHandle {
  beginEditBarrier(): Promise<void>
  endEditBarrier(): void
  insertInternalLink(target: NoteSummary): boolean
  retargetInternalLink(target: NoteSummary): boolean
  navigateToLine(line: number): boolean
}

interface PendingPaste {
  from: number
  to: number
  settled: Promise<void>
  settle(): void
  noteId: NoteId
  generation: number
  view: EditorView
  outcome: ImagePasteResult | null
}

interface TableDialogState {
  x: number
  y: number
  sourceRange?: { from: number; to: number }
  table?: MarkdownTable
}

export const MarkdownSource = forwardRef<MarkdownSourceHandle, MarkdownSourceProps>(function MarkdownSource({
  markdown,
  onChange,
  noteId,
  assets,
  assetReader,
  onImageError,
  onScroll,
  onScrollElement,
  readOnly = false,
  links,
  linkCache,
  onNavigateLink,
  presentation = 'document',
  showBlockHandle = true,
  external,
  onInsertInternalLinkRequest,
}: MarkdownSourceProps, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onScrollRef = useRef(onScroll)
  const onScrollElementRef = useRef(onScrollElement)
  const reconcilingRef = useRef(false)
  const noteIdRef = useRef(noteId)
  const assetsRef = useRef(assets)
  const assetReaderRef = useRef(assetReader)
  const onImageErrorRef = useRef(onImageError)
  const editorGenerationRef = useRef(0)
  const readOnlyRef = useRef(readOnly)
  const barrierDepthRef = useRef(0)
  const pendingPastesRef = useRef(new Map<symbol, PendingPaste>())
  const authorizedPasteTokensRef = useRef(new Set<symbol>())
  const editableCompartmentRef = useRef(new Compartment())
  const linksRef = useRef(links)
  const linkCacheRef = useRef(linkCache)
  const onNavigateLinkRef = useRef(onNavigateLink)
  const presentationRef = useRef(presentation)
  const externalRef = useRef(external)
  const renderedLinkContextRef = useRef({ links, linkCache })
  const contextViewRef = useRef<EditorView | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [tableDialog, setTableDialog] = useState<TableDialogState | null>(null)
  const [tableRows, setTableRows] = useState(3)
  const [tableColumns, setTableColumns] = useState(3)
  const [surfaceControls, setSurfaceControls] = useState({ blockTop: 12, toolbarTop: 12, toolbarLeft: 56, hasSelection: false })

  if (noteIdRef.current !== noteId) {
    noteIdRef.current = noteId
    editorGenerationRef.current += 1
  }
  assetsRef.current = assets
  assetReaderRef.current = assetReader
  onImageErrorRef.current = onImageError
  readOnlyRef.current = readOnly
  linksRef.current = links
  linkCacheRef.current = linkCache
  onNavigateLinkRef.current = onNavigateLink
  presentationRef.current = presentation
  externalRef.current = external

  onChangeRef.current = onChange
  onScrollRef.current = onScroll
  onScrollElementRef.current = onScrollElement

  const syncSurfaceControls = (view: EditorView) => {
    const selection = view.state.selection.main
    const hostBounds = hostRef.current?.getBoundingClientRect()
    let blockTop = 12
    let toolbarTop = 12
    let toolbarLeft = 56
    try {
      const caret = view.coordsAtPos(selection.head)
      const start = view.coordsAtPos(selection.from)
      const end = view.coordsAtPos(selection.to)
      if (caret !== null && hostBounds !== undefined) blockTop = Math.max(12, caret.top - hostBounds.top)
      if (start !== null && end !== null && hostBounds !== undefined) {
        toolbarTop = Math.max(40, Math.min(start.top, end.top) - hostBounds.top - 8)
        toolbarLeft = Math.max(56, (start.left + end.right) / 2 - hostBounds.left)
      }
    } catch {
      // JSDOM and hidden panes do not expose layout; stable fallbacks keep controls usable.
    }
    const next = { blockTop, toolbarTop, toolbarLeft, hasSelection: selection.from < selection.to }
    setSurfaceControls((current) => (
      current.blockTop === next.blockTop &&
      current.toolbarTop === next.toolbarTop &&
      current.toolbarLeft === next.toolbarLeft &&
      current.hasSelection === next.hasSelection
        ? current
        : next
    ))
  }

  const configureEditable = (view: EditorView | null) => {
    if (view === null) return
    const locked = readOnlyRef.current || barrierDepthRef.current > 0
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(locked),
        EditorView.editable.of(!locked),
        EditorView.contentAttributes.of({ 'aria-readonly': String(locked) }),
      ]),
    })
  }

  const drainReadyPastes = () => {
    while (true) {
      const next = pendingPastesRef.current.entries().next()
      if (next.done) return
      const [token, entry] = next.value
      const result = entry.outcome
      if (result === null) return
      const current =
        noteIdRef.current === entry.noteId &&
        editorGenerationRef.current === entry.generation &&
        viewRef.current === entry.view
      if (current && result.kind === 'failure') {
        onImageErrorRef.current?.(result.message)
      } else if (current && result.kind === 'success') {
        for (const pending of pendingPastesRef.current.values()) {
          if (pending !== entry && selectionsOverlap(entry, pending)) {
            pending.from = entry.to
            pending.to = entry.to
          }
        }
        onImageErrorRef.current?.(null)
        try {
          entry.view.dispatch({
            changes: { from: entry.from, to: entry.to, insert: result.markdown },
            selection: { anchor: entry.from + result.markdown.length },
            annotations: pasteTokenAnnotation.of(token),
          })
        } catch {
          onImageErrorRef.current?.('无法保存截图。')
        }
        pendingPastesRef.current.delete(token)
        authorizedPasteTokensRef.current.delete(token)
        entry.settle()
        continue
      }
      pendingPastesRef.current.delete(token)
      authorizedPasteTokensRef.current.delete(token)
      entry.settle()
    }
  }

  useImperativeHandle(ref, () => ({
    beginEditBarrier: async () => {
      barrierDepthRef.current += 1
      configureEditable(viewRef.current)
      authorizedPasteTokensRef.current.clear()
      for (const token of pendingPastesRef.current.keys()) {
        authorizedPasteTokensRef.current.add(token)
      }
      const pending = Array.from(pendingPastesRef.current.values(), (entry) => entry.settled)
      await Promise.allSettled(pending)
    },
    endEditBarrier: () => {
      barrierDepthRef.current = Math.max(0, barrierDepthRef.current - 1)
      authorizedPasteTokensRef.current.clear()
      configureEditable(viewRef.current)
    },
    insertInternalLink: (target) => {
      const view = viewRef.current
      if (view === null || readOnlyRef.current || barrierDepthRef.current > 0) return false
      return insertInternalLink(view, target)
    },
    retargetInternalLink: (target) => {
      const view = viewRef.current
      if (view === null || readOnlyRef.current || barrierDepthRef.current > 0) return false
      return retargetInternalLink(view, target)
    },
    navigateToLine: (line) => {
      const view = viewRef.current
      if (view === null) return false
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)))
      view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: 'center' }) })
      return true
    },
  }))

  useLayoutEffect(() => {
    const parent = hostRef.current
    if (parent === null) return
    const state = EditorState.create({
      doc: markdown,
      extensions: [
        markdownLanguage({ extensions: GFM }),
        createDocumentMarkdownExtension({
          getPresentation: () => presentationRef.current,
          isEditable: () => !readOnlyRef.current,
          getImageContext: () => ({ noteId: noteIdRef.current, assetReader: assetReaderRef.current }),
          onEditTable: ({ from, to, table }) => {
            const view = viewRef.current
            if (view === null || readOnlyRef.current || barrierDepthRef.current > 0) return
            const tableMarkdown = tableMarkdownFromModel(table)
            view.dispatch({
              changes: { from, to, insert: tableMarkdown },
              selection: { anchor: from + tableMarkdown.length },
            })
            view.focus()
          },
        }),
        ...(links
          ? [internalLinkExtension({
              links: { resolve: (id) => linksRef.current?.resolve(id) ?? Promise.resolve(null) },
              getCached: (id) => linkCacheRef.current?.get(id),
              onNavigate: (id) => onNavigateLinkRef.current?.(id),
            })]
          : []),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': 'Markdown source',
          'aria-multiline': 'true',
          spellcheck: 'true',
        }),
        editableCompartmentRef.current.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
        ]),
        keymap.of([
          { key: 'Mod-b', run: (view) => applyMarkdownStyle(view, 'bold', readOnlyRef, barrierDepthRef) },
          { key: 'Mod-i', run: (view) => applyMarkdownStyle(view, 'italic', readOnlyRef, barrierDepthRef) },
          { key: 'Mod-k', run: (view) => applyMarkdownStyle(view, 'link', readOnlyRef, barrierDepthRef) },
        ]),
        EditorState.transactionFilter.of((transaction) => {
          if (!transaction.docChanged) return transaction
          if (barrierDepthRef.current > 0) {
            const token = transaction.annotation(pasteTokenAnnotation)
            return token !== undefined && authorizedPasteTokensRef.current.has(token)
              ? transaction
              : []
          }
          return readOnlyRef.current && !reconcilingRef.current ? [] : transaction
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            for (const entry of pendingPastesRef.current.values()) {
              if (entry.from === entry.to) {
                entry.from = update.changes.mapPos(entry.from, 1)
                entry.to = entry.from
              } else {
                entry.from = update.changes.mapPos(entry.from, -1)
                entry.to = update.changes.mapPos(entry.to, 1)
              }
            }
          }
          if (update.docChanged && !reconcilingRef.current) {
            onChangeRef.current(update.state.doc.toString())
          }
          const movedToAnotherLine = update.docChanged && (
            update.startState.doc.lineAt(update.startState.selection.main.head).number !==
            update.state.doc.lineAt(update.state.selection.main.head).number
          )
          const selectionNeedsSync = update.selectionSet && (
            !update.docChanged ||
            !update.startState.selection.main.empty ||
            !update.state.selection.main.empty
          )
          if (selectionNeedsSync || (!update.docChanged && (update.viewportChanged || update.geometryChanged)) || movedToAnotherLine) {
            syncSurfaceControls(update.view)
          }
        }),
        EditorView.domEventHandlers({
          click: (event) => {
            if (!event.ctrlKey && !event.metaKey) return false
            const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.cm-live-link') : null
            const href = target?.dataset.liveHref
            if (href === undefined || !/^(?:https?:|mailto:)/iu.test(href)) return false
            event.preventDefault()
            void externalRef.current?.openExternal(href)
            return true
          },
          contextmenu: (event, contextView) => {
            event.preventDefault()
            const bounds = hostRef.current?.getBoundingClientRect()
            contextViewRef.current = contextView
            setContextMenu({
              x: event.clientX - (bounds?.left ?? 0),
              y: event.clientY - (bounds?.top ?? 0),
            })
            return true
          },
          paste: (event, pasteView) => {
            if (readOnlyRef.current || barrierDepthRef.current > 0) {
              event.preventDefault()
              return true
            }
            const originatingNoteId = noteIdRef.current
            const originatingGeneration = editorGenerationRef.current
            const assetPort = assetsRef.current
            if (originatingNoteId === undefined || assetPort === undefined) return false
            const selection = pasteView.state.selection.main
            const token = Symbol('pending-image-paste')
            let settle!: () => void
            const settled = new Promise<void>((resolve) => { settle = resolve })
            const pending: PendingPaste = {
              from: selection.from,
              to: selection.to,
              settled,
              settle,
              noteId: originatingNoteId,
              generation: originatingGeneration,
              view: pasteView,
              outcome: null,
            }
            pendingPastesRef.current.set(token, pending)
            void handleImagePaste(event, { noteId: originatingNoteId, assets: assetPort })
              .then((result) => {
                pending.outcome = result
                drainReadyPastes()
              })
              .catch(() => {
                pending.outcome = { kind: 'failure', message: '无法保存截图。' }
                drainReadyPastes()
              })
            return event.defaultPrevented
          },
        }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
          '.cm-content': { minHeight: '100%', padding: '24px 28px' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    })
    const view = new EditorView({ state, parent })
    viewRef.current = view
    syncSurfaceControls(view)

    Object.defineProperty(view.contentDOM, 'value', {
      configurable: true,
      get: () => view.state.doc.toString(),
    })

    const handleScroll = () => {
      onScrollRef.current?.(view.scrollDOM.scrollTop)
      syncSurfaceControls(view)
    }
    view.scrollDOM.addEventListener('scroll', handleScroll)
    onScrollElementRef.current?.(view.scrollDOM)

    return () => {
      onScrollElementRef.current?.(null)
      view.scrollDOM.removeEventListener('scroll', handleScroll)
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    configureEditable(view)
  }, [readOnly])

  useEffect(() => {
    const previous = renderedLinkContextRef.current
    renderedLinkContextRef.current = { links, linkCache }
    if (previous.links === links && previous.linkCache === linkCache) return
    viewRef.current?.dispatch({ effects: refreshInternalLinkContext.of(undefined) })
  }, [linkCache, links])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshDocumentMarkdownContext.of(undefined) })
  }, [assetReader, noteId, presentation])

  useEffect(() => {
    if (contextMenu === null && tableDialog === null) return
    const close = () => { setContextMenu(null); setTableDialog(null) }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu, tableDialog])

  const insertSnippet = (snippet: string) => {
    const view = contextViewRef.current ?? viewRef.current
    if (view === null || readOnlyRef.current || barrierDepthRef.current > 0) return
    const selection = view.state.selection.main
    const before = selection.from > 0 && view.state.doc.sliceString(selection.from - 1, selection.from) !== '\n' ? '\n\n' : ''
    const after = selection.to < view.state.doc.length && view.state.doc.sliceString(selection.to, selection.to + 1) !== '\n' ? '\n\n' : ''
    const insert = `${before}${snippet}${after}`
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: { anchor: selection.from + insert.length } })
    setContextMenu(null)
  }

  const openInsertionMenu = () => {
    const view = viewRef.current
    if (view === null || readOnlyRef.current || barrierDepthRef.current > 0) return
    contextViewRef.current = view
    setContextMenu({ x: 38, y: surfaceControls.blockTop + 28 })
  }

  const formatSelection = (style: MarkdownSelectionStyle) => {
    const view = viewRef.current
    if (view !== null) applyMarkdownStyle(view, style, readOnlyRef, barrierDepthRef)
  }

  const applyTable = (tableMarkdown: string) => {
    const sourceRange = tableDialog?.sourceRange
    if (sourceRange === undefined) {
      insertSnippet(tableMarkdown)
      setTableDialog(null)
      return
    }
    const view = viewRef.current
    if (view === null || readOnlyRef.current || barrierDepthRef.current > 0) return
    view.dispatch({
      changes: { from: sourceRange.from, to: sourceRange.to, insert: tableMarkdown },
      selection: { anchor: sourceRange.from + tableMarkdown.length },
    })
    setTableDialog(null)
    view.focus()
  }

  useEffect(() => {
    const view = viewRef.current
    if (view === null || view.state.doc.toString() === markdown) return
    const scrollTop = view.scrollDOM.scrollTop
    reconcilingRef.current = true
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: markdown } })
      view.scrollDOM.scrollTop = scrollTop
    } finally {
      reconcilingRef.current = false
    }
  }, [markdown])

  return (
    <div className="markdown-source" ref={hostRef}>
      {!readOnly && showBlockHandle && (
        <button
          type="button"
          className="markdown-block-handle"
          aria-label="添加内容块"
          title="添加内容块"
          style={{ top: surfaceControls.blockTop }}
          onPointerDown={(event) => event.preventDefault()}
          onClick={openInsertionMenu}
        >
          +
        </button>
      )}
      {!readOnly && surfaceControls.hasSelection && (
        <div
          className="markdown-inline-toolbar"
          role="toolbar"
          aria-label="选区格式"
          style={{ top: surfaceControls.toolbarTop, left: surfaceControls.toolbarLeft }}
          onPointerDown={(event) => event.preventDefault()}
        >
          <button type="button" aria-label="加粗" title="加粗" onClick={() => formatSelection('bold')}>B</button>
          <button type="button" aria-label="斜体" title="斜体" onClick={() => formatSelection('italic')}><i>I</i></button>
          <button type="button" aria-label="链接" title="链接" onClick={() => formatSelection('link')}>↗</button>
          <button type="button" aria-label="行内代码" title="行内代码" onClick={() => formatSelection('code')}>{'</>'}</button>
          <button type="button" aria-label="删除线" title="删除线" onClick={() => formatSelection('strikethrough')}><s>S</s></button>
        </div>
      )}
      {contextMenu && (
        <div className="markdown-context-menu" role="menu" aria-label="Markdown 快捷插入" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => { setTableRows(3); setTableColumns(3); setTableDialog(contextMenu); setContextMenu(null) }}>插入表格</button>
          {onInsertInternalLinkRequest && <button type="button" role="menuitem" onClick={() => { setContextMenu(null); onInsertInternalLinkRequest() }}>插入内部链接</button>}
          <button type="button" role="menuitem" onClick={() => insertSnippet(markdownSnippets.link)}>插入超链接</button>
          <button type="button" role="menuitem" onClick={() => insertSnippet(markdownSnippets.image)}>插入图片</button>
          <button type="button" role="menuitem" onClick={() => insertSnippet(markdownSnippets.code)}>插入代码块</button>
          <button type="button" role="menuitem" onClick={() => insertSnippet(markdownSnippets.quote)}>插入引用</button>
          <button type="button" role="menuitem" onClick={() => insertSnippet(markdownSnippets.task)}>插入任务项</button>
          <button type="button" role="menuitem" onClick={() => insertSnippet(markdownSnippets.divider)}>插入分隔线</button>
        </div>
      )}
      {tableDialog && (
        <TableEditorDialog
          initialRows={tableDialog.table?.cells.length ?? tableRows}
          initialColumns={tableDialog.table?.cells[0]?.length ?? tableColumns}
          initialCells={tableDialog.table?.cells}
          initialAlignments={tableDialog.table?.alignments}
          onCancel={() => setTableDialog(null)}
          onInsert={applyTable}
        />
      )}
    </div>
  )
})

function applyMarkdownStyle(
  view: EditorView,
  style: MarkdownSelectionStyle,
  readOnly: Readonly<{ current: boolean }>,
  barrierDepth: Readonly<{ current: number }>,
) {
  if (readOnly.current || barrierDepth.current > 0) return false
  const selection = view.state.selection.main
  const source = view.state.doc.toString()
  const result = formatMarkdownSelection(source, selection.from, selection.to, style)
  if (result.markdown === source) return false
  const trailingLength = source.length - selection.to
  const insert = result.markdown.slice(selection.from, result.markdown.length - trailingLength)
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: EditorSelection.range(result.from, result.to),
  })
  view.focus()
  return true
}

function selectionsOverlap(left: Pick<PendingPaste, 'from' | 'to'>, right: Pick<PendingPaste, 'from' | 'to'>) {
  const leftPoint = left.from === left.to
  const rightPoint = right.from === right.to
  if (leftPoint && rightPoint) return left.from === right.from
  if (leftPoint) return left.from >= right.from && left.from <= right.to
  if (rightPoint) return right.from >= left.from && right.from <= left.to
  return Math.max(left.from, right.from) < Math.min(left.to, right.to)
}
