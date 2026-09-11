import { lazy, Suspense, useEffect, useState } from 'react'
import type { NoteDocument } from '../../domain/model'
import type { FilePort } from '../../domain/ports'
import { Icon, type IconName } from '../../shared/Icon'
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
export function FileViewer({document,files,onConvertToDocument}:{document:NoteDocument;files?:FilePort;onConvertToDocument?: (document:NoteDocument, bytes:Uint8Array)=>Promise<void>}) {
  const file = document.content?.type === 'file' ? document.content.file : null
  const [data,setData] = useState<{mediaType:string;bytes:Uint8Array}|null>(null)
  const [error,setError] = useState<string|null>(null)
  const [imageUrl,setImageUrl] = useState<string|null>(null)
  const [attempt,setAttempt] = useState(0)
  const [forceStructuredRead,setForceStructuredRead] = useState(false)
  const [converting,setConverting] = useState(false)
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
    if (files && file && (mediaType==='application/pdf'||['image/png','image/jpeg','image/webp'].includes(mediaType??''))) {
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
  const extension = file.originalName.includes('.') ? file.originalName.split('.').pop()?.toUpperCase() ?? '' : ''
  const canOpen=file.size>0&&/\.(docx?|xlsx?|pptx?)$/i.test(file.originalName)
  const officeLabel = /\.(docx?|doc)$/i.test(file.originalName) ? 'Word 文档' : /\.(xlsx?|xls)$/i.test(file.originalName) ? 'Excel 工作簿' : /\.(pptx?|ppt)$/i.test(file.originalName) ? 'PowerPoint 演示文稿' : null
  const iconName = fileIconName(file.originalName, file.mediaType)
  const action=async(fn:()=>Promise<unknown>)=>{try{await fn()}catch(cause){setError(cause instanceof Error&&cause.message ? cause.message : '文件操作失败，原文件已保留。')}}
  return <section className="file-viewer" aria-label="文件预览">
    <div className={`file-viewer__info${officeLabel ? ' file-viewer__info--office' : ''}`}><span className="file-viewer__icon"><Icon name={iconName} size={22} decorative={false} /></span><div className="file-viewer__name"><strong>{file.originalName}</strong><span>{(officeLabel ?? extension) || '文件'} · {formatSize(file.size)}</span></div>
      <button type="button" disabled={!files} onClick={()=>void action(()=>files!.saveFileAs(document.id))}>另存文件</button>
      {canOpen&&<button type="button" disabled={!files} onClick={()=>void action(()=>files!.openFile(document.id))}>用系统应用打开</button>}
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
    </div>
    {officeLabel&&<p className={`file-viewer__hint${file.size===0?' file-viewer__hint--warning':''}`}>{file.size===0?`文件内容为空，无法直接用系统应用打开；可以先转换为可编辑的${officeLabel}笔记。`:`这是一个完整的 ${officeLabel} 文件。微屿保留原始文件内容，打开或编辑请使用系统应用；修改后可重新导入以更新笔记。`}</p>}
    {file.size === 0 && !officeLabel && <p className="file-viewer__hint file-viewer__hint--warning">文件内容为空，转换后会创建一个空白的可编辑文档。</p>}
    {canOpen&&!officeLabel&&<p className="file-viewer__hint">打开的是独立副本，外部修改不会自动同步；修改后可重新导入。</p>}
    {error&&<p role="alert">{error}<button type="button" onClick={()=>setAttempt(n=>n+1)}>重试</button></p>}
    {imageUrl&&<img className="file-viewer__image" src={imageUrl} alt={file.originalName}/>}
    {data?.mediaType==='application/pdf'&&<Suspense fallback={<p role="status">正在打开 PDF…</p>}><PdfViewer bytes={data.bytes} onDocumentError={()=>{
      if (!files?.readFileBytes || forceStructuredRead || !file) return
      previewCacheFor(files).delete(previewCacheKey(document, file))
      setForceStructuredRead(true)
    }}/></Suspense>}
    {!data&&!error&&(mediaType==='application/pdf'||mediaType?.startsWith('image/'))&&<p role="status">正在读取文件…</p>}
    {!canOpen&&!officeLabel&&mediaType!=='application/pdf'&&!mediaType?.startsWith('image/')&&<p className="file-viewer__hint">此文件已完整保存在资料库，可另存后使用对应应用查看。</p>}
  </section>
}
function fileIconName(name:string, mediaType:string):IconName {
 const extension=name.split('.').pop()?.toLowerCase() ?? ''
 const type=mediaType.toLowerCase()
 if(type==='application/pdf'||extension==='pdf')return 'file-pdf'
 if(type.includes('word')||['doc','docx'].includes(extension))return 'file-word'
 if(type.includes('spreadsheet')||type.includes('excel')||['xls','xlsx'].includes(extension))return 'file-excel'
 if(type.includes('presentation')||type.includes('powerpoint')||['ppt','pptx'].includes(extension))return 'file-powerpoint'
 if(type.startsWith('image/')||['png','jpg','jpeg','webp','gif'].includes(extension))return 'file-image'
 if(extension==='md'||extension==='txt')return 'file-text'
 return 'file'
}
function formatSize(bytes:number){return bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`}
