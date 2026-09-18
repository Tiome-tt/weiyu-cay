import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor as TiptapEditor } from '@tiptap/core'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react'
import type { RichDocument } from '../../domain/content'
import type { SystemPort } from '../../domain/ports'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { RichAssetReader, RichAssetWriter } from './extensions'
import { RICH_HEADING_NAVIGATION_KEYS, richEditorExtensions, setRichFontAttribute, splitBlockAfterSelectedHighlight, syncRichHeadingMarkers, toggleSubscript, toggleSuperscript, toggleYellowHighlight } from './extensions'
import { fromTiptapJson, toTiptapJson } from './schema'
import { RICH_FONT_FAMILY_OPTIONS, RICH_FONT_SIZE_SUGGESTIONS, richFontSizePoints, type RichFontFamily, type RichFontSize } from './font'
import { PendingAssetWrites } from './PendingAssetWrites'
import './rich-document.css'
import 'katex/dist/katex.min.css'

export interface RichDocumentLinkReader {
  listTargets(): Promise<NoteSummary[]>
}

export interface RichAttachmentCandidate {
  entryId: string
  label: string
  fileName?: string
  mediaType?: string
}

export interface RichDocumentEditorProps {
  value: RichDocument
  onChange(value: RichDocument): void
  editable?: boolean
  noteId?: NoteId
  assets?: RichAssetWriter
  assetReader?: RichAssetReader
  links?: RichDocumentLinkReader
  onNavigateNote?(noteId: NoteId): void | Promise<void>
  onNavigateEntry?(entryId: string): void | Promise<void>
  external?: Pick<SystemPort, 'openExternal'>
}

export interface RichDocumentEditorHandle {
  focus(): void
  navigateToHeading(index: number): void
  commitComposition(): Promise<void>
}

export const RICH_DOCUMENT_ZOOM_MIN = 0.5
export const RICH_DOCUMENT_ZOOM_MAX = 2
export const RICH_DOCUMENT_ZOOM_STEP = 0.1

export function nextRichDocumentZoom(current: number, deltaY: number): number {
  const value = Number.isFinite(current) ? current : 1
  if (!Number.isFinite(deltaY) || deltaY === 0) return Math.min(RICH_DOCUMENT_ZOOM_MAX, Math.max(RICH_DOCUMENT_ZOOM_MIN, value))
  const next = value + (deltaY < 0 ? RICH_DOCUMENT_ZOOM_STEP : -RICH_DOCUMENT_ZOOM_STEP)
  return Math.round(Math.min(RICH_DOCUMENT_ZOOM_MAX, Math.max(RICH_DOCUMENT_ZOOM_MIN, next)) * 10) / 10
}
type RichTextAlignment = 'left' | 'center' | 'right' | 'justify'
const richAlignmentOptions: ReadonlyArray<{ value: RichTextAlignment; label: string }> = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中对齐' },
  { value: 'right', label: '右对齐' },
  { value: 'justify', label: '两端对齐' },
]

function richAlignmentIcon(alignment: RichTextAlignment) {
  const paths = alignment === 'left'
    ? ['M4 6h16', 'M4 10h13', 'M4 14h16', 'M4 18h11']
    : alignment === 'center'
      ? ['M5 6h14', 'M7 10h10', 'M5 14h14', 'M8 18h8']
      : alignment === 'right'
        ? ['M4 6h16', 'M7 10h13', 'M4 14h16', 'M9 18h11']
        : ['M4 6h16', 'M4 10h16', 'M4 14h16', 'M4 18h16']
  return <svg viewBox='0 0 24 24' aria-hidden='true' focusable='false'>{paths.map((path) => <path key={path} d={path} />)}</svg>
}
const CELL_COLORS = [
  { value: 'green', label: '浅绿' },
  { value: 'yellow', label: '浅黄' },
  { value: 'blue', label: '浅蓝' },
  { value: 'pink', label: '浅粉' },
  { value: 'purple', label: '浅紫' },
  { value: 'gray', label: '灰色' },
] as const

export const RichDocumentEditor = forwardRef<RichDocumentEditorHandle, RichDocumentEditorProps>(function RichDocumentEditor({
  value,
  onChange,
  editable = true,
  noteId,
  assets,
  assetReader,
  links,
  onNavigateNote,
  onNavigateEntry,
  external,
}, ref) {
  const emittedJson = useRef(JSON.stringify(toTiptapJson(value)))
  const editorInstanceRef = useRef<TiptapEditor | null>(null)
  const composing = useRef(false)
  const [linkTargets, setLinkTargets] = useState<NoteSummary[]>([])
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const [linkQuery, setLinkQuery] = useState('')
  const [insertOpen, setInsertOpen] = useState(false)
  const [tablePickerOpen, setTablePickerOpen] = useState(false)
  const [tablePickerSize, setTablePickerSize] = useState({ rows: 0, cols: 0 })
  const insertMenuRef = useRef<HTMLDivElement>(null)
  const [contextPosition, setContextPosition] = useState<{ x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [tableSelectTarget, setTableSelectTarget] = useState<{ table: HTMLTableElement; left: number; top: number } | null>(null)
  const tableDragAnchor = useRef<{ table: HTMLTableElement; cell: HTMLTableCellElement } | null>(null)
  const [, refreshEditorState] = useState(0)
  const [assetError, setAssetError] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [documentZoom, setDocumentZoom] = useState(1)
  const [fontSizeDraft, setFontSizeDraft] = useState('')
  const pendingFontAttributes = useRef<{ family?: string; size?: string } | null>(null)
  const [mathDialog, setMathDialog] = useState<{ mode: 'insert' | 'edit'; position?: number; from?: number; to?: number; displayMode: boolean; latex: string } | null>(null)
  const pendingAssetWrites = useMemo(() => new PendingAssetWrites(setAssetError), [])

  const extensions = useMemo(() => richEditorExtensions({ noteId, assetReader }), [assetReader, noteId])
  const editor = useEditor({
    extensions,
    content: toTiptapJson(value),
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': '文档正文',
        'aria-multiline': 'true',
        class: 'rich-document__content',
      },
      handleClickOn: (_view, _position, node, nodePosition, event) => {
        if ((node.type.name === 'math' || node.type.name === 'mathBlock') && editable) {
          setMathDialog({ mode: 'edit', position: nodePosition, displayMode: node.type.name === 'mathBlock', latex: String(node.attrs.latex ?? '') })
          return true
        }
        if (node.type.name === 'internalLink' && onNavigateNote) {
          event.preventDefault()
          void onNavigateNote(node.attrs.noteId as NoteId)
          return true
        }
        if (node.type.name === 'attachment' && onNavigateEntry) {
          event.preventDefault()
          void onNavigateEntry(String(node.attrs.entryId))
          return true
        }
        return false
      },
      handleKeyDown: (_view, event) => {
        const currentEditor = editorInstanceRef.current
        if (currentEditor !== null && RICH_HEADING_NAVIGATION_KEYS.has(event.key)) syncRichHeadingMarkers(currentEditor)
        if (event.key !== 'Enter') return false
        return currentEditor === null ? false : splitBlockAfterSelectedHighlight(currentEditor)
      },
      handlePaste: (_view, event) => {
        if (!assets || !noteId) return false
        const image = Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith('image/'))
        if (!image) return false
        event.preventDefault()
        setAssetError(null)
        pendingAssetWrites.track(image.arrayBuffer().then((buffer) => assets.saveImage({
          noteId,
          mediaType: image.type,
          bytes: new Uint8Array(buffer),
        })).then(({ relativePath }) => {
          editor?.commands.setImage({ src: relativePath, alt: image.name || '粘贴的图片' })
        }))
        return true
      },
      handleDOMEvents: {
        mousedown: () => {
          if (editor) syncRichHeadingMarkers(editor)
          return false
        },
        click: (_view, event) => {
          const target = event.target instanceof Element ? event.target : null
          const internalLink = target?.closest<HTMLElement>('[data-rich-internal-link]')
          const attachment = target?.closest<HTMLElement>('[data-rich-attachment]')
          const externalLink = target?.closest<HTMLAnchorElement>('a[href]')
          const href = externalLink?.getAttribute('href')
          if (href && /^(?:https?:|mailto:)/iu.test(href)) {
            event.preventDefault()
            if (!event.ctrlKey && !event.metaKey) return true
            void external?.openExternal(href)
            return true
          }
          const noteTarget = internalLink?.getAttribute('data-note-id')
          const entryTarget = attachment?.getAttribute('data-entry-id')
          if (noteTarget && onNavigateNote) {
            event.preventDefault()
            void onNavigateNote(noteTarget as NoteId)
            return true
          }
          if (entryTarget && onNavigateEntry) {
            event.preventDefault()
            void onNavigateEntry(entryTarget)
            return true
          }
          return false
        },
        compositionstart: () => { composing.current = true; return false },
        compositionend: () => { composing.current = false; return false },
      },
    },
    onFocus: ({ editor: current }) => {
      const pending = pendingFontAttributes.current
      if (pending && current.schema.marks.font) current.view.dispatch(current.state.tr.setStoredMarks([current.schema.marks.font.create(pending)]))
    },
    onUpdate: ({ editor: current }) => {
      const json = current.getJSON()
      emittedJson.current = JSON.stringify(toTiptapJson(fromTiptapJson(json)))
      onChange(fromTiptapJson(json))
      refreshEditorState((revision) => revision + 1)
    },
    onSelectionUpdate: () => refreshEditorState((revision) => revision + 1),
  })

  useEffect(() => {
    editorInstanceRef.current = editor
    return () => {
      if (editorInstanceRef.current === editor) editorInstanceRef.current = null
    }
  }, [editor])

  useEffect(() => { editor?.setEditable(editable) }, [editable, editor])

  useEffect(() => {
    if (!editor) return
    const next = toTiptapJson(value)
    const nextJson = JSON.stringify(next)
    if (nextJson === emittedJson.current || nextJson === JSON.stringify(editor.getJSON())) return
    emittedJson.current = nextJson
    const selection = editor.state.selection
    const scrollables: HTMLElement[] = []
    let parent: HTMLElement | null = editor.view.dom
    while (parent) {
      scrollables.push(parent)
      parent = parent.parentElement
    }
    const scrollPositions = scrollables.map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }))
    const hadFocus = editor.isFocused
    editor.commands.setContent(next, { emitUpdate: false })
    const maxPosition = editor.state.doc.content.size
    editor.commands.setTextSelection({
      from: Math.min(selection.from, maxPosition),
      to: Math.min(selection.to, maxPosition),
    })
    if (hadFocus) editor.commands.focus()
    for (const position of scrollPositions) {
      position.element.scrollTop = position.top
      position.element.scrollLeft = position.left
    }
    requestAnimationFrame(() => {
      for (const position of scrollPositions) {
        position.element.scrollTop = position.top
        position.element.scrollLeft = position.left
      }
    })
  }, [editor, value])

  useEffect(() => {
    if (!links || !linkPickerOpen) return
    let active = true
    void links.listTargets().then((targets) => {
      if (active) setLinkTargets(targets.filter((target) => target.id !== noteId))
    }).catch(() => {
      if (active) {
        setLinkTargets([])
        setCommandError('无法加载内部链接目标，请重试。')
      }
    })
    return () => { active = false }
  }, [linkPickerOpen, links, noteId])

  useEffect(() => {
    if (!insertOpen) return
    const closeFromOutside = (event: PointerEvent) => {
      if (!insertMenuRef.current?.contains(event.target as Node)) setInsertOpen(false)
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  }, [insertOpen])

  useEffect(() => {
    if (contextPosition === null) return
    const closeFromOutside = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextPosition(null)
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  }, [contextPosition])

  const commitComposition = useCallback(async () => {
    if (editor && composing.current) {
      const hadFocus = editor.isFocused
      editor.view.dom.blur()
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      composing.current = false
      if (hadFocus) editor.commands.focus()
    }
    await pendingAssetWrites.settle()
  }, [editor, pendingAssetWrites])

  useImperativeHandle(ref, () => ({
    focus() { editor?.commands.focus() },
    navigateToHeading(index) {
      if (!editor || index < 0) return
      let headingIndex = 0
      let destination: number | undefined
      editor.state.doc.descendants((node, position) => {
        if (node.type.name !== 'heading') return
        if (headingIndex === index) destination = position + 1
        headingIndex += 1
      })
      if (destination !== undefined) {
        editor.chain().focus().setTextSelection(destination).scrollIntoView().run()
      }
    },
    commitComposition,
  }), [commitComposition, editor])

  const run = useCallback((command: () => void) => {
    void commitComposition().then(() => {
      setCommandError(null)
      command()
    }).catch((error: unknown) => {
      setCommandError(error instanceof Error && error.message ? error.message : '操作未完成，请重试。')
    })
  }, [commitComposition])

  const selectWholeTable = useCallback((table: HTMLTableElement) => {
    if (!editor) return
    const surface = table.closest('.rich-document__surface')
    if (!surface) return
    const tables = Array.from(surface.querySelectorAll<HTMLTableElement>('table'))
    const tableIndex = tables.indexOf(table)
    if (tableIndex < 0) return
    let matchingTablePosition: number | undefined
    let currentTableIndex = 0
    editor.state.doc.descendants((node, position) => {
      if (node.type.name !== 'table') return
      if (currentTableIndex === tableIndex) matchingTablePosition = position
      currentTableIndex += 1
    })
    if (matchingTablePosition === undefined) return
    const tableNode = editor.state.doc.nodeAt(matchingTablePosition)
    if (!tableNode) return
    const cellPositions: number[] = []
    editor.state.doc.nodesBetween(
      matchingTablePosition + 1,
      matchingTablePosition + tableNode.nodeSize - 1,
      (node, position) => {
        if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') cellPositions.push(position)
      },
    )
    const firstCell = cellPositions[0]
    const lastCell = cellPositions[cellPositions.length - 1]
    if (firstCell === undefined || lastCell === undefined) return
    editor.commands.setCellSelection({ anchorCell: firstCell, headCell: lastCell })
    editor.commands.focus()
  }, [editor])

  const selectTableRange = useCallback((table: HTMLTableElement, anchor: HTMLTableCellElement, head: HTMLTableCellElement) => {
    if (!editor) return
    const surface = table.closest('.rich-document__surface')
    if (!surface) return
    const tables = Array.from(surface.querySelectorAll<HTMLTableElement>('table'))
    const tableIndex = tables.indexOf(table)
    if (tableIndex < 0) return
    let matchingTablePosition: number | undefined
    let currentTableIndex = 0
    editor.state.doc.descendants((node, position) => {
      if (node.type.name !== 'table') return
      if (currentTableIndex === tableIndex) matchingTablePosition = position
      currentTableIndex += 1
    })
    if (matchingTablePosition === undefined) return
    const tableNode = editor.state.doc.nodeAt(matchingTablePosition)
    if (!tableNode) return
    const cellPositions: number[] = []
    editor.state.doc.nodesBetween(
      matchingTablePosition + 1,
      matchingTablePosition + tableNode.nodeSize - 1,
      (node, position) => {
        if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') cellPositions.push(position)
      },
    )
    const domCells = Array.from(table.querySelectorAll<HTMLTableCellElement>('th,td'))
    const anchorIndex = domCells.indexOf(anchor)
    const headIndex = domCells.indexOf(head)
    if (anchorIndex < 0 || headIndex < 0 || anchorIndex >= cellPositions.length || headIndex >= cellPositions.length) return
    editor.commands.setCellSelection({ anchorCell: cellPositions[anchorIndex], headCell: cellPositions[headIndex] })
    editor.commands.focus()
  }, [editor])

  const handleDocumentZoom = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) return
    event.preventDefault()
    setDocumentZoom((current) => nextRichDocumentZoom(current, event.deltaY))
  }, [])
  const handleSurfaceMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!editable) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.rich-document__table-select-all')) return
    const table = target?.closest<HTMLTableElement>('table')
    const drag = tableDragAnchor.current
    const cell = target?.closest<HTMLTableCellElement>('th,td')
    if (drag && cell && table === drag.table) {
      event.preventDefault()
      selectTableRange(table, drag.cell, cell)
    }
    if (!table) {
      setTableSelectTarget(null)
      return
    }
    const surfaceRect = event.currentTarget.getBoundingClientRect()
    const tableRect = table.getBoundingClientRect()
    setTableSelectTarget({
      table,
      left: tableRect.left - surfaceRect.left + event.currentTarget.scrollLeft + 2,
      top: tableRect.top - surfaceRect.top + event.currentTarget.scrollTop + 2,
    })
  }, [editable, selectTableRange])

  const activeTextAlign = String(editor?.getAttributes('paragraph').textAlign ?? editor?.getAttributes('heading').textAlign ?? 'left')
  const activeCellTextAlign = String(editor?.getAttributes('tableCell').textAlign ?? editor?.getAttributes('tableHeader').textAlign ?? 'left')
  const activeFont = editor?.getAttributes('font') as { family?: unknown; size?: unknown }
  const activeFontFamily = typeof activeFont?.family === 'string' ? activeFont.family : ''
  const activeFontSize = typeof activeFont?.size === 'string' ? activeFont.size : ''
  const activeFontSizePoints = richFontSizePoints(activeFontSize)

  useEffect(() => {
    setFontSizeDraft(activeFontSizePoints === undefined ? '' : String(activeFontSizePoints))
  }, [activeFontSizePoints])

  const applyFontSize = (raw: string) => {
    if (!editor) return
    const parsed = Number(raw.trim())
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setFontSizeDraft(activeFontSizePoints === undefined ? '' : String(activeFontSizePoints))
      return
    }
    const points = Math.min(96, Math.max(8, parsed))
    setFontSizeDraft(String(points))
    const currentFont = editor.getAttributes('font') as { family?: unknown }
    pendingFontAttributes.current = { ...(typeof currentFont.family === 'string' ? { family: currentFont.family } : {}), size: String(points) }
    setRichFontAttribute(editor, 'size', String(points) as RichFontSize)
  }

  if (!editor) return <div className="rich-document" aria-busy="true" />

  return (
    <section className="rich-document">
      {assetError && <p className="rich-document__error" role="alert">{assetError}</p>}
      {commandError && <p className="rich-document__error" role="alert">{commandError}</p>}
      {editable && <div className="rich-document__toolbar" role="toolbar" aria-label="文档格式">
        <button type="button" aria-label="撤销" disabled={!editor.can().undo()} onClick={() => run(() => { editor.chain().focus().undo().run() })}>↶</button>
        <button type="button" aria-label="重做" disabled={!editor.can().redo()} onClick={() => run(() => { editor.chain().focus().redo().run() })}>↷</button>
        <span className="rich-document__toolbar-separator" />
        <button type="button" aria-label="粗体" aria-pressed={editor.isActive('bold')} onClick={() => run(() => { editor.chain().focus().toggleBold().run() })}><strong>B</strong></button>
        <button type="button" aria-label="斜体" aria-pressed={editor.isActive('italic')} onClick={() => run(() => { editor.chain().focus().toggleItalic().run() })}><em>I</em></button>
        <button type="button" aria-label="下划线" aria-pressed={editor.isActive('underline')} onClick={() => run(() => { editor.chain().focus().toggleUnderline().run() })}><u>U</u></button>
        <button type="button" aria-label="删除线" aria-pressed={editor.isActive('strike')} onClick={() => run(() => { editor.chain().focus().toggleStrike().run() })}><s>S</s></button>
        <button type="button" aria-label="下标" aria-pressed={editor.isActive('subscript')} onMouseDown={(event) => event.preventDefault()} onClick={() => run(() => { toggleSubscript(editor) })}>x<sub>2</sub></button>
        <button type="button" aria-label="上标" aria-pressed={editor.isActive('superscript')} onMouseDown={(event) => event.preventDefault()} onClick={() => run(() => { toggleSuperscript(editor) })}>x<sup>2</sup></button>
        <button type="button" aria-label="高亮" aria-pressed={editor.isActive('highlight')} onClick={() => run(() => { toggleYellowHighlight(editor); editor.commands.focus() })}>高亮</button>

        <span className="rich-document__style-select">
          <select aria-label="段落样式" defaultValue="paragraph" onChange={(event) => {
            const level = Number(event.currentTarget.value)
            run(() => {
              if (level) editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run()
              else editor.chain().focus().setParagraph().run()
            })
          }}>
            <option value="paragraph">正文</option>
            {[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>标题 {level}</option>)}
          </select>
        </span>
        <div className='rich-document__alignment-tools' role='group' aria-label='正文对齐'>
          {richAlignmentOptions.map((option) => <button key={option.value} type='button' aria-label={option.label} title={option.label} aria-pressed={activeTextAlign === option.value} onMouseDown={(event) => event.preventDefault()} onClick={() => run(() => { editor.chain().focus().setTextAlign(option.value).run() })}>
            {richAlignmentIcon(option.value)}
          </button>)}
        </div>        <span className="rich-document__style-select">
          <select aria-label="字体" value={activeFontFamily} onChange={(event) => {
            const value = event.currentTarget.value
            run(() => { setRichFontAttribute(editor, 'family', value === '' ? null : value as RichFontFamily) })
          }}>
            <option value="">默认字体</option>
            {RICH_FONT_FAMILY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </span>
        <span className='rich-document__font-size-control' role='group' aria-label='字号'>
          <input type='number' min='8' max='96' step='1' inputMode='numeric' aria-label='字号' value={fontSizeDraft} placeholder='11' title='字号（磅）' onMouseDown={(event) => { event.preventDefault(); event.currentTarget.focus() }} onChange={(event) => setFontSizeDraft(event.currentTarget.value)} onBlur={(event) => applyFontSize(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyFontSize(event.currentTarget.value) } else if (event.key === 'Escape') { setFontSizeDraft(activeFontSizePoints === undefined ? '' : String(activeFontSizePoints)); event.currentTarget.blur() } }} />
          <select aria-label='字号选项' value={RICH_FONT_SIZE_SUGGESTIONS.includes(Number(fontSizeDraft) as typeof RICH_FONT_SIZE_SUGGESTIONS[number]) ? fontSizeDraft : ''} onChange={(event) => { const value = event.currentTarget.value; setFontSizeDraft(value); applyFontSize(value) }}>
            <option value=''>字号</option>
            {RICH_FONT_SIZE_SUGGESTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </span>        <span className="rich-document__toolbar-separator" />
        <div ref={insertMenuRef} className="rich-document__insert-menu">
          <button type="button" className="rich-document__insert-trigger" aria-label="插入" aria-haspopup="menu" aria-expanded={insertOpen} onClick={() => setInsertOpen((open) => !open)}>插入</button>
          {insertOpen && <div className="rich-document__insert-popover" role="menu" aria-label="插入内容">
            <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleBulletList().run() }); setInsertOpen(false) }}>项目列表</button>
            <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleTaskList().run() }); setInsertOpen(false) }}>待办列表</button>
            <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleBlockquote().run() }); setInsertOpen(false) }}>引用</button>
            <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleCodeBlock().run() }); setInsertOpen(false) }}>代码块</button>
            <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => {
              const selection = editor.state.selection
              setMathDialog({ mode: 'insert', from: selection.from, to: selection.to, displayMode: false, latex: editor.state.doc.textBetween(selection.from, selection.to, '') })
              setInsertOpen(false)
            }}>公式</button>
            <div className="rich-document__table-picker" role="group" aria-label="选择表格大小">
              <button type="button" role="menuitem" className="rich-document__table-picker-trigger" aria-haspopup="grid" aria-expanded={tablePickerOpen} onClick={() => setTablePickerOpen((open) => !open)}>表格</button>
              {tablePickerOpen && <div className="rich-document__table-picker-grid" role="grid" aria-label="选择表格行列">
                {Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, column) => {
                  const rows = row + 1
                  const cols = column + 1
                  return <button key={rows + '-' + cols} type="button" role="gridcell" aria-label={rows + ' 行 ' + cols + ' 列'} className={rows <= tablePickerSize.rows && cols <= tablePickerSize.cols ? 'is-selected' : ''} onMouseEnter={() => setTablePickerSize({ rows, cols })} onFocus={() => setTablePickerSize({ rows, cols })} onClick={() => {
                    run(() => { editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run() })
                    setTablePickerOpen(false)
                    setInsertOpen(false)
                    setTablePickerSize({ rows: 0, cols: 0 })
                  }} />
                })).flat()}
                <output>{tablePickerSize.rows > 0 ? tablePickerSize.rows + ' × ' + tablePickerSize.cols : '选择行列'}</output>
              </div>}
            </div>
            {links && <button type="button" role="menuitem" onClick={() => { setLinkPickerOpen(true); setInsertOpen(false) }}>内部链接</button>}
          </div>}
        </div>
      </div>}

      {mathDialog && <form className="rich-document__math-dialog" aria-label="编辑公式" onSubmit={(event) => {
        event.preventDefault()
        const latex = mathDialog.latex.trim()
        if (!latex) return
        const position = mathDialog.position
        if (mathDialog.mode === 'edit' && position !== undefined) {
          editor.chain().focus().command(({ tr }) => {
            tr.setNodeMarkup(position, undefined, { latex })
            return true
          }).run()
        } else if (mathDialog.from !== undefined && mathDialog.to !== undefined) {
          editor.chain().focus().insertContentAt({ from: mathDialog.from, to: mathDialog.to }, {
            type: mathDialog.displayMode ? 'mathBlock' : 'math',
            attrs: { latex },
          }).run()
        }
        setMathDialog(null)
      }}>
        <label>LaTeX 公式
          <input aria-label="LaTeX 公式" autoFocus value={mathDialog.latex} onChange={(event) => { const latex = event.currentTarget.value; setMathDialog((current) => current ? { ...current, latex } : current) }} placeholder="例如：x_i、\\frac{a}{b} 或 \\sqrt{x}" />
        </label>
        {mathDialog.mode === 'insert' && <label>显示方式
          <select aria-label="公式显示方式" value={mathDialog.displayMode ? 'block' : 'inline'} onChange={(event) => { const displayMode = event.currentTarget.value === 'block'; setMathDialog((current) => current ? { ...current, displayMode } : current) }}>
            <option value="inline">行内公式</option>
            <option value="block">独立公式</option>
          </select>
        </label>}
        <p>支持下标、上标、根号、分式、希腊字母等 LaTeX 语法。</p>
        <div className="rich-document__math-dialog-actions">
          <button type="button" onClick={() => setMathDialog(null)}>取消</button>
          <button type="submit">保存公式</button>
        </div>
      </form>}
{linkPickerOpen && <div className="rich-document__picker" role="dialog" aria-label="选择内部链接">
        <input type="search" aria-label="搜索文档" value={linkQuery} onChange={(event) => setLinkQuery(event.currentTarget.value)} autoFocus />
        {linkTargets.filter((target) => target.title.toLocaleLowerCase().includes(linkQuery.trim().toLocaleLowerCase())).length === 0 ? <p>没有可链接的文档</p> : linkTargets.filter((target) => target.title.toLocaleLowerCase().includes(linkQuery.trim().toLocaleLowerCase())).map((target) => <button type="button" key={target.id} onClick={() => {
          run(() => { editor.chain().focus().insertContent({ type: 'internalLink', attrs: { noteId: target.id, label: target.title } }).run() })
          setLinkPickerOpen(false)
        }}>{target.title}</button>)}
      </div>}

      <div className="rich-document__surface" style={{ "--rich-document-zoom": documentZoom } as CSSProperties} onWheel={handleDocumentZoom} onMouseDown={(event) => {
        if (!editable) return
        const target = event.target instanceof Element ? event.target : null
        const cell = target?.closest<HTMLTableCellElement>("th,td")
        const table = cell?.closest<HTMLTableElement>("table")
        if (cell && table) tableDragAnchor.current = { table, cell }
      }} onMouseMove={handleSurfaceMouseMove} onMouseUp={() => { tableDragAnchor.current = null }} onMouseLeave={() => { tableDragAnchor.current = null; setTableSelectTarget(null) }} onContextMenu={(event) => {
        event.preventDefault()
        setInsertOpen(false)
        setContextPosition({ x: event.clientX, y: event.clientY })
      }}>
        {editor.isActive('table') && editable && <div className="rich-document__table-tools" role="toolbar" aria-label="表格工具">
          <button type="button" onClick={() => run(() => { editor.chain().focus().addRowAfter().run() })}>在下方插入行</button>
          <button type="button" onClick={() => run(() => { editor.chain().focus().addColumnAfter().run() })}>在右侧插入列</button>
          <button type="button" onClick={() => run(() => { editor.chain().focus().deleteRow().run() })}>删除行</button>
          <button type="button" onClick={() => run(() => { editor.chain().focus().deleteColumn().run() })}>删除列</button>
          <button type="button" onClick={() => run(() => { editor.chain().focus().mergeCells().run() })}>合并单元格</button>
          <button type="button" onClick={() => run(() => { editor.chain().focus().splitCell().run() })}>拆分单元格</button>
          <div className='rich-document__alignment-tools rich-document__table-alignment-tools' role='group' aria-label='单元格对齐方式'>
            {richAlignmentOptions.filter((option) => option.value !== 'justify').map((option) => <button key={option.value} type='button' aria-label={option.label} title={option.label} aria-pressed={activeCellTextAlign === option.value} onMouseDown={(event) => event.preventDefault()} onClick={() => run(() => { editor.chain().focus().setCellAttribute('textAlign', option.value).run() })}>
              {richAlignmentIcon(option.value)}
            </button>)}
          </div>
          <span className="rich-document__table-select"><select aria-label="单元格背景色" defaultValue="" onChange={(event) => run(() => { editor.chain().focus().setCellAttribute('backgroundColor', event.currentTarget.value).run() })}>
            <option value="" disabled>背景色</option>{CELL_COLORS.map((color) => <option key={color.value} value={color.value}>{color.label}</option>)}
          </select></span>
        </div>}
        <EditorContent editor={editor} />
        {tableSelectTarget && editable && <button
          type="button"
          className="rich-document__table-select-all"
          aria-label="选择整个表格"
          title="选择整个表格"
          style={{ left: tableSelectTarget.left, top: tableSelectTarget.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => selectWholeTable(tableSelectTarget.table)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3.5 8V4.5H7M17 4.5h3.5V8M20.5 16v3.5H17M7 19.5H3.5V16" />
            <rect x="8" y="8" width="8" height="8" rx="1" />
            <path d="M8 11h8M8 13.5h8M11 8v8M13.5 8v8" />
          </svg>
        </button>}
      </div>
      {contextPosition !== null && <div ref={contextMenuRef} className="rich-document__context-menu" role="menu" aria-label="正文快捷操作" style={{ left: contextPosition.x, top: contextPosition.y }} onContextMenu={(event) => event.preventDefault()}>
        <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleBulletList().run() }); setContextPosition(null) }}>项目列表</button>
        <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleTaskList().run() }); setContextPosition(null) }}>待办列表</button>
        <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() }); setContextPosition(null) }}>插入表格</button>
        <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().clearNodes().unsetAllMarks().run() }); setContextPosition(null) }}>清除格式</button>
      </div>}
    </section>
  )
})
