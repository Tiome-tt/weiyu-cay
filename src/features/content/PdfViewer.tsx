import { useEffect, useRef, useState, type WheelEvent } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
GlobalWorkerOptions.workerSrc=workerUrl

export const PDF_SCALE_STEPS = [0.5,0.75,1,1.25,1.5,2] as const

export function adjustPdfScale(current: number, deltaY: number): number {
  const index = PDF_SCALE_STEPS.reduce((closest, value, candidate) =>
    Math.abs(value - current) < Math.abs(PDF_SCALE_STEPS[closest] - current) ? candidate : closest, 0)
  const next = index + (deltaY < 0 ? 1 : -1)
  return PDF_SCALE_STEPS[Math.max(0, Math.min(PDF_SCALE_STEPS.length - 1, next))]
}

export default function PdfViewer({bytes,onDocumentError}:{bytes:Uint8Array;onDocumentError?:()=>void}) {
  const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null)
  const [page,setPage]=useState(1)
  const [scale,setScale]=useState(1)
  const [error,setError]=useState<string|null>(null)
  const canvas=useRef<HTMLCanvasElement>(null)
  const onDocumentErrorRef=useRef(onDocumentError)
  useEffect(()=>{onDocumentErrorRef.current=onDocumentError},[onDocumentError])
  const handleWheel=(event:WheelEvent<HTMLDivElement>)=>{
    if(!event.ctrlKey)return
    event.preventDefault()
    setScale(current=>adjustPdfScale(current,event.deltaY))
  }
  useEffect(()=>{
    let active=true
    setPdf(null);setPage(1);setError(null)
    // PDF.js transfers typed-array buffers to its worker; always give it a disposable copy so the
    // caller can retry or reopen the same attachment safely.
    const pdfBytes = bytes.slice()
    const task=getDocument({data:pdfBytes,useSystemFonts:true,cMapUrl:import.meta.env.BASE_URL+'pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:import.meta.env.BASE_URL+'pdfjs/standard_fonts/',wasmUrl:import.meta.env.BASE_URL+'pdfjs/wasm/'})
    void task.promise.then(value=>{if(active)setPdf(value)},()=>{if(active){setError('无法打开 PDF。文件可能损坏或需要密码，请另存后查看。');onDocumentErrorRef.current?.()}})
    return()=>{active=false;void task.destroy()}
  },[bytes])
  useEffect(()=>{
    if(!pdf)return
    let active=true
    let render:RenderTask|undefined
    void pdf.getPage(page).then(p=>{
      if(!active||!canvas.current)return
      const viewport=p.getViewport({scale})
      const context=canvas.current.getContext('2d')
      if(!context)return
      canvas.current.width=viewport.width;canvas.current.height=viewport.height
      render=p.render({canvas:canvas.current,canvasContext:context,viewport})
      return render.promise
    }).catch(()=>{if(active)setError('这一页暂时无法显示。')})
    return()=>{active=false;render?.cancel()}
  },[pdf,page,scale])
  return <div className="pdf-viewer">
    {error&&<p role="alert">{error}</p>}
    <div className="pdf-viewer__page" onWheel={handleWheel}><canvas ref={canvas} aria-label={`PDF 第 ${page} 页`}/></div>
    <div className="pdf-viewer__toolbar" role="toolbar" aria-label="PDF 阅读工具">
      <button type="button" disabled={!pdf||page<=1} onClick={()=>setPage(p=>p-1)}>上一页</button>
      <span aria-live="polite">{page} / {pdf?.numPages??'—'}</span>
      <button type="button" disabled={!pdf||page>=pdf.numPages} onClick={()=>setPage(p=>p+1)}>下一页</button>
      <label>缩放 <select aria-label="PDF 缩放" value={scale} onChange={e=>setScale(Number(e.target.value))}>{PDF_SCALE_STEPS.map(s=><option key={s} value={s}>{s*100}%</option>)}</select></label>
      <span className="pdf-viewer__hint">Ctrl + 滚轮缩放</span>
    </div>
  </div>
}
