import { createPortal } from 'react-dom'
import { captureFormat, applyFormat, type PaintedFormat } from './formatPainter'
import { FormatMenu } from './FormatMenu'
import { HeadingStyleMenu } from './HeadingStyleMenu'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor as TiptapEditor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react'
import type { RichDocument } from '../../domain/content'
import type { SystemPort } from '../../domain/ports'
import type { Folder, NoteId, NoteSummary } from '../../domain/model'
import { Icon } from '../../shared/Icon'
import type { RichAssetReader, RichAssetWriter } from './extensions'
import { richEditorExtensions, setRichFontAttribute, splitBlockAfterSelectedHighlight, toggleSubscript, toggleSuperscript, toggleYellowHighlight } from './extensions'
import { fromTiptapJson, toTiptapJson } from './schema'
import { RICH_FONT_FAMILY_OPTIONS, RICH_FONT_SIZE_SUGGESTIONS, richFontSizePoints, type RichFontFamily, type RichFontSize } from './font'
import { PendingAssetWrites } from './PendingAssetWrites'
import { InternalLinkDialog } from '../editor/InternalLinkDialog'
import { ErrorNotification } from '../../shared/notifications'
import { documentBlockCount } from './documentBlockCount'
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
  onSelectionChange?(text: string): void
  onBlockCountChange?(count: number): void
  editable?: boolean
  noteId?: NoteId
  folders?: Folder[]
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

/** A delayed insert must not replace an image selected by an earlier insert. */
function insertSavedImage(editor:TiptapEditor,src:string,alt:string):void {
  const selection=editor.state.selection
  if(selection instanceof NodeSelection && selection.node.type.name==='image') {
    editor.commands.insertContentAt(selection.to,{type:'image',attrs:{src,alt}})
  } else editor.commands.setImage({src,alt})
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
export function chooseTablePickerSide(input: { triggerLeft: number; triggerRight: number; pickerWidth: number; viewportWidth: number; gap?: number }): 'left' | 'right' {
  const gap = input.gap ?? 6
  const fitsRight = input.triggerRight + gap + input.pickerWidth <= input.viewportWidth
  const fitsLeft = input.triggerLeft - gap - input.pickerWidth >= 0
  return fitsRight || !fitsLeft ? 'right' : 'left'
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
  onSelectionChange,
  onBlockCountChange,
  editable = true,
  noteId,
  folders,
  assets,
  assetReader,
  links,
  onNavigateNote,
  onNavigateEntry,
  external,
}, ref) {
  const selectionRef = useRef(onSelectionChange)
  selectionRef.current = onSelectionChange
  const blockCountRef = useRef(onBlockCountChange)
  blockCountRef.current = onBlockCountChange
  const emittedJson = useRef(JSON.stringify(toTiptapJson(value)))
  const editorInstanceRef = useRef<TiptapEditor | null>(null)
  const composing = useRef(false)
  const [linkTargets, setLinkTargets] = useState<NoteSummary[]>([])
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const pendingBlockInsertionRef=useRef<number|null>(null)
  const insertPopupRef=useRef<HTMLDivElement>(null)
  const imagePickerRef=useRef<HTMLInputElement>(null)
  const [insertAnchor,setInsertAnchor]=useState({left:0,top:0})
  const [urlDialog,setUrlDialog]=useState<{url:string;text:string}|null>(null)
  const [insertOpen, setInsertOpen] = useState(false)
  const [tablePickerOpen, setTablePickerOpen] = useState(false)
  const [tablePickerSize, setTablePickerSize] = useState({ rows: 0, cols: 0 })
  const [hoverBlock, setHoverBlock] = useState<{number:string;top:number;left:number;visible:boolean;position:number}>({number:'',top:0,left:0,visible:false,position:0})
  const paintRef = useRef<PaintedFormat | null>(null)
  const [painting, setPainting] = useState(false)
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false)
  const insertMenuRef = useRef<HTMLDivElement>(null)
  const tablePickerRef = useRef<HTMLDivElement>(null)
  const [tablePickerSide, setTablePickerSide] = useState<'left' | 'right'>('right')
  const [contextPosition, setContextPosition] = useState<{ x: number; y: number } | null>(null)
  const [contextMenuKind, setContextMenuKind] = useState<'default' | 'image'>('default')
  const contextImageRef = useRef<string | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [tableSelectTarget, setTableSelectTarget] = useState<{ table: HTMLTableElement; left: number; top: number } | null>(null)
  const tableDragAnchor = useRef<{ table: HTMLTableElement; cell: HTMLTableCellElement } | null>(null)
  const [, refreshEditorState] = useState(0)
  const [assetError, setAssetError] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [documentZoom, setDocumentZoom] = useState(1)
  const [fontSizeDraft, setFontSizeDraft] = useState('')
  const pendingFontAttributes = useRef<{ family?: string; size?: string } | null>(null)
  const restorePendingFontMarks = (current: TiptapEditor) => {
    const pending = pendingFontAttributes.current
    const font = current.state.schema.marks.font
    if (!pending || !font || !current.state.selection.empty) return
    const marks = current.state.storedMarks ?? current.state.selection.$from.marks()
    current.view.dispatch(current.state.tr.setStoredMarks([
      ...marks.filter((mark) => mark.type !== font),
      font.create(pending),
    ]))
  }
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
        if (event.key !== 'Enter' || currentEditor === null) return false
        return splitBlockAfterSelectedHighlight(currentEditor)
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
          if(editor&&!editor.isDestroyed)insertSavedImage(editor,relativePath,image.name || '粘贴的图片')
        }))
        return true
      },
      handleDOMEvents: {
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
      restorePendingFontMarks(current)
      current.view.dispatch(current.state.tr.setMeta('heading-focus',true))
    },
    onBlur: ({editor:current}) => { current.view.dispatch(current.state.tr.setMeta('heading-focus',false)) },
    onUpdate: ({ editor: current }) => {
      selectionRef.current?.(current.state.doc.textBetween(current.state.selection.from, current.state.selection.to, "\n"))
      const json = current.getJSON()
      blockCountRef.current?.(documentBlockCount(fromTiptapJson(json)))
      emittedJson.current = JSON.stringify(toTiptapJson(fromTiptapJson(json)))
      onChange(fromTiptapJson(json))
      refreshEditorState((revision) => revision + 1)
    },
    onSelectionUpdate: ({ editor: current }) => {
      if(paintRef.current)requestAnimationFrame(()=>{
        const format=paintRef.current
        if(!format||current.isDestroyed)return
        paintRef.current=null
        if(applyFormat(current,format))setPainting(false)
        else paintRef.current=format
      })
      selectionRef.current?.(current.state.doc.textBetween(current.state.selection.from, current.state.selection.to, "\n"))
      refreshEditorState((revision) => revision + 1)
      setFontSizeDraft(String(richFontSizePoints(current.getAttributes('font').size) ?? 11))
    },
  })

  useEffect(() => {
    editorInstanceRef.current = editor
    if (editor) blockCountRef.current?.(documentBlockCount(fromTiptapJson(editor.getJSON())))
    return () => {
      if (editorInstanceRef.current === editor) editorInstanceRef.current = null
    }
  }, [editor])

  useEffect(() => { editor?.setEditable(editable) }, [editable, editor])
  useEffect(() => {
    if(!painting)return
    const cancel=(event:KeyboardEvent)=>{if(event.key==='Escape'){paintRef.current=null;setPainting(false)}}
    window.addEventListener('keydown',cancel)
    return()=>window.removeEventListener('keydown',cancel)
  },[painting])


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
    blockCountRef.current?.(documentBlockCount(fromTiptapJson(editor.getJSON())))
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
      if (!insertMenuRef.current?.contains(event.target as Node) && !insertPopupRef.current?.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest('.rich-document__block-controls'))) { pendingBlockInsertionRef.current=null; setInsertOpen(false) }
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  }, [insertOpen])

  useEffect(() => {
    if (!tablePickerOpen) return
    const picker = tablePickerRef.current
    const trigger = picker?.querySelector<HTMLElement>('.rich-document__table-picker-trigger')
    const grid = picker?.querySelector<HTMLElement>('.rich-document__table-picker-grid')
    if (trigger === null || trigger === undefined || grid === null || grid === undefined) return
    const update = () => {
      const triggerRect = trigger.getBoundingClientRect()
      setTablePickerSide(chooseTablePickerSide({
        triggerLeft: triggerRect.left,
        triggerRight: triggerRect.right,
        pickerWidth: grid.getBoundingClientRect().width,
        viewportWidth: window.innerWidth || document.documentElement.clientWidth,
      }))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [tablePickerOpen])

  useEffect(() => {
    if (contextPosition === null) return
    const closeFromOutside = (event: MouseEvent) => {
      const menu = contextMenuRef.current
      if (menu !== null && !menu.contains(event.target as Node)) { contextImageRef.current = null; setContextMenuKind('default'); setContextPosition(null) }
    }
    document.addEventListener('click', closeFromOutside)
    return () => document.removeEventListener('click', closeFromOutside)
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

  const prepareBlockInsertion=useCallback(()=>{
    const position=pendingBlockInsertionRef.current
    pendingBlockInsertionRef.current=null
    if(position!==null && editor && position<=editor.state.doc.content.size) editor.chain().insertContentAt(position,{type:'paragraph'}).setTextSelection(position+1).run()
  },[editor])
  const run = useCallback((command: () => void) => {
    void commitComposition().then(() => {
      setCommandError(null)
      prepareBlockInsertion()
      command()
    }).catch(() => {
      setCommandError('格式操作未完成，请重新选择正文后重试。')
    })
  }, [commitComposition,prepareBlockInsertion])

  const copyImageToClipboard = useCallback(async () => {
    const source = contextImageRef.current
    contextImageRef.current = null
    setContextMenuKind('default')
    setContextPosition(null)
    if (source === null || source === '' || navigator.clipboard?.write === undefined || typeof ClipboardItem === 'undefined') {
      setCommandError('当前环境不支持复制图片。')
      return
    }
    try {
      const response = await fetch(source)
      if (!response.ok && response.type !== 'opaque') throw new Error('image fetch failed')
      const blob = await response.blob()
      const mediaType = blob.type.startsWith('image/') ? blob.type : 'image/png'
      await navigator.clipboard.write([new ClipboardItem({ [mediaType]: blob })])
      setCommandError(null)
    } catch {
      setCommandError('图片复制失败，请重试。')
    }
  }, [])
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
    setFontSizeDraft(String(activeFontSizePoints ?? 11))
  }, [activeFontSizePoints])

  const applyFontSize = (raw: string) => {
    if (!editor) return
    const parsed = Number(raw.trim())
    if (raw.trim() === '' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setFontSizeDraft(String(activeFontSizePoints ?? 11))
      return
    }
    const points = Math.min(96, Math.max(8, parsed))
    setFontSizeDraft(String(points))
    const currentFont = editor.getAttributes('font') as { family?: unknown }
    pendingFontAttributes.current = { ...(typeof currentFont.family === 'string' ? { family: currentFont.family } : {}), size: String(points) }
    setRichFontAttribute(editor, 'size', String(points) as RichFontSize)
    restorePendingFontMarks(editor)
  }

  const insertInternalLinkFromDialog = useCallback((target: NoteSummary) => {
    if (!editor) return false
    return editor.chain().focus().insertContent({
      type: 'internalLink',
      attrs: { noteId: target.id, label: target.title },
    }).run()
  }, [editor])
  if (!editor) return <div className="rich-document" aria-busy="true" />

  const renderInsertionItems=()=> <>
            <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleBulletList().run() }); setInsertOpen(false);setContextPosition(null) }}>项目列表</button>
            <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleOrderedList().run() }); setInsertOpen(false);setContextPosition(null) }}>有序列表</button>
            <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleTaskList().run() }); setInsertOpen(false);setContextPosition(null) }}>待办列表</button>
            <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleBlockquote().run() }); setInsertOpen(false);setContextPosition(null) }}>引用</button>
            <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().toggleCodeBlock().run() }); setInsertOpen(false);setContextPosition(null) }}>代码块</button>
            <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => {
              prepareBlockInsertion()
              const selection = editor.state.selection
              setMathDialog({ mode: 'insert', from: selection.from, to: selection.to, displayMode: false, latex: editor.state.doc.textBetween(selection.from, selection.to, '') })
              setInsertOpen(false);setContextPosition(null)
            }}>公式</button>
            <div ref={tablePickerRef} className="rich-document__table-picker" role="group" aria-label="选择表格大小">
              <button type="button" role="menuitem" className="rich-document__table-picker-trigger" aria-haspopup="grid" aria-expanded={tablePickerOpen} onClick={() => setTablePickerOpen((open) => !open)}>表格</button>
              {tablePickerOpen && <div className="rich-document__table-picker-grid" data-placement={tablePickerSide} role="grid" aria-label="选择表格行列">
                {Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, column) => {
                  const rows = row + 1
                  const cols = column + 1
                  return <button key={rows + '-' + cols} type="button" role="gridcell" aria-label={rows + ' 行 ' + cols + ' 列'} className={rows <= tablePickerSize.rows && cols <= tablePickerSize.cols ? 'is-selected' : ''} onMouseEnter={() => setTablePickerSize({ rows, cols })} onFocus={() => setTablePickerSize({ rows, cols })} onClick={() => {
                    run(() => { editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run() })
                    setTablePickerOpen(false)
                    setInsertOpen(false);setContextPosition(null)
                    setTablePickerSize({ rows: 0, cols: 0 })
                  }} />
                })).flat()}
                <output>{tablePickerSize.rows > 0 ? tablePickerSize.rows + ' × ' + tablePickerSize.cols : '选择行列'}</output>
                  </div>}
            </div>
            {links && <button type="button" role="menuitem" onClick={()=>{prepareBlockInsertion();setLinkPickerOpen(true);setInsertOpen(false);setContextPosition(null)}}>内部链接</button>}
            <button type="button" role="menuitem" onClick={()=>{run(()=>{editor.chain().focus().setHorizontalRule().run()});setInsertOpen(false);setContextPosition(null)}}>分隔线</button>
            <button type="button" role="menuitem" onClick={()=>{prepareBlockInsertion();setUrlDialog({url:'',text:editor.state.doc.textBetween(editor.state.selection.from,editor.state.selection.to,'')});setInsertOpen(false);setContextPosition(null)}}>超链接</button>
            {assets&&noteId&&<button type="button" role="menuitem" onClick={()=>{imagePickerRef.current?.click();setInsertOpen(false);setContextPosition(null)}}>图片</button>}
  </>
  return (
    <section className="rich-document">
      <ErrorNotification error={assetError} />
      <ErrorNotification error={commandError} />
      {editable && <div className={`rich-document__toolbar${toolbarCollapsed ? ' rich-document__toolbar--collapsed' : ''}`} role="toolbar" aria-label="文档格式">
        <button type="button" aria-label="撤销" title="撤销" disabled={!editor.can().undo()} onClick={() => run(() => { editor.chain().focus().undo().run() })}>↶</button>
        <button type="button" aria-label="重做" title="重做" disabled={!editor.can().redo()} onClick={() => run(() => { editor.chain().focus().redo().run() })}>↷</button>
        <span className="rich-document__toolbar-separator" />
        <button type="button" aria-label="格式刷" title={painting ? '选择目标文字应用格式，Esc 取消' : '格式刷'} aria-pressed={painting} onMouseDown={event=>event.preventDefault()} onClick={() => { if (painting) {paintRef.current=null;setPainting(false)} else {paintRef.current=captureFormat(editor);setPainting(true);editor.commands.focus()} }}><svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m11 3 6 6-7 7-6-6zM8 6l6 6M6 12l-3 3c-1 1 0 3-2 3 3 1 5 0 6-2l1-2"/></svg></button>
        <button type="button" aria-label="粗体" title="粗体" aria-pressed={editor.isActive('bold')} onClick={() => run(() => { editor.chain().focus().toggleBold().run() })}><strong>B</strong></button>
        <button type="button" aria-label="斜体" title="斜体" aria-pressed={editor.isActive('italic')} onClick={() => run(() => { editor.chain().focus().toggleItalic().run() })}><em>I</em></button>
        <button type="button" aria-label="下划线" title="下划线" aria-pressed={editor.isActive('underline')} onClick={() => run(() => { editor.chain().focus().toggleUnderline().run() })}><u>U</u></button>
        <button type="button" aria-label="删除线" title="删除线" aria-pressed={editor.isActive('strike')} onClick={() => run(() => { editor.chain().focus().toggleStrike().run() })}><s>S</s></button>
        <button type="button" aria-label="下标" title="下标" aria-pressed={editor.isActive('subscript')} onMouseDown={(event) => event.preventDefault()} onClick={() => run(() => { toggleSubscript(editor) })}>x<sub>2</sub></button>
        <button type="button" aria-label="上标" title="上标" aria-pressed={editor.isActive('superscript')} onMouseDown={(event) => event.preventDefault()} onClick={() => run(() => { toggleSuperscript(editor) })}>x<sup>2</sup></button>
        <button type="button" aria-label="高亮" title="高亮" aria-pressed={editor.isActive('highlight')} onClick={() => run(() => { toggleYellowHighlight(editor); editor.commands.focus() })}><span className="rich-document__highlight-glyph" aria-hidden="true">✎</span></button>

        <HeadingStyleMenu level={editor.isActive('heading') ? Number(editor.getAttributes('heading').level) : 0} onChange={(level) => run(() => {
          if (level) editor.chain().focus().setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run()
          else {
            const position=editor.state.selection.$from
            if(position.parent.type.name==='heading' && position.parent.attrs.sourceMarker) {
              const prefix=position.parent.textContent.match(/^#{1,6} ?/)?.[0] ?? ''
              editor.view.dispatch(editor.state.tr.delete(position.start(),position.start()+prefix.length).setNodeMarkup(position.before(),editor.schema.nodes.paragraph,{textAlign:position.parent.attrs.textAlign??null}))
              editor.commands.focus()
            } else editor.chain().focus().setParagraph().run()
          }
        })} />
        <div className='rich-document__alignment-tools' role='group' aria-label='正文对齐'>
          {richAlignmentOptions.map((option) => <button key={option.value} type='button' aria-label={option.label} title={option.label} aria-pressed={activeTextAlign === option.value} onMouseDown={(event) => event.preventDefault()} onClick={() => run(() => { editor.chain().focus().setTextAlign(option.value).run() })}>
            {richAlignmentIcon(option.value)}
          </button>)}
        </div>
        <FormatMenu label="字体" value={activeFontFamily} options={[{value:'',label:'默认字体'}, ...RICH_FONT_FAMILY_OPTIONS]} onChange={value => run(() => { setRichFontAttribute(editor, 'family', value === '' ? null : value as RichFontFamily) })} />
        <span className='rich-document__font-size-control' role='group' aria-label='字号'>
          <input type='text' inputMode='numeric' aria-label='字号' value={fontSizeDraft} placeholder='11' title='字号（磅）' onMouseDown={(event) => { event.preventDefault(); event.currentTarget.focus() }} onChange={(event) => setFontSizeDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyFontSize(event.currentTarget.value) } else if (event.key === 'Escape') { setFontSizeDraft(String(activeFontSizePoints ?? 11)); event.currentTarget.blur() } }} />
          <FormatMenu compact label="字号选项" value={fontSizeDraft} options={RICH_FONT_SIZE_SUGGESTIONS.map(size => ({value:String(size),label:String(size)}))} onChange={value => {setFontSizeDraft(value);applyFontSize(value)}} />
        </span>        <span className="rich-document__toolbar-separator" />
        <div ref={insertMenuRef} className="rich-document__insert-menu">
          <button type="button" className="rich-document__insert-trigger" aria-label="插入" title="插入" aria-haspopup="menu" aria-expanded={insertOpen} onClick={event => {pendingBlockInsertionRef.current=null; const rect=event.currentTarget.getBoundingClientRect();setInsertAnchor({left:rect.left,top:rect.bottom+6});setInsertOpen(open=>!open)}}><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4.5h8M5 9h8M5 13.5h5M5 18h6" /><path d="M17 11v9m-4.5-4.5h9" /></svg></button>
        </div>
        <button
          type="button"
          className="rich-document__toolbar-toggle"
          aria-label={toolbarCollapsed ? '展开格式工具栏' : '收起格式工具栏'}
          title={toolbarCollapsed ? '展开格式工具栏' : '收起格式工具栏'}
          aria-expanded={!toolbarCollapsed}
          onClick={() => setToolbarCollapsed((collapsed) => !collapsed)}
        >
          {toolbarCollapsed ? <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14M7 3v4M13 8v4M8 13v4" /></svg> : <Icon name="chevron-down" size={15} />}
        </button>
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
{linkPickerOpen && links && (
        <InternalLinkDialog
          currentNoteId={noteId}
          folders={folders ?? []}
          targets={linkTargets}
          onInsert={insertInternalLinkFromDialog}
          onCancel={() => setLinkPickerOpen(false)}
        />
      )}

      {insertOpen && createPortal(<div ref={insertPopupRef} className="rich-document__insert-popover rich-document__block-popover" role="menu" aria-label="插入内容" style={{left:Math.max(8,Math.min(insertAnchor.left,window.innerWidth-240)),top:Math.min(insertAnchor.top,window.innerHeight-360)}} onKeyDown={event=>{if(event.key==='Escape'){pendingBlockInsertionRef.current=null;setInsertOpen(false);editor.commands.focus()}}}>{renderInsertionItems()}</div>,document.body)}
      <input ref={imagePickerRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={event=>{
        const file=event.currentTarget.files?.[0];event.currentTarget.value=''
        if(!file||!assets||!noteId)return
        prepareBlockInsertion()
        pendingAssetWrites.track(file.arrayBuffer().then(bytes=>assets.saveImage({noteId,mediaType:file.type,bytes:new Uint8Array(bytes)})).then(image=>{if(!editor.isDestroyed)insertSavedImage(editor,image.relativePath,file.name)}).catch(()=>setAssetError('图片未能保存，请重试。')))
      }}/>
      {urlDialog&&<form className="rich-document__math-dialog" role="dialog" aria-label="插入超链接" onSubmit={event=>{
        event.preventDefault()
        try { const url=new URL(urlDialog.url); if(!['http:','https:'].includes(url.protocol))throw new Error('protocol') } catch {setCommandError('请输入完整的 http 或 https 链接。');return}
        editor.chain().focus().insertContent({type:'text',text:urlDialog.text.trim()||urlDialog.url,marks:[{type:'link',attrs:{href:urlDialog.url}}]}).run();setUrlDialog(null);setCommandError(null)
      }}><label>显示文字<input aria-label="链接文字" value={urlDialog.text} onChange={event=>setUrlDialog({...urlDialog,text:event.target.value})}/></label><label>地址<input autoFocus aria-label="链接地址" value={urlDialog.url} onChange={event=>setUrlDialog({...urlDialog,url:event.target.value})}/></label><div className="rich-document__math-dialog-actions"><button type="button" onClick={()=>setUrlDialog(null)}>取消</button><button type="submit">插入</button></div></form>}
      <div onPointerUp={() => { requestAnimationFrame(() => { if (paintRef.current && applyFormat(editor,paintRef.current)) { paintRef.current=null; setPainting(false) } }) }} onKeyUp={event => { if (event.key === 'Escape') { paintRef.current=null; setPainting(false) } else if (paintRef.current && applyFormat(editor,paintRef.current)) { paintRef.current=null; setPainting(false) } }} className="rich-document__surface" style={{ "--rich-document-zoom": documentZoom } as CSSProperties} onWheel={handleDocumentZoom} onMouseDown={(event) => {
        if (!editable) return
        const target = event.target instanceof Element ? event.target : null
        const cell = target?.closest<HTMLTableCellElement>("th,td")
        const table = cell?.closest<HTMLTableElement>("table")
        if (cell && table) tableDragAnchor.current = { table, cell }
      }} onMouseMove={event=>{
        handleSurfaceMouseMove(event)
        if(event.target instanceof Element && event.target.closest('.rich-document__block-controls'))return
        const block=event.target instanceof Element?event.target.closest<HTMLElement>('[data-block-number]'):null
        if(block && editor.view.dom.contains(block)) {
          const rect=block.getBoundingClientRect(),content=editor.view.dom.getBoundingClientRect()
          const padding=parseFloat(getComputedStyle(editor.view.dom).paddingLeft)||0
          const next={number:block.dataset.blockNumber??'',top:rect.top,left:content.left+padding-60,visible:true,position:Number(block.dataset.blockPosition??0)}
          setHoverBlock(previous=>previous.number===next.number&&previous.top===next.top&&previous.position===next.position&&previous.visible?previous:next)
        } else setHoverBlock(previous=>{
          // Keep the gutter reachable while the pointer crosses the gap from the block.
          const crossingGutter=event.clientX>=previous.left && event.clientX<=previous.left+60 && event.clientY>=previous.top && event.clientY<=previous.top+24
          return crossingGutter ? previous : {...previous,visible:false}
        })
      }} onScrollCapture={()=>setHoverBlock(previous=>({...previous,visible:false}))} onMouseUp={() => { tableDragAnchor.current = null }} onMouseLeave={() => { setHoverBlock(previous=>({...previous,visible:false})); tableDragAnchor.current = null; setTableSelectTarget(null) }} onContextMenu={(event) => {
        event.preventDefault()
        setInsertOpen(false)
        const target = event.target instanceof Element ? event.target : null
        const image = target?.closest('img.rich-document__image-node, .rich-document__image-node img') as HTMLImageElement | null
        contextImageRef.current = image === null ? null : (image.currentSrc || image.src)
        setContextMenuKind(image === null ? 'default' : 'image')
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
        {editable && <div className={`rich-document__block-controls${hoverBlock.visible||(insertOpen&&pendingBlockInsertionRef.current!==null)?' is-visible':''}`} style={{top:hoverBlock.top,left:hoverBlock.left}} onMouseEnter={()=>setHoverBlock(previous=>({...previous,visible:true}))}>
          <span aria-hidden="true" className="rich-document__block-number">{hoverBlock.number}</span>
          <button type="button" aria-label="添加内容块" title="添加内容块" aria-haspopup="menu" onMouseDown={event=>event.preventDefault()} onClick={event=>{pendingBlockInsertionRef.current=hoverBlock.position;const rect=event.currentTarget.getBoundingClientRect();setInsertAnchor({left:rect.left,top:rect.bottom+6});setInsertOpen(true)}}>+</button>
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
      {contextPosition !== null && <div ref={contextMenuRef} className="rich-document__context-menu" role="menu" aria-label="正文快捷操作" style={{ left: contextPosition.x, top: contextPosition.y }} onContextMenu={(event) => event.preventDefault()} onPointerDown={(event) => event.stopPropagation()}>
        {contextMenuKind === 'image' ? <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); void copyImageToClipboard() }}>复制图片</button> : <>
          {renderInsertionItems()}
          <button type="button" role="menuitem" onClick={() => { run(() => { editor.chain().focus().clearNodes().unsetAllMarks().run() }); setContextPosition(null) }}>清除格式</button>
        </>}
      </div>}
    </section>
  )
})
