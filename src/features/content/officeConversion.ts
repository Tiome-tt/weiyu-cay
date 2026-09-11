import type { AssetPort } from '../../domain/ports'
import type { NoteId } from '../../domain/model'
import type { RichDocument, RichMark, RichNode } from '../../domain/content'

/** Convert the readable portion of a DOCX into the same block model used by documents. */
export async function docxToRichDocument(bytes: Uint8Array): Promise<RichDocument> {
  const mammothModule = await import('mammoth')
  const mammoth = mammothModule.default ?? mammothModule
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const result = await mammoth.convertToHtml({ arrayBuffer })
  if (result.messages.some((message) => message.type === 'error')) {
    throw new Error('Word 文档转换失败。')
  }
  const parsed = new DOMParser().parseFromString(result.value, 'text/html')
  const content = Array.from(parsed.body.childNodes).flatMap(convertBlock)
  return {
    schemaVersion: 1,
    root: { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] },
  }
}

/**
 * Materialize Mammoth's embedded data-URI images into Cay-managed assets.
 * External image URLs are rejected so a conversion can never create a document
 * that later fails storage validation or silently depends on the network.
 */
export async function materializeDocumentImages(
  document: RichDocument,
  noteId: NoteId,
  assets: Pick<AssetPort, 'saveImage'> | undefined,
): Promise<RichDocument> {
  const copy = structuredClone(document)
  const visit = async (node: RichNode): Promise<void> => {
    if (node.type === 'image') {
      const source = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
      const decoded = decodeDataUri(source)
      if (decoded === null || assets === undefined) {
        throw new Error('Word 文档中的图片无法导入资料库。')
      }
      const saved = await assets.saveImage({ noteId, mediaType: decoded.mediaType, bytes: decoded.bytes })
      node.attrs = { ...node.attrs, src: saved.relativePath }
    }
    for (const child of node.content ?? []) await visit(child)
  }
  await visit(copy.root)
  return copy
}

function decodeDataUri(value: string): { mediaType: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(value)
  if (!match) return null
  try {
    const binary = atob(match[2])
    return { mediaType: match[1], bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)) }
  } catch {
    return null
  }
}

function convertBlock(node: Node): RichNode[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent?.trim()
    return text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : []
  }
  if (!(node instanceof HTMLElement)) return []
  const tag = node.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) return [{ type: 'heading', attrs: { level: Number(tag.slice(1)) }, content: convertInline(node) }]
  if (tag === 'p') return [{ type: 'paragraph', content: convertInline(node) }]
  if (tag === 'blockquote') return [{ type: 'blockquote', content: Array.from(node.childNodes).flatMap(convertBlock) }]
  if (tag === 'pre') return [{ type: 'codeBlock', content: [{ type: 'text', text: node.textContent ?? '' }] }]
  if (tag === 'ul' || tag === 'ol') {
    const items = Array.from(node.children).filter((child) => child.tagName.toLowerCase() === 'li').map((child) => ({
      type: 'listItem',
      content: Array.from(child.childNodes).flatMap(convertBlock),
    } satisfies RichNode))
    return [{ type: tag === 'ul' ? 'bulletList' : 'orderedList', content: items }]
  }
  if (tag === 'table') return [convertTable(node)]
  return Array.from(node.childNodes).flatMap(convertBlock)
}

function convertTable(table: HTMLElement): RichNode {
  const columnWidths = Array.from(table.querySelectorAll(':scope > colgroup > col')).map((column) => parsePixels(column.getAttribute('width') ?? (column instanceof HTMLElement ? column.style.width : '')))
  const rows = Array.from(table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr')).map((row) => {
    let column = 0
    return {
      type: 'tableRow',
      content: Array.from(row.children).filter((cell) => ['td', 'th'].includes(cell.tagName.toLowerCase())).map((cell) => {
        const attrs: Record<string, unknown> = {}
        const colspan = Math.max(1, Number(cell.getAttribute('colspan')) || 1)
        for (const name of ['colspan', 'rowspan'] as const) {
          const value = Number(cell.getAttribute(name))
          if (Number.isInteger(value) && value > 1) attrs[name] = value
        }
        const widths = columnWidths.slice(column, column + colspan)
        if (widths.length === colspan && widths.every((width): width is number => width !== undefined)) attrs.colwidth = widths
        const style = cell instanceof HTMLElement ? cell.style : undefined
        const background = style ? tableColor(style.backgroundColor) : undefined
        const textAlign = style?.textAlign && ['left', 'center', 'right'].includes(style.textAlign) ? style.textAlign : undefined
        if (background) attrs.backgroundColor = background
        if (textAlign) attrs.textAlign = textAlign
        column += colspan
        return {
          type: cell.tagName.toLowerCase() === 'th' ? 'tableHeader' : 'tableCell',
          ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
          content: [{ type: 'paragraph', content: convertInline(cell) }],
        } satisfies RichNode
      }),
    } satisfies RichNode
  })
  return { type: 'table', content: rows }
}

function parsePixels(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(value.trim().toLowerCase())
  if (!match) return undefined
  const pixels = Math.round(Number(match[1]))
  return Number.isInteger(pixels) && pixels > 0 && pixels <= 4096 ? pixels : undefined
}

function tableColor(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === 'transparent') return undefined
  if (normalized.includes('green') || normalized === '#e1f1e9' || normalized === 'rgb(225, 241, 233)') return 'green'
  if (normalized.includes('yellow') || normalized === '#fff4c2') return 'yellow'
  if (normalized.includes('blue') || normalized === '#e2f0f8') return 'blue'
  if (normalized.includes('pink') || normalized === '#f7e3e7') return 'pink'
  if (normalized.includes('purple') || normalized === '#eee7f6') return 'purple'
  if (normalized.includes('gray') || normalized.includes('grey') || normalized === '#eef0ef') return 'gray'
  return undefined
}

function convertInline(parent: Element): RichNode[] {
  return Array.from(parent.childNodes).flatMap((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      return child.textContent ? [{ type: 'text', text: child.textContent }] : []
    }
    if (!(child instanceof HTMLElement)) return []
    const tag = child.tagName.toLowerCase()
    if (tag === 'br') return [{ type: 'hardBreak' }]
    if (tag === 'img') {
      return [{ type: 'image', attrs: { src: child.getAttribute('src') ?? '', alt: child.getAttribute('alt') ?? '图片' } }]
    }
    const marks: RichMark[] = []
    const style = child.style
    if (['strong', 'b'].includes(tag) || /^(?:[6-9]\d\d|bold)$/u.test(style.fontWeight)) marks.push({ type: 'bold' })
    if (['em', 'i'].includes(tag) || style.fontStyle === 'italic') marks.push({ type: 'italic' })
    if (tag === 'u' || style.textDecorationLine.includes('underline') || style.textDecoration.includes('underline')) marks.push({ type: 'underline' })
    if (['s', 'del', 'strike'].includes(tag) || style.textDecorationLine.includes('line-through') || style.textDecoration.includes('line-through')) marks.push({ type: 'strike' })
    if (tag === 'mark' || tableColor(style.backgroundColor)) marks.push({ type: 'highlight' })
    if (tag === 'a') {
      const href = child.getAttribute('href')
      if (href) marks.push({ type: 'link', attrs: { href } })
    }
    const text = child.textContent ?? ''
    return text ? [{ type: 'text', text, ...(marks.length > 0 ? { marks } : {}) }] : []
  })
}
