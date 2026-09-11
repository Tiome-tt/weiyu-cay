import type { JSONContent } from '@tiptap/core'
import type { RichDocument, RichMark, RichNode } from '../../domain/content'

export interface DocumentHeading {
  level: number
  text: string
  /** Zero-based index among document headings, used by the editor navigation ref. */
  index: number
}

const NODE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  doc: [],
  paragraph: ['textAlign'],
  heading: ['level', 'textAlign'],
  text: [],
  blockquote: [],
  bulletList: [],
  orderedList: ['start'],
  listItem: [],
  taskList: [],
  taskItem: ['checked'],
  codeBlock: ['language'],
  horizontalRule: [],
  hardBreak: [],
  image: ['src', 'alt', 'title'],
  table: [],
  tableRow: [],
  tableCell: ['colspan', 'rowspan', 'colwidth', 'backgroundColor', 'textAlign'],
  tableHeader: ['colspan', 'rowspan', 'colwidth', 'backgroundColor', 'textAlign'],
  internalLink: ['noteId', 'label'],
  attachment: ['entryId', 'label', 'fileName', 'mediaType'],
  rawMarkdown: ['source'],
}

const MARK_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  bold: [],
  italic: [],
  strike: [],
  underline: [],
  code: [],
  highlight: ['color'],
  link: ['href', 'target', 'rel'],
}

function filteredAttributes(
  owner: string,
  attrs: Record<string, unknown> | undefined,
  allowedByOwner: Readonly<Record<string, readonly string[]>>,
  rejectUnknown: boolean,
): Record<string, unknown> | undefined {
  const allowed = allowedByOwner[owner]
  if (!allowed) throw new Error(`Unsupported rich document type: ${owner}`)
  if (!attrs) return undefined
  if (rejectUnknown) {
    const unknown = Object.keys(attrs).find((key) => !allowed.includes(key))
    if (unknown) throw new Error(`Unsupported attribute ${unknown} on rich document ${owner}`)
  }
  const entries = allowed
    .filter((key) => attrs[key] !== null && attrs[key] !== undefined)
    .map((key) => [key, attrs[key]] as const)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function assertSafeMark(mark: RichMark): void {
  if (mark.type !== 'link') return
  const href = mark.attrs?.href
  if (typeof href !== 'string' || !/^(?:https?:\/\/|mailto:)/i.test(href)) {
    throw new Error('Rich document link requires a safe http, https, or mailto URL')
  }
}

function mapMark(mark: RichMark, rejectUnknown: boolean): RichMark {
  const attrs = filteredAttributes(mark.type, mark.attrs, MARK_ATTRIBUTES, rejectUnknown)
  const mapped = attrs ? { type: mark.type, attrs } : { type: mark.type }
  assertSafeMark(mapped)
  return mapped
}

function mapNode(node: RichNode, rejectUnknown: boolean): RichNode {
  if (!NODE_ATTRIBUTES[node.type]) throw new Error(`Unsupported rich document node: ${node.type}`)
  if (node.type === 'text' && typeof node.text !== 'string') {
    throw new Error('Rich document text nodes require text')
  }
  if (node.type !== 'text' && node.text !== undefined) {
    throw new Error(`Rich document node ${node.type} cannot contain a text property`)
  }

  const sourceAttrs = normalizeNodeAttributes(node)
  const attrs = filteredAttributes(node.type, sourceAttrs, NODE_ATTRIBUTES, rejectUnknown)
  const content = node.content?.map((child) => mapNode(child, rejectUnknown))
  const marks = node.marks?.map((mark) => mapMark(mark, rejectUnknown))
  const mapped: RichNode = {
    type: node.type,
    ...(attrs ? { attrs } : {}),
    ...(content && content.length > 0 ? { content } : {}),
    ...(node.type === 'text' ? { text: node.text } : {}),
    ...(marks && marks.length > 0 ? { marks } : {}),
  }
  if (mapped.type === 'image') {
    const src = mapped.attrs?.src
    if (typeof src !== 'string' || !/^assets\/screenshot-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/i.test(src)) {
      throw new Error('Rich document image requires a managed screenshot asset source')
    }
  }
  return mapped
}

/** Older table payloads sometimes stored null, fractional, or mismatched colwidth
 * hints. These are only layout metadata, so dropping invalid hints preserves cell
 * text while allowing the strict Rust validator to accept the document again. */
function normalizeNodeAttributes(node: RichNode): Record<string, unknown> | undefined {
  if (!node.attrs || !['tableCell', 'tableHeader'].includes(node.type)) return node.attrs
  const widths = node.attrs.colwidth
  if (widths === undefined) return node.attrs
  const colspan = typeof node.attrs.colspan === 'number' && Number.isInteger(node.attrs.colspan) && node.attrs.colspan > 0
    ? node.attrs.colspan
    : 1
  const valid = Array.isArray(widths)
    && widths.length === colspan
    && widths.every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4096)
  if (valid) return node.attrs
  const normalized = { ...node.attrs }
  delete normalized.colwidth
  return normalized
}

function assertDocumentRoot(root: RichNode): void {
  if (root.type !== 'doc') throw new Error(`Rich document root must be doc, received ${root.type}`)
}

/** Convert the durable app schema to Tiptap JSON without widening the schema. */
export function toTiptapJson(document: RichDocument): JSONContent {
  if (document.schemaVersion !== 1) throw new Error(`Unsupported rich document schema version: ${document.schemaVersion}`)
  assertDocumentRoot(document.root)
  return mapNode(document.root, true) as JSONContent
}

/** Convert editor JSON back to the strict, versioned app schema. */
export function fromTiptapJson(value: JSONContent): RichDocument {
  const root = mapNode(value as RichNode, false)
  assertDocumentRoot(root)
  return { schemaVersion: 1, root }
}

function nodeText(node: RichNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'internalLink' || node.type === 'attachment') {
    const label = node.attrs?.label
    return typeof label === 'string' ? label : ''
  }
  if (node.type === 'rawMarkdown') {
    const source = node.attrs?.source
    return typeof source === 'string' ? source : ''
  }
  return (node.content ?? []).map(nodeText).join('')
}

/** Search/autosave projection. The structured document remains the source of truth. */
export function documentPlainText(document: RichDocument): string {
  const blocks: string[] = []
  const visit = (node: RichNode) => {
    if (['paragraph', 'heading', 'codeBlock', 'tableCell', 'tableHeader', 'rawMarkdown'].includes(node.type)) {
      const text = nodeText(node).trimEnd()
      if (text) blocks.push(text)
      return
    }
    node.content?.forEach(visit)
  }
  visit(document.root)
  return blocks.join('\n')
}

export function documentOutline(document: RichDocument): DocumentHeading[] {
  const result: DocumentHeading[] = []
  const visit = (node: RichNode) => {
    if (node.type === 'heading') {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1
      result.push({ level, text: nodeText(node), index: result.length })
    }
    node.content?.forEach(visit)
  }
  visit(document.root)
  return result
}

/** Parse clipboard TSV, including Excel-style quoted fields and empty trailing cells. */
export function parseTsv(source: string): string[][] {
  const rows: string[][] = [[]]
  let field = ''
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === '\t' && !quoted) {
      rows[rows.length - 1]?.push(field)
      field = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      rows[rows.length - 1]?.push(field)
      rows.push([])
      field = ''
    } else {
      field += character
    }
  }

  rows[rows.length - 1]?.push(field)
  if (rows.length > 1 && rows[rows.length - 1]?.length === 1 && rows[rows.length - 1]?.[0] === '' && /(?:\r\n|\r|\n)$/.test(source)) {
    rows.pop()
  }
  return rows
}

export function tsvTableContent(rows: string[][]): JSONContent {
  const width = Math.max(1, ...rows.map((row) => row.length))
  return {
    type: 'table',
    content: rows.map((row) => ({
      type: 'tableRow',
      content: Array.from({ length: width }, (_, column) => ({
        type: 'tableCell',
        attrs: { colspan: 1, rowspan: 1 },
        content: [{
          type: 'paragraph',
          ...(row[column] ? { content: [{ type: 'text', text: row[column] }] } : {}),
        }],
      })),
    })),
  }
}
