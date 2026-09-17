export interface RichMark { type: string; attrs?: Record<string, unknown> }
export interface RichNode {
  type: string
  attrs?: Record<string, unknown>
  content?: RichNode[]
  text?: string
  marks?: RichMark[]
}
export interface RichDocument { schemaVersion: 1; root: RichNode }
export interface ManagedFile {
  storageName: string
  originalName: string
  mediaType: string
  size: number
  sha256: string
}
export type NoteContent =
  | { type: 'document'; document: RichDocument }
  | { type: 'text'; text: string }
  | { type: 'file'; file: ManagedFile }
export type NewNoteFormat = 'markdown' | 'document' | 'text'
export type ContentFormat = NewNoteFormat | 'file'
export function emptyRichDocument(): RichDocument {
  return { schemaVersion: 1, root: { type: 'doc', content: [{ type: 'paragraph' }] } }
}
export function contentFormat(value: { content?: NoteContent; markdown?: string }): ContentFormat {
  return value.content?.type ?? 'markdown'
}
/** A display projection only. Typed content remains the durable authority. */
export function contentText(value: { content?: NoteContent; markdown?: string }): string {
  switch (value.content?.type) {
    case 'text': return value.content.text
    case 'file': return value.content.file.originalName
    case 'document': return richText(value.content.document.root).trim()
    default: return value.markdown ?? ''
  }
}
function richText(node: RichNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'math' || node.type === 'mathBlock') return typeof node.attrs?.latex === 'string' ? node.attrs.latex : ''
  if (node.type === 'rawMarkdown') return typeof node.attrs?.source === 'string' ? node.attrs.source : ''
  if (node.type === 'internalLink' || node.type === 'attachment') {
    return typeof node.attrs?.label === 'string' ? node.attrs.label : ''
  }
  const text = (node.content ?? []).map(richText).join('')
  return ['paragraph', 'heading', 'codeBlock', 'tableCell', 'tableHeader'].includes(node.type) ? text + '\n' : text
}

/** Heading-only projection consumed by the existing outline, never a save format. */
export function contentOutlineMarkdown(value: {content?: NoteContent;markdown?:string}): string {
  if (!value.content) return value.markdown??''
  if (value.content.type!=='document') return ''
  const headings:string[]=[]
  const visit=(node:RichNode)=>{
    if(node.type==='heading')headings.push('#'.repeat(Math.max(1,Math.min(6,Number(node.attrs?.level)||1))) + ' ' + richText(node).trim())
    else if(node.type==='codeBlock'||node.type==='rawMarkdown')return
    for(const child of node.content??[])visit(child)
  }
  visit(value.content.document.root)
  return headings.join('\n')
}