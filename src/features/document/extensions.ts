import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TextAlign from '@tiptap/extension-text-align'
import StarterKit from '@tiptap/starter-kit'
import { Plugin } from '@tiptap/pm/state'
import type { NoteId } from '../../domain/model'
import { pasteTsvAtSelection } from './tablePaste'

export { pasteTsvAtSelection } from './tablePaste'

export interface RichAssetWriter {
  saveImage(input: { noteId: NoteId; mediaType: string; bytes: Uint8Array }): Promise<{ relativePath: string; width: number; height: number }>
}

export interface RichAssetReader {
  readImage(input: { noteId: NoteId; relativePath: string }): Promise<{ mediaType: string; bytes: Uint8Array }>
}

const CELL_COLORS = new Set(['green', 'yellow', 'blue', 'pink', 'purple', 'gray'])
const CELL_ALIGNS = new Set(['left', 'center', 'right'])

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
  if (!reader || !noteId) return Image
  return Image.extend({
    addNodeView() {
      return ({ node }) => {
        const image = document.createElement('img')
        let currentNode = node
        let objectUrl: string | undefined
        let generation = 0
        let destroyed = false
        const load = async () => {
          const requested = ++generation
          image.alt = typeof currentNode.attrs.alt === 'string' ? currentNode.attrs.alt : ''
          image.removeAttribute('data-load-error')
          if (objectUrl !== undefined) {
            URL.revokeObjectURL(objectUrl)
            objectUrl = undefined
            image.removeAttribute('src')
          }
          try {
            const { mediaType, bytes } = await reader.readImage({ noteId, relativePath: String(currentNode.attrs.src) })
            if (destroyed || requested !== generation) return
            const nextUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mediaType }))
            if (destroyed || requested !== generation) URL.revokeObjectURL(nextUrl)
            else { objectUrl = nextUrl; image.src = nextUrl }
          } catch {
            if (!destroyed && requested === generation) image.setAttribute('data-load-error', 'true')
          }
        }
        void load()
        return {
          dom: image,
          update(updatedNode) {
            if (updatedNode.type !== currentNode.type) return false
            currentNode = updatedNode
            void load()
            return true
          },
          destroy() {
            destroyed = true
            generation += 1
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

export interface RichEditorExtensionOptions {
  noteId?: NoteId
  assetReader?: RichAssetReader
}

export function richEditorExtensions(options: RichEditorExtensionOptions = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true },
    }),
    Highlight.configure({ multicolor: true }),
    managedImage(options.assetReader, options.noteId),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true, allowTableNodeSelection: true }),
    TableRow,
    RichTableHeader,
    RichTableCell,
    InternalLinkNode,
    AttachmentNode,
    RawMarkdownNode,
    clipboardExtension(),
  ]
}

export function insertTsv(editor: Editor, source: string): boolean {
  return pasteTsvAtSelection(editor, source)
}
