import { ErrorNotification } from '../../shared/notifications'
import { SearchHighlight, matchingSentences } from './searchExcerpt'
import { useEffect, useId, useRef, useState } from 'react'
import type { Folder, FolderId, NoteId } from '../../domain/model'
import type { SearchPort, SearchResult } from '../../domain/ports'
import { parseSearchQuery } from './query'
import { Icon } from '../../shared/Icon'
export type SearchDestination = {kind:'folder';id:FolderId} | {kind:'note';id:NoteId}
interface Props { initialQuery?:string; search:SearchPort; folders:Folder[]; onSelect(destination:SearchDestination):Promise<boolean>; onClose():void }
export function WorkspaceSearchDialog({search,folders,onSelect,onClose,initialQuery = ''}:Props) {
 const [input,setInput]=useState(initialQuery), [results,setResults]=useState<SearchResult[]>([])
 const [loading,setLoading]=useState(false), [error,setError]=useState(''), [active,setActive]=useState(0), [busy,setBusy]=useState(false)
 const field=useRef<HTMLInputElement>(null), root=useRef<HTMLElement>(null), generation=useRef(0), id=useId()
 useEffect(()=>{ const previous=document.activeElement;field.current?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus()} },[])
 useEffect(()=>{
   const request=++generation.current;setResults([]);setError('');setActive(0)
   const query=parseSearchQuery(input)
   if(query.kind==='invalid'){setLoading(false);if(input.trim())setError('请输入有效的标题、正文或 #标签');return}
   if(!query.value){setLoading(false);return}
   setLoading(true)
   const timer=window.setTimeout(()=>{void search.search(query,100).then(items=>{if(request===generation.current){setResults(items);setLoading(false)}},()=>{if(request===generation.current){setLoading(false);setError('搜索未完成，请重试。')}})},180)
   return()=>{window.clearTimeout(timer);generation.current++}
 },[input,search])
 const matchedFolders=input.trim()&&!input.trim().startsWith('#')?folders.filter(folder=>folder.name.toLocaleLowerCase().includes(input.trim().toLocaleLowerCase())):[]
 const items:Array<{destination:SearchDestination;title:string;detail:string;excerpt:string}>=[...matchedFolders.map(folder=>({destination:{kind:'folder' as const,id:folder.id},title:folder.name,detail:'文件夹',excerpt:''})),...results.map(note=>({destination:{kind:'note' as const,id:note.noteId},title:note.title,detail:note.folderBreadcrumb.join(' / ')||'笔记',excerpt:note.excerpt}))]
 const select=async(destination:SearchDestination)=>{if(busy)return;setBusy(true);try{if(await onSelect(destination))onClose();else setError('请先完成当前笔记的保存，再跳转。')}catch{setError('无法打开搜索结果，请重试。')}finally{setBusy(false)}}
 return <div className="workspace-search-backdrop" onPointerDown={event=>{if(event.target===event.currentTarget&&!busy)onClose()}}>
  <section ref={root} className="workspace-search" role="dialog" aria-modal="true" aria-label="搜索资料库" onKeyDown={event=>{
   if(event.key==='Escape'){event.preventDefault();if(!busy)onClose()}
   if(event.key==='Tab'){const focusable=Array.from(root.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)')??[]);const index=focusable.indexOf(document.activeElement as HTMLElement);if((event.shiftKey&&index===0)||(!event.shiftKey&&index===focusable.length-1)){event.preventDefault();focusable[event.shiftKey?focusable.length-1:0]?.focus()}}
  }}>
   <div className="workspace-search__field"><Icon name="search" size={20}/><input ref={field} type="search" aria-label="搜索资料库" placeholder="搜索文件夹、笔记、正文或 #标签" value={input} role="searchbox" aria-controls={id} aria-activedescendant={items[active]?`${id}-${active}`:undefined} onChange={event=>setInput(event.target.value)} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(value=>items.length?(value+(event.key==='ArrowDown'?1:items.length-1))%items.length:0)}if(event.key==='Enter'&&items[active]){event.preventDefault();void select(items[active].destination)}}}/><button type="button" aria-label="关闭搜索" disabled={busy} onClick={onClose}><Icon name="close" size={17}/></button></div>
   {loading&&<p role="status">正在搜索…</p>}<ErrorNotification error={error} />
   <div id={id} className="workspace-search__results" role="listbox" aria-label="搜索结果">{items.map((item,index)=><button id={`${id}-${index}`} key={item.destination.kind+item.destination.id} type="button" role="option" aria-selected={active===index} aria-label={item.detail+' '+item.title} disabled={busy} onPointerMove={()=>setActive(index)} onClick={()=>void select(item.destination)}><Icon name={item.destination.kind==='folder'?'folder':'note'} size={17}/><span><strong><SearchHighlight text={item.title} query={input}/></strong><small>{item.detail}</small>{item.excerpt && <span className="workspace-search__excerpt"><SearchHighlight text={matchingSentences(item.excerpt,input)} query={input}/></span>}</span></button>)}</div>
   {!loading&&!error&&input.trim()&&items.length===0&&<p>没有找到匹配内容</p>}
  </section>
 </div>
}
