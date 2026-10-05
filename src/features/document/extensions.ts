import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { BlockNumbers } from './blockNumbers'
import { Extension, Mark, Node, mergeAttributes, type Editor, type NodeViewRendererProps } from '@tiptap/core'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TextAlign from '@tiptap/extension-text-align'
import StarterKit from '@tiptap/starter-kit'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import type { NoteId } from '../../domain/model'
import { readImageAsset } from '../content/imageAssetLoader'
import { pasteTsvAtSelection } from './tablePaste'
import { renderLatex } from './math'
import { isRichFontFamily, isRichFontSize, richFontFamilyCss, richFontSizeCss, type RichFontFamily, type RichFontSize } from './font'

export { pasteTsvAtSelection } from './tablePaste'

export interface RichAssetWriter {
  saveImage(input: { noteId: NoteId; mediaType: string; bytes: Uint8Array }): Promise<{ relativePath: string; width: number; height: number }>
}

export interface RichAssetReader {
  readImage(input: { noteId: NoteId; relativePath: string }): Promise<{ mediaType: string; bytes: Uint8Array }>
  readImages?(input: { noteId: NoteId; relativePaths: string[] }): Promise<ReadonlyArray<{ relativePath: string; mediaType: string; bytes: Uint8Array }>>
}

const CELL_COLORS = new Set(['green', 'yellow', 'blue', 'pink', 'purple', 'gray'])
const CELL_ALIGNS = new Set(['left', 'center', 'right'])

export const RichFontMark = Mark.create({
  name: 'font',
  inclusive: false,
  addAttributes() {
    return {
      family: {
        default: null,
        rendered: false,
        parseHTML: (element: HTMLElement) => element.dataset.fontFamily ?? null,
      },
      size: {
        default: null,
        rendered: false,
        parseHTML: (element: HTMLElement) => element.dataset.fontSize ?? null,
      },
    }
  },
  parseHTML() { return [{ tag: 'span[data-rich-font]' }] },
  renderHTML({ mark, HTMLAttributes }) {
    const family = isRichFontFamily(mark.attrs.family) ? mark.attrs.family : undefined
    const size = isRichFontSize(mark.attrs.size) ? mark.attrs.size : undefined
    const style = [
      family ? 'font-family:' + richFontFamilyCss(family) : '',
      size ? 'font-size:' + richFontSizeCss(size) : '',
    ].filter(Boolean).join(';')
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-rich-font': '',
      'data-font-family': family,
      'data-font-size': size,
      ...(style ? { style } : {}),
    }), 0]
  },
})


function cellAttributes() {
  return {
    backgroundColor: {
      default: null,
      parseHTML: (element: HTMLElement) => element.dataset.backgroundColor ?? null,
      renderHTML: (attrs: Record<string, unknown>) => CELL_COLORS.has(String(attrs.backgroundColor))
        ? { 'data-background-color': attrs.backgroundColor }
        : {},
    },
    textAlign: {
      default: null,
      parseHTML: (element: HTMLElement) => element.dataset.textAlign ?? null,
      renderHTML: (attrs: Record<string, unknown>) => CELL_ALIGNS.has(String(attrs.textAlign))
        ? { 'data-text-align': attrs.textAlign }
        : {},
    },
  }
}

const RichTableCell = TableCell.extend({
  addAttributes() { return { ...this.parent?.(), ...cellAttributes() } },
})

const RichTableHeader = TableHeader.extend({
  addAttributes() { return { ...this.parent?.(), ...cellAttributes() } },
})

function mathNodeView(displayMode: boolean) {
  return ({ node }: NodeViewRendererProps) => {
    const dom = document.createElement(displayMode ? 'div' : 'span')
    dom.className = displayMode ? 'rich-document__math rich-document__math--display' : 'rich-document__math'
    dom.dataset.richMath = displayMode ? 'block' : 'inline'
    dom.dataset.latex = String(node.attrs.latex ?? '')
    dom.contentEditable = 'false'

    const update = (nextNode: NodeViewRendererProps['node']) => {
      dom.dataset.latex = String(nextNode.attrs.latex ?? '')
      dom.innerHTML = renderLatex(String(nextNode.attrs.latex ?? ''), displayMode)
    }
    update(node)
    return {
      dom,
      update(updatedNode: NodeViewRendererProps['node']) {
        if (updatedNode.type.name !== (displayMode ? 'mathBlock' : 'math')) return false
        update(updatedNode)
        return true
      },
    }
  }
}

export const MathInlineNode = Node.create({
  name: 'math',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      latex: { default: '', rendered: false, parseHTML: (element: HTMLElement) => element.dataset.latex ?? element.textContent ?? '' },
    }
  },
  parseHTML() { return [{ tag: 'span[data-rich-math="inline"]' }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-rich-math': 'inline',
      'data-latex': node.attrs.latex,
      class: 'rich-document__math',
      contenteditable: 'false',
    }), node.attrs.latex]
  },
  addNodeView() { return mathNodeView(false) },
})

export const MathBlockNode = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  addAttributes() {
    return {
      latex: { default: '', rendered: false, parseHTML: (element: HTMLElement) => element.dataset.latex ?? element.textContent ?? '' },
    }
  },
  parseHTML() { return [{ tag: 'div[data-rich-math="block"]' }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-rich-math': 'block',
      'data-latex': node.attrs.latex,
      class: 'rich-document__math rich-document__math--display',
      contenteditable: 'false',
    }), node.attrs.latex]
  },
  addNodeView() { return mathNodeView(true) },
})

const SubscriptMark = Mark.create({
  name: 'subscript',
  excludes: 'superscript',
  parseHTML() { return [{ tag: 'sub' }] },
  renderHTML({ HTMLAttributes }) { return ['sub', mergeAttributes(HTMLAttributes)] },
})

const SuperscriptMark = Mark.create({
  name: 'superscript',
  excludes: 'subscript',
  parseHTML() { return [{ tag: 'sup' }] },
  renderHTML({ HTMLAttributes }) { return ['sup', mergeAttributes(HTMLAttributes)] },
})
export const InternalLinkNode = Node.create({
  name: 'internalLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      noteId: { default: null, rendered: false, parseHTML: (element: HTMLElement) => element.dataset.noteId ?? null },
      label: { default: '', rendered: false, parseHTML: (element: HTMLElement) => element.dataset.label ?? element.textContent ?? '' },
    }
  },
  parseHTML() { return [{ tag: 'span[data-rich-internal-link]' }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-rich-internal-link': '',
      'data-note-id': node.attrs.noteId,
      'data-label': node.attrs.label,
      class: 'rich-document__internal-link',
      role: 'link',
      tabindex: '0',
    }), node.attrs.label]
  },
})

export const AttachmentNode = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      entryId: { default: null, rendered: false, parseHTML: (element: HTMLElement) => element.dataset.entryId ?? null },
      label: { default: '', rendered: false, parseHTML: (element: HTMLElement) => element.dataset.label ?? '' },
      fileName: { default: null, rendered: false, parseHTML: (element: HTMLElement) => element.dataset.fileName ?? null },
      mediaType: { default: null, rendered: false, parseHTML: (element: HTMLElement) => element.dataset.mediaType ?? null },
    }
  },
  parseHTML() { return [{ tag: 'div[data-rich-attachment]' }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, {
      'data-rich-attachment': '',
      'data-entry-id': node.attrs.entryId,
      'data-label': node.attrs.label,
      'data-file-name': node.attrs.fileName,
      'data-media-type': node.attrs.mediaType,
      class: 'rich-document__attachment',
      role: 'link',
      tabindex: '0',
      contenteditable: 'false',
    }), ['span', { class: 'rich-document__attachment-kind' }, '附件'], ['span', {}, node.attrs.label || node.attrs.fileName || '未命名附件']]
  },
})

export const RawMarkdownNode = Node.create({
  name: 'rawMarkdown',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() { return { source: { default: '', rendered: false, parseHTML: (element: HTMLElement) => element.textContent ?? '' } } },
  parseHTML() { return [{ tag: 'pre[data-raw-markdown]' }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['pre', mergeAttributes(HTMLAttributes, {
      'data-raw-markdown': '',
      class: 'rich-document__raw-markdown',
      contenteditable: 'false',
    }), ['code', {}, node.attrs.source]]
  },
})

function managedImage(reader: RichAssetReader | undefined, noteId: NoteId | undefined) {
  return Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        width: {
          default: null,
          parseHTML: (element: HTMLElement) => {
            const raw = element.dataset.imageWidth ?? element.getAttribute('width') ?? ''
            const width = Number(raw)
            return Number.isFinite(width) && Number.isInteger(width) && width >= 120 && width <= 4096 ? width : null
          },
          renderHTML: (attrs: Record<string, unknown>) => {
            const width = attrs.width
            return typeof width === 'number' && Number.isInteger(width) && width >= 120 && width <= 4096
              ? { 'data-image-width': String(width), width: String(width) }
              : {}
          },
        },
      }
    },
    addNodeView() {
      return (props) => {
        const container = document.createElement('figure')
        container.className = 'rich-document__image-node'
        container.contentEditable = 'false'
        const image = document.createElement('img')
        image.draggable = false
        image.decoding = 'async'
        const handle = document.createElement('button')
        handle.type = 'button'
        handle.className = 'rich-document__image-resize-handle'
        handle.setAttribute('aria-label', '调整图片大小')
        handle.title = '拖动调整图片大小'
        let currentNode = props.node
        let objectUrl: string | undefined
        let generation = 0
        let loadRequested = false
        let destroyed = false

        const applyNodeAttributes = () => {
          image.alt = typeof currentNode.attrs.alt === 'string' ? currentNode.attrs.alt : ''
          image.dataset.simpleNotesImagePath = String(currentNode.attrs.src).trim()
          const width = currentNode.attrs.width
          if (typeof width === 'number' && Number.isInteger(width) && width >= 120 && width <= 4096) {
            image.style.width = width + 'px'
            image.dataset.simpleNotesImageWidth = String(width)
            image.dataset.imageWidth = String(width)
            container.style.width = width + 'px'
            container.style.maxWidth = '100%'
          } else {
            image.style.removeProperty('width')
            delete image.dataset.simpleNotesImageWidth
            delete image.dataset.imageWidth
            container.style.removeProperty('width')
            container.style.removeProperty('max-width')
          }
        }
        const load = async () => {
          const requested = ++generation
          applyNodeAttributes()
          image.removeAttribute('data-load-error')
          if (objectUrl !== undefined) {
            URL.revokeObjectURL(objectUrl)
            objectUrl = undefined
            image.removeAttribute('src')
          }
          if (reader === undefined || noteId === undefined) {
            const source = String(currentNode.attrs.src).trim()
            if (source !== '') image.src = source
            return
          }
          try {
            const { mediaType, bytes } = await readImageAsset(reader, noteId, String(currentNode.attrs.src))
            if (destroyed || requested !== generation) return
            const nextUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
            if (destroyed || requested !== generation) URL.revokeObjectURL(nextUrl)
            else { objectUrl = nextUrl; image.src = nextUrl }
          } catch {
            if (!destroyed && requested === generation) image.setAttribute('data-load-error', 'true')
          }
        }

        const requestLoad = () => {
          if (loadRequested || destroyed) return
          loadRequested = true
          void load()
        }

        const imagePosition = () => typeof props.getPos === 'function' ? props.getPos() : undefined
        const setWidth = (width: number) => {
          const position = imagePosition()
          if (position === undefined) return
          props.editor.chain().focus().setNodeSelection(position).updateAttributes('image', { width: Math.round(width) }).run()
        }
        const stopResize = () => {
          window.removeEventListener('pointermove', moveResize)
          window.removeEventListener('pointerup', stopResize)
          window.removeEventListener('pointercancel', stopResize)
        }
        const moveResize = (event: PointerEvent) => {
          if (destroyed) return
          event.preventDefault()
          const start = resizeState
          if (start === null) return
          const parentWidth = image.parentElement?.parentElement?.getBoundingClientRect().width ?? 0
          const maxWidth = Math.max(start.width, parentWidth > 0 ? parentWidth : 1400)
          setWidth(Math.max(120, Math.min(maxWidth, start.width + event.clientX - start.x)))
        }
        let resizeState: { x: number; width: number } | null = null
        handle.addEventListener('pointerdown', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const width = image.getBoundingClientRect().width || Number(currentNode.attrs.width) || 480
          resizeState = { x: event.clientX, width }
          const position = imagePosition()
          if (position !== undefined) props.editor.chain().focus().setNodeSelection(position).run()
          window.addEventListener('pointermove', moveResize)
          window.addEventListener('pointerup', stopResize)
          window.addEventListener('pointercancel', stopResize)
        })
        container.append(image)
        if (props.editor.isEditable) container.append(handle)
        requestLoad()

        return {
          dom: container,
          selectNode() { container.classList.add('ProseMirror-selectednode') },
          deselectNode() { container.classList.remove('ProseMirror-selectednode') },
          update(updatedNode) {
            if (updatedNode.type.name !== 'image') return false
            const sourceChanged = String(updatedNode.attrs.src) !== String(currentNode.attrs.src)
            currentNode = updatedNode
            applyNodeAttributes()
            if (sourceChanged) {
              loadRequested = false
              requestLoad()
            }
            return true
          },
          destroy() {
            destroyed = true
            generation += 1
            stopResize()
            if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
          },
        }
      }
    },
  })
}

function clipboardExtension(): Extension {
  return Extension.create({
    name: 'cayClipboardTable',
    addProseMirrorPlugins() {
      return [new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const clipboard = event.clipboardData
            const html = clipboard?.getData('text/html') ?? ''
            const text = clipboard?.getData('text/plain') ?? ''
            if (html || !text.includes('\t')) return false
            return pasteTsvAtSelection(this.editor, text)
          },
        },
      })]
    },
  })
}

const RichHeading = Node.create({
  name: 'heading',
  group: 'block',
  content: 'inline*',
  defining: true,
  addOptions() {
    return {
      levels: [1, 2, 3, 4, 5, 6],
      HTMLAttributes: {},
    }
  },
  addAttributes() {
    return {
      sourceMarker: {default:false, rendered:false},
      level: {
        default: 1,
        parseHTML: (element: HTMLElement) => {
          const level = Number(element.tagName.slice(1))
          return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1
        },
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-heading-level': attributes.level }),
      },
    }
  },
  parseHTML() {
    return [1, 2, 3, 4, 5, 6].map((level) => ({ tag: 'h' + String(level) }))
  },
  renderHTML({ node, HTMLAttributes }) {
    const level = Number(node.attrs.level)
    return ['h' + String(Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1), mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
  },
  addCommands() {
    return {
      setHeading: (attributes: { level: 1 | 2 | 3 | 4 | 5 | 6 }) => ({ commands, tr, state, dispatch }) => {
        if (!this.options.levels.includes(attributes.level)) return false
        const position = state.selection.$from
        if (position.parent.type.name === 'heading' && position.parent.attrs.sourceMarker) {
          const prefix = position.parent.textContent.match(/^#{1,6} ?/)?.[0] ?? ''
          if (dispatch) {
            tr.insertText('#'.repeat(attributes.level)+' ',position.start(),position.start()+prefix.length)
            tr.setNodeMarkup(position.before(),undefined,{...position.parent.attrs,...attributes})
          }
          return true
        }
        return commands.setNode(this.name, attributes)
      },
      toggleHeading: (attributes: { level: 1 | 2 | 3 | 4 | 5 | 6 }) => ({ commands }) => {
        if (!this.options.levels.includes(attributes.level)) return false
        return commands.toggleNode(this.name, 'paragraph', attributes)
      },
    }
  },
})
/** The source marker is ordinary text in the same content DOM, so native selection,
 * copy and deletion work across the complete heading. It is editor-only metadata. */
const richHeadingLevelExtension = Extension.create({
  name:'richHeadingLevel', priority:1100,
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        decorations: state => {
          const decorations: Decoration[]=[]
          state.doc.descendants((node,pos)=>{
            if(node.type.name!=='heading' || !node.attrs.sourceMarker)return
            const prefix=node.textContent.match(/^#{1,6} ?/)?.[0]??''
            if(!prefix)return
            const active=this.editor.isFocused && state.selection.from<=pos+node.nodeSize && state.selection.to>=pos
            decorations.push(Decoration.inline(pos+1,pos+1+prefix.length,{class:'rich-document__source-prefix'+(active?'':' is-hidden')}))
          })
          return DecorationSet.create(state.doc,decorations)
        },
        handleKeyDown: (view,event) => {
          const selection=view.state.selection
          if(event.key === 'Enter' && !view.composing && this.editor.isEditable && selection.empty && selection.$from.parent.type.name === 'heading' && selection.$from.parentOffset === 0) {
            const before = selection.$from.before()
            const tr = view.state.tr.insert(before, view.state.schema.nodes.paragraph.create())
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, before + 1)).scrollIntoView())
            return true
          }
          if(event.key !== 'Backspace' || view.composing || !this.editor.isEditable || !selection.empty || selection.$from.parent.type.name !== 'heading' || selection.$from.parentOffset !== 0) return false
          const node=selection.$from.parent, tr=view.state.tr
          const prefix=node.attrs.sourceMarker ? node.textContent.match(/^#{1,6} ?/)?.[0] ?? '' : ''
          if(prefix)tr.delete(selection.from,selection.from+prefix.length)
          view.dispatch(tr.setNodeMarkup(selection.$from.before(),view.state.schema.nodes.paragraph,{textAlign:node.attrs.textAlign??null}))
          return true
        },
        handleTextInput: (view,from,to,text) => {
          if (!this.editor.isEditable || view.composing || from !== to || text !== '#') return false
          const position=view.state.doc.resolve(from)
          if(position.parent.type.name !== 'paragraph' || position.parentOffset !== 0) return false
          view.dispatch(view.state.tr.insertText(text,from,to).setNodeMarkup(position.before(),view.state.schema.nodes.heading,{...position.parent.attrs,level:1,sourceMarker:true}))
          return true
        },
      },
      appendTransaction: (transactions,_old,state) => {
        if(!transactions.some(transaction=>transaction.docChanged)) return null
        const tr=state.tr
        state.doc.descendants((node,pos)=>{
          if(node.type.name !== 'heading') return
          const prefix=node.textContent.match(/^(#{1,6})(?: |$)/)
          if(!node.attrs.sourceMarker) {
            tr.insertText('#'.repeat(Number(node.attrs.level))+' ',tr.mapping.map(pos+1))
            tr.setNodeMarkup(tr.mapping.map(pos),undefined,{...node.attrs,sourceMarker:true})
          } else if(!prefix) {
            // A partially edited marker still determines its level without a separator.
            const hashes=node.textContent.match(/^(#{1,6})/)
            if(!hashes || Number(node.attrs.level)!==hashes[1].length) tr.setNodeMarkup(tr.mapping.map(pos),hashes?undefined:state.schema.nodes.paragraph,hashes?{...node.attrs,level:hashes[1].length}:{textAlign:node.attrs.textAlign ?? null})
          } else if(Number(node.attrs.level)!==prefix[1].length) tr.setNodeMarkup(tr.mapping.map(pos),undefined,{...node.attrs,level:prefix[1].length})
        })
        return tr.steps.length ? tr : null
      },
    })]
  },
})
export interface RichEditorExtensionOptions {
  noteId?: NoteId
  assetReader?: RichAssetReader
}

export function richEditorExtensions(options: RichEditorExtensionOptions = {}) {
  return [
    StarterKit.configure({
      heading: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
    }),
    RichHeading.configure({ levels: [1, 2, 3, 4, 5, 6], HTMLAttributes: { 'data-rich-heading': 'true' } }),
    Highlight.configure({ multicolor: true }),
    richHeadingLevelExtension,
    BlockNumbers,
    managedImage(options.assetReader, options.noteId),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true, allowTableNodeSelection: true }),
    TableRow,
    RichTableHeader,
    RichTableCell,
    InternalLinkNode,
    AttachmentNode,
    RawMarkdownNode,
    MathInlineNode,
    MathBlockNode,
    RichFontMark,
    SubscriptMark,
    SuperscriptMark,
    clipboardExtension(),
  ]
}

const highlightResetPending = new WeakSet<Editor>()

export function toggleYellowHighlight(editor: Editor): boolean {
  const hasSelection = !editor.state.selection.empty
  const applied = editor.chain().toggleHighlight({ color: 'yellow' }).run()
  if (applied && hasSelection) {
    editor.view.dispatch(editor.state.tr.setStoredMarks([]))
    highlightResetPending.add(editor)
  }

  return applied
}

export function splitBlockAfterSelectedHighlight(editor: Editor): boolean {
  const { selection } = editor.state
  const hasSelectedHighlight = !selection.empty && selection.$from.marks().some((mark) => mark.type.name === 'highlight')
  const shouldReset = highlightResetPending.has(editor) || hasSelectedHighlight
  if (!shouldReset) return false
  const applied = editor.commands.splitBlock()
  if (applied) {
    editor.view.dispatch(editor.state.tr.setStoredMarks([]))
    highlightResetPending.delete(editor)
  }
  return applied
}

export function insertTsv(editor: Editor, source: string): boolean {
  return pasteTsvAtSelection(editor, source)
}

export function toggleSubscript(editor: Editor): boolean {
  return editor.chain().focus().toggleMark('subscript').run()
}

export function toggleSuperscript(editor: Editor): boolean {
  return editor.chain().focus().toggleMark('superscript').run()
}

export function setRichFontAttribute(editor: Editor, attribute: 'family' | 'size', value: RichFontFamily | RichFontSize | null): boolean {
  const current = editor.getAttributes('font') as { family?: unknown; size?: unknown }
  const next = { family: current.family ?? null, size: current.size ?? null, [attribute]: value }
  if (next.family === null && next.size === null) return editor.chain().focus().unsetMark('font').run()
  return editor.chain().focus().setMark('font', next).run()
}
