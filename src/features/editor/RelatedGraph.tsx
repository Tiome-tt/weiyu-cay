import {text as uiText} from '../../shared/i18n'
import {useEffect,useId,useState} from 'react'
import type {NoteId} from '../../domain/model'
import type {LinkNeighborhood,LinkPort} from '../../domain/ports'

export function RelatedGraph({noteId,noteTitle,links,onNavigate,refreshToken}:{noteId:NoteId;noteTitle:string;links:Pick<LinkPort,'neighborhood'>;onNavigate(id:NoteId):void|Promise<void>;refreshToken:string|number}){
 const [graph,setGraph]=useState<LinkNeighborhood|null>(null)
 const [failed,setFailed]=useState(false)
 const [attempt,setAttempt]=useState(0)
 const [showIndirect,setShowIndirect]=useState(true)
 const arrow=useId().replace(/:/g,'')
 useEffect(()=>{
  let active=true
  setGraph(null);setFailed(false)
  if(links.neighborhood)void links.neighborhood(noteId).then(value=>{if(active)setGraph(value)},()=>{if(active)setFailed(true)})
  else setGraph({nodes:[{id:noteId,title:uiText("当前笔记","Current note"),distance:0}],edges:[],truncated:false})
  return ()=>{active=false}
 },[links,noteId,refreshToken,attempt])
 const nodes=(graph?.nodes.length ? graph.nodes : [{id:noteId,title:noteTitle,distance:0}]).filter(node=>showIndirect || node.distance<=1)
 const positions=new Map<NoteId,{x:number;y:number}>()
 for(const distance of [0,1,2]){
  const ring=nodes.filter(node=>Math.min(2,node.distance)===distance)
  ring.forEach((node,index)=>{
   const angle=(distance===1?-Math.PI/3:Math.PI/5)+index*Math.PI*2/Math.max(1,ring.length)
   positions.set(node.id,distance===0?{x:240,y:105}:{x:240+Math.cos(angle)*(distance===1?125:205),y:105+Math.sin(angle)*(distance===1?53:82)})
  })
 }
 return <section className="related-graph" aria-label={uiText("关联图谱","Reference graph")}>
  <header><strong>{uiText("关联图谱","Reference graph")}</strong><label className="related-graph__indirect">{uiText("间接引用","Indirect references")}<input type="checkbox" role="switch" aria-label={uiText("间接引用","Indirect references")} checked={showIndirect} onChange={event=>setShowIndirect(event.target.checked)}/></label></header>
  {failed ? <div><p role="status">{uiText("图谱暂时无法加载。","The graph could not be loaded.")}</p><button type="button" className="related-graph__retry" aria-label={uiText("重试加载图谱","Retry loading graph")} onClick={()=>setAttempt(value=>value+1)}>{uiText("重试","Retry")}</button></div> : graph===null ? <p role="status">{uiText("正在加载图谱…","Loading graph…")}</p> : <>
   <svg viewBox="0 0 480 220" role="group" className={nodes.length>12?'related-graph__dense':undefined} aria-label={uiText("笔记关联图谱","Note reference graph")}>
    <defs><marker id={arrow} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 6 3 0 6" fill="currentColor"/></marker></defs>
    <g className="related-graph__edges">{graph.edges.map(edge=>{
     const source=positions.get(edge.source),target=positions.get(edge.target)
     if(!source||!target||edge.source===edge.target)return null
     const length=Math.hypot(target.x-source.x,target.y-source.y),dx=(target.x-source.x)/length,dy=(target.y-source.y)/length
     return <line key={`${edge.source}:${edge.target}`} x1={source.x+dx*9} y1={source.y+dy*9} x2={target.x-dx*10} y2={target.y-dy*10} markerEnd={`url(#${arrow})`}/>
    })}</g>
    {nodes.map(node=>{
     const position=positions.get(node.id)!,current=node.id===noteId
     const title=current && noteTitle!==uiText("当前笔记","Current note") ? noteTitle : node.title
     const label=Array.from(title).length>9 ? Array.from(title).slice(0,8).join('')+'…':title
     return <g key={node.id} transform={`translate(${position.x} ${position.y})`} className={`related-graph__node${current?' related-graph__node--current':''}${node.distance===2?' related-graph__node--indirect':''}`} role={current?'img':'button'} aria-label={current?uiText(`当前笔记：${title}`,`Current note: ${title}`):uiText(`打开笔记：${title}`,`Open note: ${title}`)} aria-current={current?'true':undefined} tabIndex={current?undefined:0} onClick={()=>{if(!current)void onNavigate(node.id)}} onKeyDown={event=>{if(!current && ['Enter',' '].includes(event.key)){event.preventDefault();void onNavigate(node.id)}}}>
      <title>{title}</title><circle r={current?8:5}/><text y={!current&&position.y<100?-12:20} textAnchor={position.x<80?'start':position.x>400?'end':'middle'}>{label}</text>
     </g>
    })}
   </svg>
   {graph.truncated && <p className="related-graph__hint">{uiText("关联较多，仅展示部分。","Some references are omitted because this graph is large.")}</p>}
  </>}
 </section>
}
