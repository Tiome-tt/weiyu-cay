import { ErrorNotification } from '../../shared/notifications'
import {createPortal} from 'react-dom'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { NoteDocument } from '../../domain/model'
import { selectedExportPort } from '../../domain/exportSelection'
import type { ExportSelection } from '../../domain/ports'
import type { NoteExportKind } from '../../domain/noteExport'
import type { FilePort } from '../../domain/ports'
import { SaveAsDialog } from './SaveAsDialog'
const OfficePreview = lazy(() => import('./OfficePreview').then(module => ({ default: module.OfficePreview })))
import './content.css'
const loadPdfViewer = () => import('./PdfViewer')
const PdfViewer = lazy(loadPdfViewer)
// Keep a small per-port cache so reopening a stable payload does not reread it.
const PREVIEW_CACHE_LIMIT = 3
const previewCaches = new WeakMap<object, Map<string, { mediaType: string; bytes: Uint8Array }>>()

function previewCacheFor(files: FilePort): Map<string, { mediaType: string; bytes: Uint8Array }> {
  const existing = previewCaches.get(files)
  if (existing !== undefined) return existing
  const created = new Map<string, { mediaType: string; bytes: Uint8Array }>()
  previewCaches.set(files, created)
  return created
}

function previewCacheKey(document: NoteDocument, file: { sha256: string }): string {
  return `${document.id}:${document.revision}:${file.sha256}`
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d
}
function rememberPreview(cache: Map<string, { mediaType: string; bytes: Uint8Array }>, key: string, value: { mediaType: string; bytes: Uint8Array }): void {
  cache.delete(key)
  // PDF.js may transfer the supplied buffer to its worker, so the cache owns a copy.
  cache.set(key, { mediaType: value.mediaType, bytes: value.bytes.slice() })
  while (cache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}
export function FileViewer({document,files,onConvertToDocument,onSaveAs,onDocumentAdopt,actionsContainer}:{onDocumentAdopt?:(document:NoteDocument)=>void;actionsContainer?:HTMLElement|null;document:NoteDocument;files?:FilePort;onSaveAs?:(kind:NoteExportKind,selection?:ExportSelection)=>Promise<boolean>;onConvertToDocument?: (document:NoteDocument, bytes:Uint8Array)=>Promise<void>}) {
  const file = document.content?.type === 'file' ? document.content.file : null
  const [data,setData] = useState<{mediaType:string;bytes:Uint8Array}|null>(null)
  const [error,setError] = useState<string|null>(null)
  const [imageUrl,setImageUrl] = useState<string|null>(null)
  const [attempt,setAttempt] = useState(0)
  const [forceStructuredRead,setForceStructuredRead] = useState(false)
  const [converting,setConverting] = useState(false)
  const [saving,setSaving] = useState(false)
  const adoptRef=useRef(onDocumentAdopt)
  adoptRef.current=onDocumentAdopt
  useEffect(()=>{
    if(!files?.syncExternalFile||!file||! /\.(docx?|xlsx?|pptx?)$/i.test(file.originalName)) return
    let active=true,busy=false
    const sync=async(force:boolean)=>{if(busy)return;busy=true;try{const updated=await files.syncExternalFile!(document.id,force);if(active&&updated)adoptRef.current?.(updated)}catch{if(active&&force)setError('无法同步外部修改；笔记和编辑副本均已保留，请完成保存后重试。')}finally{busy=false}}
    void sync(true)
    const focus=()=>void sync(true),timer=window.setInterval(()=>void sync(false),2000)
    window.addEventListener('focus',focus)
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',focus)}
  },[files,document.id,document.revision])
  const mediaType=file?.mediaType
  useEffect(()=>{
    if (mediaType === 'application/pdf') void loadPdfViewer().catch(() => undefined)
  }, [mediaType])
  useEffect(()=>{
    setForceStructuredRead(false)
  },[document.id,document.revision])
  useEffect(()=>{
    let active=true
    setData(null);setError(null)
    if (files && file && file.size > 0 && (mediaType==='application/pdf'||['image/png','image/jpeg','image/webp'].includes(mediaType??''))) {
      const cache = previewCacheFor(files)
      const cacheKey = previewCacheKey(document, file)
      const cached = cache.get(cacheKey)
      if (cached !== undefined) {
        // Give PDF.js a disposable buffer and keep the cached copy reusable.
        setData({ mediaType: cached.mediaType, bytes: cached.bytes.slice() })
        return ()=>{active=false}
      }
      const fallback = () => files.readFile(document.id)
      const useBinary = files.readFileBytes !== undefined && !forceStructuredRead
      const read = useBinary
        ? files.readFileBytes!(document.id).then(bytes => {
          // A stale Tauri process or an unsupported raw IPC response must not make
          // a valid attachment look corrupt; retry through the established reader.
          if (bytes.byteLength === 0 || (mediaType === 'application/pdf' && !hasPdfHeader(bytes))) return fallback()
          return { mediaType: file.mediaType, bytes }
        }).catch(() => fallback())
        : fallback()
      void read.then(value=>{
        if (!active) return
        rememberPreview(cache, cacheKey, value)
        setData(value)
      },()=>{if(active)setError('无法读取预览内容，请重试或另存原文件。')})
    }
    return ()=>{active=false}
  },[document.id,document.revision,files,mediaType,attempt,forceStructuredRead])
  useEffect(()=>{
    if (!data || !['image/png','image/jpeg','image/webp'].includes(data.mediaType)) {setImageUrl(null);return}
    const url=URL.createObjectURL(new Blob([Uint8Array.from(data.bytes)],{type:data.mediaType}))
    setImageUrl(url)
    return ()=>URL.revokeObjectURL(url)
  },[data])
  if (!file) return null
  const extension = file.originalName.split('.').pop()?.toLowerCase() ?? ''
  const office = /^(docx?|xlsx?|pptx?)$/.test(extension)
  const canOpen = office && (file.size > 0 || ['docx','xlsx','pptx'].includes(extension))
  const action=async(fn:()=>Promise<unknown>)=>{try{await fn()}catch(cause){setError(cause instanceof Error&&cause.message ? cause.message : '文件操作失败，原文件已保留。')}}
  const actions=(<header className="file-viewer__actions">
      {office&&<button type="button" disabled={!files||!canOpen} title="在系统应用中编辑；保存后自动同步到此笔记" onClick={()=>void action(()=>files!.openFile(document.id))}>打开进行编辑</button>}
      <button type="button" disabled={!files} onClick={()=>setSaving(true)}>另存为</button>
      {/\.docx$/i.test(file.originalName) && onConvertToDocument && <button type="button" disabled={!files || converting} onClick={() => void action(async () => {
        setConverting(true)
        try {
          const bytes = files!.readFileBytes
            ? await files!.readFileBytes(document.id)
            : (await files!.readFile(document.id)).bytes
          await onConvertToDocument(document, bytes)
        } finally {
          setConverting(false)
        }
      })}>{converting ? '正在转换…' : '转为可编辑文档'}</button>}
    </header>)
  return <section className="file-viewer" aria-label="文件预览">
    {actionsContainer?createPortal(actions,actionsContainer):actions}
    <div className="file-viewer__content">
    {error&&<><ErrorNotification error={error} /><button type="button" onClick={()=>setAttempt(n=>n+1)}>重试加载文件</button></>}
    {imageUrl&&<img className="file-viewer__image" src={imageUrl} alt={file.originalName}/>}
    {data?.mediaType==='application/pdf'&&<Suspense fallback={<p role="status">正在打开 PDF…</p>}><PdfViewer bytes={data.bytes} cacheKey={file ? previewCacheKey(document, file) : undefined} onDocumentError={()=>{
      if (!files?.readFileBytes || forceStructuredRead || !file) return
      previewCacheFor(files).delete(previewCacheKey(document, file))
      setForceStructuredRead(true)
    }}/></Suspense>}
    {file.size>0&&!data&&!error&&(mediaType==='application/pdf'||mediaType?.startsWith('image/'))&&<p role="status">正在读取文件…</p>}
    {['docx','xlsx','pptx'].includes(extension)&&<Suspense fallback={null}><OfficePreview noteId={document.id} extension={extension} files={files} empty={file.size===0} revision={document.revision}/></Suspense>}
    </div>
    {saving&&<SaveAsDialog files={files} note={{...document,excerpt:''}} onClose={()=>setSaving(false)} onSave={(kind,selection)=>{setSaving(false);void action(async()=>{if(onSaveAs)return onSaveAs(kind,selection);const {convertManagedFile}=await import('./fileConversion');return convertManagedFile(document,kind,selectedExportPort(files!,selection))})}}/>}
  </section>
}
