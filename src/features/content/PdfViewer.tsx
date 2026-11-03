import {text as uiText} from '../../shared/i18n'
import { ErrorNotification } from '../../shared/notifications'
import { useCallback, useEffect, useRef, useState, type WheelEvent } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { PdfDocumentCache } from './pdfDocumentCache'
import type { NoteId } from '../../domain/model'
import type { PdfReadingPosition, WindowPreferencePort } from '../../domain/ports'
import { normalizePdfReadingPosition, pdfReadingPositionStore, PDF_SCALE_STEPS } from './pdfReadingPosition'
GlobalWorkerOptions.workerSrc=workerUrl

export { PDF_SCALE_STEPS } from './pdfReadingPosition'

export function adjustPdfScale(current: number, deltaY: number): number {
  const index = PDF_SCALE_STEPS.reduce((closest, value, candidate) =>
    Math.abs(value - current) < Math.abs(PDF_SCALE_STEPS[closest] - current) ? candidate : closest, 0)
  const next = index + (deltaY < 0 ? 1 : -1)
  return PDF_SCALE_STEPS[Math.max(0, Math.min(PDF_SCALE_STEPS.length - 1, next))]
}

const PDF_DOCUMENT_CACHE_LIMIT = 2
const pdfDocumentCache = new PdfDocumentCache<PDFDocumentProxy>(PDF_DOCUMENT_CACHE_LIMIT)
const pendingPdfDocuments = new Map<string, Promise<PDFDocumentProxy>>()

function loadPdfDocument(bytes: Uint8Array, cacheKey?: string): { promise: Promise<PDFDocumentProxy>; task?: ReturnType<typeof getDocument> } {
  if (cacheKey !== undefined) {
    const cachedDocument = pdfDocumentCache.get(cacheKey)
    if (cachedDocument !== undefined) return { promise: Promise.resolve(cachedDocument) }
    const pendingDocument = pendingPdfDocuments.get(cacheKey)
    if (pendingDocument !== undefined) return { promise: pendingDocument }
  }

  // FileViewer keeps a separate reusable copy for keyed previews; only standalone viewers need
  // their own disposable copy before PDF.js transfers the buffer to its worker.
  const pdfBytes = cacheKey === undefined ? bytes.slice() : bytes
  const task = getDocument({data:pdfBytes,useSystemFonts:true,cMapUrl:import.meta.env.BASE_URL+'pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:import.meta.env.BASE_URL+'pdfjs/standard_fonts/',wasmUrl:import.meta.env.BASE_URL+'pdfjs/wasm/'})
  if (cacheKey === undefined) return { promise: task.promise, task }

  const sharedPromise = task.promise.then(value=>{
    if (pendingPdfDocuments.get(cacheKey) === sharedPromise) pendingPdfDocuments.delete(cacheKey)
    pdfDocumentCache.set(cacheKey,value)
    return value
  }, error=>{
    if (pendingPdfDocuments.get(cacheKey) === sharedPromise) pendingPdfDocuments.delete(cacheKey)
    throw error
  })
  pendingPdfDocuments.set(cacheKey, sharedPromise)
  return { promise: sharedPromise, task }
}

export default function PdfViewer({bytes,cacheKey,onDocumentError,noteId,preferences}:{bytes:Uint8Array;cacheKey?:string;onDocumentError?:()=>void;noteId?:NoteId;preferences?:WindowPreferencePort}) {
  const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null)
  const [page,setPage]=useState(1)
  const [pageInput,setPageInput]=useState('1')
  const [scale,setScale]=useState(1)
  const [error,setError]=useState<string|null>(null)
  const canvas=useRef<HTMLCanvasElement>(null)
  const viewer=useRef<HTMLDivElement>(null)
  const pageContainer=useRef<HTMLDivElement>(null)
  const position=useRef<PdfReadingPosition>(normalizePdfReadingPosition(undefined))
  const restoring=useRef(true)
  const loadedBytes=useRef<Uint8Array|null>(null)
  const onDocumentErrorRef=useRef(onDocumentError)
  useEffect(()=>{onDocumentErrorRef.current=onDocumentError},[onDocumentError])
  const persist=useCallback((next:PdfReadingPosition)=>{
    position.current=next
    if(preferences&&noteId)void pdfReadingPositionStore(preferences).save(noteId,next).catch(()=>setError(uiText("无法保存 PDF 阅读位置，下次打开可能无法恢复。","Could not save the PDF reading position. It may not be restored next time.")))
  },[preferences,noteId])
  const changePage=(next:number)=>{
    if(!pdf)return
    const value=Math.max(1,Math.min(pdf.numPages,next))
    setPageInput(String(value))
    if(value===page)return
    restoring.current=true
    persist({...position.current,page:value,scrollTop:0,scrollLeft:0})
    setPage(value)
  }
  const commitPage=()=>{
    if(/^\d+$/.test(pageInput)&&Number.isSafeInteger(Number(pageInput)))changePage(Number(pageInput))
    else setPageInput(String(page))
  }
  const changeScale=(value:number)=>{
    if(!pdf||value===position.current.scale||!PDF_SCALE_STEPS.some(step=>step===value))return
    restoring.current=true
    persist({...position.current,scale:value})
    setScale(value)
  }
  const handleWheel=(event:WheelEvent<HTMLDivElement>)=>{
    if(!event.ctrlKey)return
    event.preventDefault()
    changeScale(adjustPdfScale(scale,event.deltaY))
  }
  useEffect(()=>{
    let active=true
    restoring.current=true
    loadedBytes.current=null
    setPdf(null);setPage(1);setError(null)
    const load = loadPdfDocument(bytes,cacheKey)
    const reading=preferences&&noteId?pdfReadingPositionStore(preferences).load(noteId).catch(()=>{
      if(active)setError(uiText("无法读取 PDF 阅读位置，已从第一页打开。","Could not read the saved PDF position. Opened at the first page."))
      return normalizePdfReadingPosition(undefined)
    }):Promise.resolve(normalizePdfReadingPosition(undefined))
    void Promise.all([load.promise,reading]).then(([value,saved])=>{
      if(active){
        const restoredPage=Math.min(saved.page,value.numPages)
        position.current={...saved,page:restoredPage,...(restoredPage!==saved.page?{scrollTop:0,scrollLeft:0}:{})}
        loadedBytes.current=bytes
        setPage(restoredPage);setPageInput(String(restoredPage));setScale(saved.scale);setPdf(value)
      }
      else if(cacheKey===undefined)void value.cleanup()
    },()=>{if(active){setError(uiText("无法打开 PDF。文件可能损坏或需要密码，请另存后查看。","Could not open the PDF. It may be damaged or password-protected. Save a copy and open it externally."));onDocumentErrorRef.current?.()}})
    return()=>{active=false;if(cacheKey===undefined)void load.task?.destroy()}
  },[bytes,cacheKey,noteId,preferences])
  useEffect(()=>{
    if(!pdf||loadedBytes.current!==bytes)return
    const scrollHost=viewer.current?.closest<HTMLElement>('.file-viewer')
    const pageHost=pageContainer.current
    const saveScroll=()=>{
      if(restoring.current)return
      persist({...position.current,scrollTop:scrollHost?.scrollTop??0,scrollLeft:pageHost?.scrollLeft??0})
    }
    scrollHost?.addEventListener('scroll',saveScroll,{passive:true})
    pageHost?.addEventListener('scroll',saveScroll,{passive:true})
    return()=>{
      scrollHost?.removeEventListener('scroll',saveScroll)
      pageHost?.removeEventListener('scroll',saveScroll)
    }
  },[pdf,bytes,persist])
  useEffect(()=>{
    if(!pdf||loadedBytes.current!==bytes)return
    let active=true
    let render:RenderTask|undefined
    const frame=window.requestAnimationFrame(()=>{
      void pdf.getPage(page).then(p=>{
        if(!active||!canvas.current)return
        const viewport=p.getViewport({scale})
        const context=canvas.current.getContext('2d')
        if(!context)return
        canvas.current.width=viewport.width;canvas.current.height=viewport.height
        render=p.render({canvas:canvas.current,canvasContext:context,viewport})
        return render.promise.then(()=>{
          if(!active)return
          const scrollHost=viewer.current?.closest<HTMLElement>('.file-viewer')
          if(scrollHost)scrollHost.scrollTop=position.current.scrollTop
          if(pageContainer.current)pageContainer.current.scrollLeft=position.current.scrollLeft
          restoring.current=false
        })
      }).catch(()=>{if(active){if(cacheKey!==undefined)pdfDocumentCache.delete(cacheKey);setError(uiText("这一页暂时无法显示。","This page could not be displayed."))}})
    })
    return()=>{active=false;window.cancelAnimationFrame(frame);render?.cancel()}
  },[pdf,page,scale,cacheKey,bytes])
  return <div className="pdf-viewer" ref={viewer}>
    <ErrorNotification error={error} />
    <div className="pdf-viewer__page" ref={pageContainer} onWheel={handleWheel}><canvas ref={canvas} aria-label={uiText(`PDF 第 ${page} 页`,`PDF page ${page}`)}/></div>
    <div className="pdf-viewer__toolbar" role="toolbar" aria-label={uiText("PDF 阅读工具","PDF reading tools")}>
      <button type="button" disabled={!pdf||page<=1} onClick={()=>changePage(page-1)}>{uiText("上一页","Previous")}</button>
      <label className="pdf-viewer__page-number"><span>{uiText("第","Page ")}</span><input aria-label={uiText("PDF 页码","PDF page number")} style={{width:`${Math.max(2,String(pdf?.numPages??'').length)+1}ch`}} inputMode="numeric" disabled={!pdf} value={pageInput} onChange={event=>setPageInput(event.target.value)} onBlur={commitPage} onKeyDown={event=>{
        if(event.key==='Enter'){event.preventDefault();commitPage()}
        else if(event.key==='Escape'){event.preventDefault();setPageInput(String(page))}
      }}/><span aria-live="polite">/ {pdf?.numPages??'—'}{uiText(" 页"," ")}</span></label>
      <button type="button" disabled={!pdf||page>=pdf.numPages} onClick={()=>changePage(page+1)}>{uiText("下一页","Next")}</button>
      <label>{uiText("缩放 ","Zoom ")}<select aria-label={uiText("PDF 缩放","PDF zoom")} disabled={!pdf} value={scale} onChange={e=>changeScale(Number(e.target.value))}>{PDF_SCALE_STEPS.map(s=><option key={s} value={s}>{s*100}%</option>)}</select></label>
      <span className="pdf-viewer__hint">{uiText("Ctrl + 滚轮缩放","Ctrl + scroll to zoom")}</span>
    </div>
  </div>
}
