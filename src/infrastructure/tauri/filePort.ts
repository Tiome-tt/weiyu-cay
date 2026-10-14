import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { ExportSelection, FileImportResult, FilePort } from '../../domain/ports'
import type { FolderId, NoteId } from '../../domain/model'
import { TauriClient } from './client'
function exportPath(title:string,extension:string,selection?:ExportSelection):string {
 const name=(selection?.filename??title).replace(/[<>:"/\\|?*]/g,'_')
 const leaf=extension&&!name.toLowerCase().endsWith('.'+extension)?name+'.'+extension:name
 return selection?.directory?selection.directory.replace(/[\\/]$/,'')+'/'+leaf:leaf
}
export class TauriFilePort implements FilePort {
  constructor(private readonly client: TauriClient) {}
  async chooseExportDirectory():Promise<string|null>{const value=await open({directory:true,multiple:false,title:'选择保存目录'});return typeof value==='string'?value:null}
  readOfficeParts(noteId: NoteId): Promise<Array<{ name: string; text: string }>> { return this.client.invoke('read_office_preview_parts', { noteId }) }
  async saveTextExport(noteId: NoteId, text: string, title: string, format: 'text' | 'html', selection?:ExportSelection): Promise<boolean> {
    const extension = format === 'text' ? 'txt' : 'html'
    const destination = await save({ title: `导出 ${extension.toUpperCase()}`, defaultPath: exportPath(title,extension,selection), filters: [{ name: format === 'text' ? '文本文件' : 'HTML 网页', extensions: [extension] }] })
    if (!destination) return false
    await this.client.invoke('save_note_text_export', { input: { noteId, destination, text, format } })
    return true
  }
  async exportMarkdownNote(noteId: NoteId, markdown: string, selection?:ExportSelection): Promise<boolean> {
    const destination = selection?.directory ?? await open({ directory: true, multiple: false, title: '选择 Markdown 与附件的导出位置' })
    if (typeof destination !== 'string') return false
    const result = await this.client.invoke<{ completed: boolean; notesExported: number; failed: unknown[] }>('export_note_markdown', { noteId, destination, markdown, ...(selection?{exportName:selection.filename.replace(/\.md$/i,'')}: {}) })
    if (!result.completed || result.notesExported !== 1 || result.failed.length > 0) throw new Error('Markdown export incomplete')
    return true
  }
  async onDroppedFiles(handler: (paths: string[], position?: { x: number; y: number }) => void): Promise<() => void> {
    return getCurrentWebviewWindow().onDragDropEvent(event => {
      if (event.payload.type === 'drop') handler(event.payload.paths, event.payload.position)
    })
  }
  async saveDocumentExport(noteId: NoteId, bytes: Uint8Array, title: string, selection?:ExportSelection): Promise<boolean> {
    const destination = await save({title:'导出 DOCX',defaultPath:exportPath(title,'docx',selection),filters:[{name:'Word 文档',extensions:['docx']}]})
    if (!destination) return false
    await this.client.invoke('save_document_export',{input:{noteId,destination,bytes:Array.from(bytes)}})
    return true
  }
  async savePdfExport(noteId: NoteId, bytes: Uint8Array, title: string, selection?:ExportSelection): Promise<boolean> {
    const destination = await save({title:'导出 PDF',defaultPath:exportPath(title,'pdf',selection),filters:[{name:'PDF 文件',extensions:['pdf']}]})
    if (!destination) return false
    await this.client.invoke('save_pdf_export',{input:{noteId,destination,bytes:Array.from(bytes)}})
    return true
  }  async chooseFiles(): Promise<string[]> {
    const paths = await open({multiple:true,directory:false,title:'导入文件'})
    return paths === null ? [] : Array.isArray(paths) ? paths : [paths]
  }
  importFiles(input: {paths:string[];folderId:FolderId|null}): Promise<FileImportResult> {
    return this.client.invoke('import_files',{input})
  }
  async readFile(noteId: NoteId) {
    const result = await this.client.invoke<{mediaType:string;bytes:number[]}>('read_managed_file',{noteId})
    return {...result,bytes:Uint8Array.from(result.bytes)}
  }
  async readFileBytes(noteId: NoteId): Promise<Uint8Array> {
    const result = await this.client.invoke<unknown>('read_managed_file_bytes',{noteId})
    return decodeBinaryPayload(result)
  }
  async saveFileAs(noteId: NoteId, selection?:ExportSelection): Promise<boolean> {
    const destination = await save({title:'另存为',...(selection?{defaultPath:exportPath(selection.filename,'',selection)}:{})})
    if (destination === null) return false
    await this.client.invoke('export_managed_file',{noteId,destination})
    return true
  }
  syncExternalFile(noteId: NoteId, force = true): Promise<import('../../domain/model').NoteDocument | null> { return this.client.invoke('sync_external_file',{noteId,force}) }
  async openFile(noteId: NoteId): Promise<void> { await this.syncExternalFile(noteId); await this.client.invoke('open_managed_file',{noteId}) }
}

/** Normalize raw Tauri IPC values across WebView realms without silently accepting malformed data. */
export function decodeBinaryPayload(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  }
  if (Array.isArray(value) && value.every((item): item is number => typeof item === 'number')) {
    return Uint8Array.from(value)
  }
  if (typeof value === 'object' && value !== null && 'data' in value) {
    const data = (value as { data?: unknown }).data
    if (Array.isArray(data) && data.every((item): item is number => typeof item === 'number')) {
      return Uint8Array.from(data)
    }
  }
  throw new TypeError('read_managed_file_bytes returned an unsupported binary payload')
}
