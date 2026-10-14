import type { NoteSummary } from './model'
export type NoteExportKind = 'markdown' | 'text' | 'html' | 'word' | 'pdf' | 'original'
export function noteExportOptions(note: Pick<NoteSummary, 'content'>): ReadonlyArray<{ kind: NoteExportKind; label: string }> {
  if(note.content?.type==='file'){
    const file=note.content.file
    const original={kind:'original' as const,label:'原文件'}
    if(/\.(docx|xlsx|pptx)$/i.test(file.originalName))return [original,{kind:'text',label:'TXT'},{kind:'html',label:'HTML'},{kind:'pdf',label:'PDF'}]
    if(['image/png','image/jpeg','image/webp'].includes(file.mediaType))return [original,{kind:'pdf',label:'PDF'}]
    return [original]
  }
  return [{ kind: 'markdown', label: '导出 Markdown' }, { kind: 'text', label: '导出 TXT' }, { kind: 'html', label: '导出 HTML' }, { kind: 'word', label: '导出 Word' }, { kind: 'pdf', label: '导出 PDF' }]
}
