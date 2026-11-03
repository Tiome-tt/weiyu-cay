import { useEffect, type RefObject } from 'react'

export function floatingHeaderTop(tableTop:number,tableBottom:number,viewTop:number,height:number):number|null {
  return tableTop < viewTop && tableBottom > viewTop ? Math.min(viewTop,tableBottom-height) : null
}

/** A read-only header copy avoids turning long tables into nested vertical scrollers. */
export function useFloatingTableHeaders(root:RefObject<HTMLElement|null>,ready=true):void {
  useEffect(()=>{
    const host=root.current
    if(!host || !ready) return
    let frame=0
    let version=0
    type Clip={element:HTMLElement;x:boolean;y:boolean}
    type Header={overlay:HTMLDivElement;copy:HTMLTableElement;row:HTMLTableRowElement;version:number;clips:Clip[]}
    const overlays=new Map<HTMLTableElement,Header>()
    const update=()=>{
      frame=0
      const tables=Array.from(host.querySelectorAll<HTMLTableElement>('table'))
      for(const [table,state] of overlays) if(!tables.includes(table)){state.overlay.remove();resizeObserver?.unobserve(table);overlays.delete(table)}
      for(const table of tables){
        const row=table.rows[0]
        let state=overlays.get(table)
        if(!row?.querySelector('th')){state?.overlay.remove();overlays.delete(table);continue}
        const rect=table.getBoundingClientRect(),header=row.getBoundingClientRect()
        if(rect.top>window.innerHeight || rect.bottom<0){if(state)state.overlay.hidden=true;continue}
        let clips=state?.clips
        if(!clips || state?.version!==version){
          clips=[]
          for(let ancestor=table.parentElement;ancestor;ancestor=ancestor.parentElement){
            const style=getComputedStyle(ancestor)
            clips.push({element:ancestor,x:/auto|scroll|hidden|clip/.test(style.overflowX),y:/auto|scroll|hidden|clip/.test(style.overflowY)})
          }
        }
        let top=30,bottom=window.innerHeight,left=0,right=window.innerWidth
        for(const clip of clips){
          if(!clip.x && !clip.y)continue
          const bounds=clip.element.getBoundingClientRect()
          if(clip.y && clip.element.scrollHeight>clip.element.clientHeight+1){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom)}
          if(clip.x){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right)}
        }
        const y=floatingHeaderTop(rect.top,rect.bottom,top,header.height)
        if(y===null || top>=bottom || right<=left){if(state)state.overlay.hidden=true;continue}
        if(!state){
          const overlay=document.createElement('div'),copy=document.createElement('table')
          overlay.className='floating-table-header';overlay.setAttribute('aria-hidden','true');overlay.inert=true
          overlay.append(copy);document.body.append(overlay)
          state={overlay,copy,row,version:-1,clips}
          overlays.set(table,state)
          resizeObserver?.observe(table)
        }
        const {overlay,copy}=state
        if(state.version!==version || state.row!==row){
          const head=document.createElement('thead'),copyRow=document.createElement('tr')
          for(const cell of Array.from(row.cells)){
            const th=document.createElement('th'),style=getComputedStyle(cell),bounds=cell.getBoundingClientRect()
            th.colSpan=cell.colSpan;th.rowSpan=cell.rowSpan
            th.textContent=cell.querySelector('textarea,input') instanceof HTMLTextAreaElement ? (cell.querySelector('textarea') as HTMLTextAreaElement).value : cell.textContent
            Object.assign(th.style,{boxSizing:'border-box',width:`${bounds.width}px`,height:`${bounds.height}px`,font:style.font,color:style.color,textAlign:style.textAlign,padding:style.padding,border:style.border,background:style.backgroundColor,overflowWrap:'anywhere'})
            const scale=cell.offsetWidth>0 ? bounds.width/cell.offsetWidth : 1
            th.style.fontSize=`${parseFloat(style.fontSize)*scale}px`
            if(Number.isFinite(parseFloat(style.lineHeight)))th.style.lineHeight=`${parseFloat(style.lineHeight)*scale}px`
            for(const property of ['paddingTop','paddingRight','paddingBottom','paddingLeft'] as const)th.style[property]=`${parseFloat(style[property])*scale}px`
            copyRow.append(th)
          }
          head.append(copyRow);copy.replaceChildren(head)
          Object.assign(copy.style,{width:`${rect.width}px`,borderCollapse:'collapse',tableLayout:'fixed'})
          state.version=version;state.row=row;state.clips=clips
        }
        overlay.hidden=false
        Object.assign(overlay.style,{top:`${Math.max(top,y)}px`,height:`${Math.min(header.height,rect.bottom-top)}px`,left:`${Math.max(left,rect.left)}px`,width:`${Math.min(right,rect.right)-Math.max(left,rect.left)}px`})
        copy.style.transform=`translate3d(${rect.left-Math.max(left,rect.left)}px,${Math.min(0,y-top)}px,0)`
      }
    }
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update)}
    const invalidate=()=>{version++;schedule()}
    const resizeObserver=typeof ResizeObserver==='undefined' ? null : new ResizeObserver(invalidate)
    resizeObserver?.observe(host)
    const observer=new MutationObserver(records=>{
      if(records.every(record=>record.target instanceof Element && record.target.closest('.cm-live-table-toolbar-layer,.cm-live-table-scrollbar,.cm-live-table-cell-actions,.rich-document__block-controls')))return
      invalidate()
    })
    observer.observe(host,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style','class']})
    document.addEventListener('scroll',schedule,true);window.addEventListener('resize',invalidate);host.addEventListener('input',invalidate)
    schedule()
    return ()=>{observer.disconnect();resizeObserver?.disconnect();document.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',invalidate);host.removeEventListener('input',invalidate);cancelAnimationFrame(frame);overlays.forEach(state=>state.overlay.remove())}
  },[root,ready])
}
