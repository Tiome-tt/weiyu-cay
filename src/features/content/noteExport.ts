import type { NoteDocument } from '../../domain/model'
import type { RichNode } from '../../domain/content'
import type { FilePort, ImageReadPort } from '../../domain/ports'
import { tableMarkdownFromModel, type MarkdownTable } from '../editor/markdownActions'
import { applyMarkdownTableMerges, renderPreviewMarkdown } from '../editor/markdownPipeline'
import { displayInternalLinks } from '../editor/internalLinks'
import { readImageAsset } from './imageAssetLoader'
import { printableClone } from './printDocument'

export { noteExportOptions } from '../../domain/noteExport'
const escapeText = (value: string) => value.replace(/[\\`*_[\]<>~]/g, '\\$&')
const attr = (node: RichNode, key: string) => typeof node.attrs?.[key] === 'string' ? String(node.attrs[key]) : ''
const literal = (node: RichNode): string => node.type === 'text' ? node.text ?? '' : node.type === 'hardBreak' ? '\n' : (node.content ?? []).map(literal).join('')
function ticksFor(body: string, minimum: number) {
  let length = minimum
  for (const match of body.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  return '`'.repeat(length)
}
function fenced(body: string, language = '') {
  const fence = ticksFor(body, 3)
  return `${fence}${language.replace(/[\r\n`]/g, '')}\n${body}\n${fence}`
}
function inline(node: RichNode): string {
  if (node.type === 'hardBreak') return '<br>'
  if (node.type === 'image') return `![${escapeText(attr(node, 'alt'))}](${attr(node, 'src').replace(/[\s()]/g, encodeURIComponent)})`
  if (node.type === 'internalLink') return `[[${attr(node, 'label').replace(/[\\|[\]]/g, '\\$&')}|${attr(node, 'noteId')}]]`
  if (node.type === 'math') return `$${attr(node, 'latex')}$`
  if (node.type !== 'text') return (node.content ?? []).map(inline).join('')
  const raw = node.text ?? ''
  const ticks = ticksFor(raw, 1)
  let value = node.marks?.some(mark => mark.type === 'code') ? `${ticks} ${raw} ${ticks}` : escapeText(raw)
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') value = `**${value}**`
    else if (mark.type === 'italic') value = `*${value}*`
    else if (mark.type === 'strike') value = `~~${value}~~`
    else if (mark.type === 'highlight') value = `==${value}==`
    else if (mark.type === 'link' && typeof mark.attrs?.href === 'string' && /^(https?:|mailto:)/i.test(mark.attrs.href)) value = `[${value}](${mark.attrs.href.replace(/[\s()]/g, encodeURIComponent)})`
  }
  return value
}
export function richTableMarkdown(node: RichNode): string {
  const table: MarkdownTable = { cells: [], alignments: [], merges: [] }
  const covered = new Set<string>()
  for (const [row, source] of (node.content ?? []).entries()) {
    table.cells[row] ??= []
    let column = 0
    for (const cell of source.content ?? []) {
      while (covered.has(`${row}:${column}`)) column += 1
      const rowSpan = Math.max(1, Number(cell.attrs?.rowspan) || 1)
      const columnSpan = Math.max(1, Number(cell.attrs?.colspan) || 1)
      if (!Number.isInteger(rowSpan) || !Number.isInteger(columnSpan) || (row + rowSpan) * (column + columnSpan) > 100000) throw new Error('Table exceeds portable projection limits')
      table.cells[row][column] = (cell.content ?? []).map(inline).join('<br>')
      if (rowSpan > 1 || columnSpan > 1) {
        table.merges!.push({ row, column, rowSpan, columnSpan })
        for (let r = row; r < row + rowSpan; r += 1) for (let c = column; c < column + columnSpan; c += 1) {
          if (r !== row || c !== column) { covered.add(`${r}:${c}`); table.cells[r] ??= []; table.cells[r][c] = '' }
        }
      }
      column += columnSpan
    }
  }
  return tableMarkdownFromModel(table)
}
function block(node: RichNode): string {
  const children = node.content ?? []
  switch (node.type) {
    case 'doc': case 'listItem': case 'taskItem': return children.map(block).join('\n\n')
    case 'paragraph': return inline(node)
    case 'heading': return '#'.repeat(Math.max(1, Math.min(6, Number(node.attrs?.level) || 1))) + ' ' + inline(node)
    case 'image': return inline(node)
    case 'codeBlock': return fenced(literal(node), attr(node, 'language'))
    case 'rawMarkdown': return attr(node, 'source')
    case 'mathBlock': return `$$\n${attr(node, 'latex')}\n$$`
    case 'horizontalRule': return '---'
    case 'table': return richTableMarkdown(node)
    case 'blockquote': return children.map(block).join('\n\n').split('\n').map(line => '> ' + line).join('\n')
    case 'bulletList': case 'orderedList': case 'taskList':
      return children.map((child, index) => {
        const marker = node.type === 'orderedList' ? `${(Number(node.attrs?.start) || 1) + index}. ` : node.type === 'taskList' ? `- [${child.attrs?.checked ? 'x' : ' '}] ` : '- '
        return block(child).split('\n').map((line, row) => row === 0 ? marker + line : ' '.repeat(marker.length) + line).join('\n')
      }).join('\n')
    case 'attachment': return escapeText(attr(node, 'label') || attr(node, 'fileName'))
    default: return children.length ? children.map(block).join('\n\n') : node.type === 'text' ? inline(node) : fenced(JSON.stringify(node), 'json')
  }
}
export function noteMarkdown(note: NoteDocument): string {
  if (note.content?.type === 'document') return block(note.content.document.root)
  if (note.content?.type === 'text') return note.content.text
  if (note.content?.type === 'file') throw new Error('Use original file export')
  return note.markdown
}
export function notePlainText(note: NoteDocument): string {
  if (note.content?.type === 'text') return note.content.text
  const root = document.createElement('article')
  const markdown = displayInternalLinks(noteMarkdown(note))
  root.innerHTML = renderPreviewMarkdown(markdown)
  applyMarkdownTableMerges(root, markdown)
  for (const formula of root.querySelectorAll('.katex')) formula.textContent = formula.querySelector('annotation')?.textContent ?? ''
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? ''
      if (node.parentElement && ['ARTICLE','DIV','TABLE','THEAD','TBODY','TR','UL','OL'].includes(node.parentElement.tagName) && /^\s*$/.test(value)) return ''
      return value
    }
    if (!(node instanceof Element)) return Array.from(node.childNodes, text).join('')
    if (node.tagName === 'BR') return '\n'
    if (node.tagName === 'IMG') return node.getAttribute('alt') ?? ''
    if (node.tagName === 'PRE') return (node.textContent ?? '') + '\n\n'
    if (node.tagName === 'TABLE') {
      const grid: string[][] = [], covered = new Set<string>()
      for (const [row, tr] of Array.from(node.querySelectorAll('tr')).entries()) {
        grid[row] ??= []
        let column = 0
        for (const cell of Array.from(tr.children)) {
          while (covered.has(`${row}:${column}`)) column++
          const width = Number(cell.getAttribute('colspan')) || 1, height = Number(cell.getAttribute('rowspan')) || 1
          grid[row][column] = Array.from(cell.childNodes, text).join('').trim()
          for (let r = row; r < row + height; r++) for (let c = column; c < column + width; c++) if (r !== row || c !== column) { grid[r] ??= []; grid[r][c] = ''; covered.add(`${r}:${c}`) }
          column += width
        }
      }
      return grid.map(row => row.join('\t')).join('\n') + '\n\n'
    }
    const value = Array.from(node.childNodes, text).join('')
    return ['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','UL','OL'].includes(node.tagName) ? value + '\n\n' : node.tagName === 'LI' ? '- ' + value.trim() + '\n' : value
  }
  return text(root).replace(/^\n+|\n+$/g, '')
}
function htmlText(value: string) { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!) }
export async function buildNoteHtml(note: NoteDocument, reader?: ImageReadPort, source?: HTMLElement): Promise<string> {
  const root = source ? printableClone(source) : document.createElement('article')
  if (!source) { const markdown = displayInternalLinks(noteMarkdown(note)); root.innerHTML = renderPreviewMarkdown(markdown); applyMarkdownTableMerges(root, markdown) }
  await Promise.all(Array.from(root.querySelectorAll<HTMLImageElement>('img'), async image => {
    const path = image.dataset.simpleNotesAsset ?? image.dataset.simpleNotesImagePath ?? ''
    if (!path.startsWith('assets/')) { image.removeAttribute('src'); return }
    if (!reader) throw new Error('Image reader unavailable')
    const loaded = await readImageAsset(reader, note.id, path)
    if (!/^image\/(png|jpeg|webp|gif)$/.test(loaded.mediaType)) throw new Error('Unsupported exported image')
    const parts: string[] = []
    for (let offset = 0; offset < loaded.bytes.length; offset += 16384) parts.push(String.fromCharCode(...loaded.bytes.subarray(offset, offset + 16384)))
    image.src = `data:${loaded.mediaType};base64,${btoa(parts.join(''))}`
  }))
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${htmlText(note.title)}</title><style>body{margin:2rem auto;padding:0 1rem;max-width:900px;font:16px/1.7 system-ui;color:#263a33}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #becfc7;padding:8px}pre{white-space:pre-wrap;background:#edf3ef;padding:16px;overflow-wrap:anywhere}blockquote{border-left:3px solid #72a994;padding-left:16px}a{color:#17695a}mark{background:#fff0ad}.katex-html{display:none}.katex-mathml{position:static}.tok-keyword{color:#6f4f91}.tok-string{color:#196d70}.tok-comment{color:#61756d}</style></head><body><h1>${htmlText(note.title)}</h1>${root.innerHTML}</body></html>`
}
export async function exportPortableNote(note: NoteDocument, kind: 'markdown' | 'text' | 'html', files: FilePort, reader?: ImageReadPort, source?: HTMLElement): Promise<boolean> {
  if (kind === 'markdown') return files.exportMarkdownNote?.(note.id, noteMarkdown(note)) ?? false
  if (!files.saveTextExport) return false
  const text = kind === 'html' ? await buildNoteHtml(note, reader, source) : notePlainText(note)
  return files.saveTextExport(note.id, text, note.title, kind)
}
