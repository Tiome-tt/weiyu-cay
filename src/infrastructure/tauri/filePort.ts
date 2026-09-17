import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { FileImportResult, FilePort } from '../../domain/ports'
import type { FolderId, NoteId } from '../../domain/model'
import { TauriClient } from './client'
export class TauriFilePort implements FilePort {
  constructor(private readonly client: TauriClient) {}
  async onDroppedFiles(handler: (paths: string[], position?: { x: number; y: number }) => void): Promise<() => void> {
    return getCurrentWebviewWindow().onDragDropEvent(event => {
      if (event.payload.type === 'drop') handler(event.payload.paths, event.payload.position)
    })
  }
  async saveDocumentExport(noteId: NoteId, bytes: Uint8Array, title: string): Promise<boolean> {
    const destination = await save({title:'导出 DOCX',defaultPath:title.replace(/[<>:"/\\|?*]/g,'_')+'.docx',filters:[{name:'Word 文档',extensions:['docx']}]})
    if (!destination) return false
    await this.client.invoke('save_document_export',{input:{noteId,destination,bytes:Array.from(bytes)}})
    return true
  }
  async savePdfExport(noteId: NoteId, bytes: Uint8Array, title: string): Promise<boolean> {
    const destination = await save({title:'导出 PDF',defaultPath:title.replace(/[<>:"/\|?*]/g,'_')+'.pdf',filters:[{name:'PDF 文件',extensions:['pdf']}]})
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
  async saveFileAs(noteId: NoteId): Promise<boolean> {
    const destination = await save({title:'另存文件'})
    if (destination === null) return false
    await this.client.invoke('export_managed_file',{noteId,destination})
    return true
  }
  openFile(noteId: NoteId): Promise<void> { return this.client.invoke('open_managed_file',{noteId}) }
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
