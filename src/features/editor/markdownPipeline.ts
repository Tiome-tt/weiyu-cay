import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { isTableMetadataLine, parseMarkdownTable, type MarkdownTableMerge } from './markdownActions'

interface MarkdownNode {
  type?: unknown
  value?: unknown
  alt?: unknown
  children?: unknown
  tagName?: unknown
  properties?: unknown
  position?: {
    start?: { offset?: unknown }
    end?: { offset?: unknown }
  }
}

const parser = unified().use(remarkParse).use(remarkGfm)
const renderer = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeStringify)
const previewRenderer = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(hardenPreviewResources)
  .use(rehypeStringify)

export interface MarkdownHeading {
  line: number
  index: number
  level: number
  text: string
}

/** Use the preview parser so code and HTML never become outline entries. */
export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = []
  const tree = parser.parse(markdown)
  type Node = (typeof tree)['children'][number] | (typeof tree)
  const text = (node: Node): string => {
    if ('value' in node) return node.value
    if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
    if ('children' in node) return node.children.map(text).join('')
    return ''
  }
  const visit = (node: Node) => {
    if (node.type === 'heading') {
      headings.push({ line: node.position!.start.line, index: headings.length, level: node.depth, text: text(node).trim() })
    } else if ('children' in node) {
      node.children.forEach(visit)
    }
  }
  visit(tree)
  return headings
}

export function renderMarkdown(markdown: string): string {
  return String(renderer.processSync(markdown))
}

export function renderPreviewMarkdown(markdown: string): string {
  return String(previewRenderer.processSync(markdown))
}

/**
 * Applies Cay's optional table merge metadata after the sanitized Markdown
 * renderer has produced HTML. The metadata is intentionally interpreted only
 * for tables parsed from the Markdown source; it never enables raw HTML.
 */
export function applyMarkdownTableMerges(root: HTMLElement, markdown: string): void {
  const renderedTables = Array.from(root.querySelectorAll<HTMLTableElement>('table'))
  if (renderedTables.length === 0) return
  const sourceTables = collectMarkdownTables(markdown)
  sourceTables.forEach((sourceTable, index) => {
    const rendered = renderedTables[index]
    if (rendered === undefined || sourceTable.merges === undefined || sourceTable.merges.length === 0) return
    applyTableMerges(rendered, sourceTable.merges)
  })
}

function collectMarkdownTables(markdown: string) {
  const tables: ReturnType<typeof parseMarkdownTable>[] = []
  collectTableNodes(parser.parse(markdown) as MarkdownNode, markdown, tables)
  return tables.filter((table): table is NonNullable<typeof table> => table !== null)
}

function collectTableNodes(node: MarkdownNode, markdown: string, tables: Array<ReturnType<typeof parseMarkdownTable>>) {
  if (node.type === 'table') {
    const range = sourceRange(node)
    if (range !== null) {
      const end = extendTableRangeForMetadata(markdown, range.to)
      tables.push(parseMarkdownTable(markdown.slice(range.from, end)))
    }
  }
  if (!Array.isArray(node.children)) return
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null) collectTableNodes(child as MarkdownNode, markdown, tables)
  }
}

function extendTableRangeForMetadata(markdown: string, tableEnd: number) {
  const lineEnd = markdown.indexOf('\n', tableEnd)
  const nextLineStart = lineEnd < 0 ? tableEnd : lineEnd + 1
  const nextLineEnd = markdown.indexOf('\n', nextLineStart)
  const nextLine = markdown.slice(nextLineStart, nextLineEnd < 0 ? markdown.length : nextLineEnd)
  return isTableMetadataLine(nextLine) ? (nextLineEnd < 0 ? markdown.length : nextLineEnd) : tableEnd
}

function applyTableMerges(table: HTMLTableElement, merges: readonly MarkdownTableMerge[]) {
  const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'))
  const grid: Array<Array<HTMLTableCellElement | undefined>> = []
  rows.forEach((row, rowIndex) => {
    const logicalRow = grid[rowIndex] ?? (grid[rowIndex] = [])
    let column = 0
    for (const cell of Array.from(row.cells)) {
      while (logicalRow[column] !== undefined) column += 1
      const rowSpan = Math.max(1, cell.rowSpan)
      const columnSpan = Math.max(1, cell.colSpan)
      for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
        const targetRow = grid[rowIndex + rowOffset] ?? (grid[rowIndex + rowOffset] = [])
        for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
          targetRow[column + columnOffset] = cell
        }
      }
      column += columnSpan
    }
  })
  for (const merge of merges) {
    const anchor = grid[merge.row]?.[merge.column]
    if (anchor === undefined) continue
    anchor.rowSpan = merge.rowSpan
    anchor.colSpan = merge.columnSpan
    const removed = new Set<HTMLTableCellElement>()
    for (let row = merge.row; row < merge.row + merge.rowSpan; row += 1) {
      for (let column = merge.column; column < merge.column + merge.columnSpan; column += 1) {
        const cell = grid[row]?.[column]
        if (cell !== undefined && cell !== anchor) removed.add(cell)
      }
    }
    for (const cell of removed) cell.remove()
  }
}

function hardenPreviewResources() {
  return (tree: MarkdownNode) => walkPreviewNodes(tree)
}

function walkPreviewNodes(node: MarkdownNode) {
  const tagName = typeof node.type === 'string' && node.type === 'element' && 'tagName' in node
    ? node.tagName
    : undefined
  const properties = 'properties' in node && typeof node.properties === 'object' && node.properties !== null
    ? node.properties as Record<string, unknown>
    : undefined
  if (tagName === 'img' && properties !== undefined) {
    const source = typeof properties.src === 'string' ? properties.src : ''
    delete properties.src
    if (isOwnedAssetReference(source)) properties.dataSimpleNotesAsset = source
    else properties.dataSimpleNotesBlockedImage = true
  }
  if (tagName === 'a' && properties !== undefined) {
    const href = typeof properties.href === 'string' ? properties.href : ''
    if (/^(?:https?:|mailto:)/iu.test(href)) {
      properties.dataSimpleNotesExternalLink = href
      properties.href = '#simple-notes-external'
    } else if (!href.startsWith('#simple-notes-internal-')) {
      delete properties.href
    }
  }
  if (!Array.isArray(node.children)) return
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null) walkPreviewNodes(child as MarkdownNode)
  }
}

function isOwnedAssetReference(value: string) {
  return /^assets\/screenshot-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/u.test(value)
}

export function plainTextFromMarkdown(markdown: string): string {
  const fragments: string[] = []
  collectText(parser.parse(markdown) as MarkdownNode, fragments)
  return fragments.join(' ').replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim()
}

export interface MarkdownSourceRange {
  from: number
  to: number
}

/**
 * Returns only source ranges where custom link syntax is ordinary prose.
 * Literal/code nodes, standard links/images, definitions, and any raw-HTML line are excluded.
 */
export function commonmarkProseRanges(markdown: string): MarkdownSourceRange[] {
  const contextMarkdown = maskApplicationLinkCandidates(markdown)
  const proseRanges: MarkdownSourceRange[] = []
  const htmlLines: MarkdownSourceRange[] = []
  collectSourceRanges(parser.parse(contextMarkdown) as MarkdownNode, markdown, false, proseRanges, htmlLines)
  return mergeProseRanges(proseRanges)
    .filter((range) => !htmlLines.some((html) => rangesOverlap(range, html)))
}

/**
 * Keeps source offsets stable while preventing legal label punctuation from
 * changing the CommonMark tree used only to determine the surrounding context.
 */
function maskApplicationLinkCandidates(markdown: string): string {
  const masked = markdown.split('')
  let cursor = 0
  while (cursor < markdown.length) {
    const from = markdown.indexOf('[[', cursor)
    if (from < 0) break
    let index = from + 2
    let nested = -1
    let close = -1
    while (index < markdown.length) {
      if (markdown[index] === '\\') {
        index += 2
        continue
      }
      if (markdown.startsWith('[[', index)) {
        nested = index
        break
      }
      if (markdown.startsWith(']]', index)) {
        close = index
        break
      }
      index += 1
    }
    if (nested >= 0) {
      cursor = nested
      continue
    }
    if (close < 0) break
    const to = close + 2
    for (let offset = from; offset < to; offset += 1) {
      if (masked[offset] !== '\r' && masked[offset] !== '\n') masked[offset] = 'x'
    }
    cursor = to
  }
  return masked.join('')
}

function collectText(node: MarkdownNode, fragments: string[]) {
  if (node.type === 'html' || node.type === 'definition' || node.type === 'yaml') return
  if (
    (node.type === 'text' || node.type === 'code' || node.type === 'inlineCode') &&
    typeof node.value === 'string'
  ) {
    fragments.push(node.value)
    return
  }
  if (node.type === 'image' && typeof node.alt === 'string') {
    fragments.push(node.alt)
    return
  }
  if (!Array.isArray(node.children)) return
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null) collectText(child as MarkdownNode, fragments)
  }
}

function collectSourceRanges(
  node: MarkdownNode,
  markdown: string,
  excluded: boolean,
  proseRanges: MarkdownSourceRange[],
  htmlLines: MarkdownSourceRange[],
) {
  const type = typeof node.type === 'string' ? node.type : ''
  const range = sourceRange(node)
  if (type === 'html' && range !== null) htmlLines.push(expandToLines(markdown, range))
  const nextExcluded = excluded || new Set([
    'code',
    'inlineCode',
    'html',
    'definition',
    'image',
    'imageReference',
    'link',
    'linkReference',
    'yaml',
  ]).has(type)
  if (type === 'text' && !nextExcluded && range !== null) {
    proseRanges.push(range)
  }
  if (!Array.isArray(node.children)) return
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null) {
      collectSourceRanges(child as MarkdownNode, markdown, nextExcluded, proseRanges, htmlLines)
    }
  }
}

function mergeProseRanges(ranges: MarkdownSourceRange[]): MarkdownSourceRange[] {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to)
  const merged: MarkdownSourceRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function sourceRange(node: MarkdownNode): MarkdownSourceRange | null {
  const from = node.position?.start?.offset
  const to = node.position?.end?.offset
  return typeof from === 'number' && typeof to === 'number' && from <= to ? { from, to } : null
}

function expandToLines(markdown: string, range: MarkdownSourceRange): MarkdownSourceRange {
  const previousBreak = markdown.lastIndexOf('\n', Math.max(0, range.from - 1))
  const nextBreak = markdown.indexOf('\n', range.to)
  return { from: previousBreak < 0 ? 0 : previousBreak + 1, to: nextBreak < 0 ? markdown.length : nextBreak + 1 }
}

function rangesOverlap(left: MarkdownSourceRange, right: MarkdownSourceRange) {
  return left.from < right.to && left.to > right.from
}
