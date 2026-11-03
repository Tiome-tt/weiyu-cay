import {text as uiText} from '../shared/i18n'
import type { NoteSummary } from './model'
export type NoteExportKind = 'markdown' | 'text' | 'html' | 'word' | 'pdf' | 'original'
export function noteExportOptions(note: Pick<NoteSummary, 'content'>): ReadonlyArray<{ kind: NoteExportKind; label: string }> {
  if(note.content?.type==='file'){
    const file=note.content.file
    const original={kind:'original' as const,label:uiText("原文件","Original file")}
    if(/\.(docx|xlsx|pptx)$/i.test(file.originalName))return [original,{kind:'text',label:'TXT'},{kind:'html',label:'HTML'},{kind:'pdf',label:'PDF'}]
    if(['image/png','image/jpeg','image/webp'].includes(file.mediaType))return [original,{kind:'pdf',label:'PDF'}]
    return [original]
  }
  return [{ kind: 'markdown', label: uiText("导出 Markdown","Export Markdown") }, { kind: 'text', label: uiText("导出 TXT","Export TXT") }, { kind: 'html', label: uiText("导出 HTML","Export HTML") }, { kind: 'word', label: uiText("导出 Word","Export Word") }, { kind: 'pdf', label: uiText("导出 PDF","Export PDF") }]
}
