import {forwardRef,lazy,Suspense,useCallback,useEffect,useImperativeHandle,useRef,useState} from 'react'
import {flushSync} from 'react-dom'
import {contentOutlineMarkdown,type NoteContent} from '../../domain/content'
import type {EditorPaneHandle,EditorPaneProps} from '../editor/EditorPane'
import type {RichDocumentEditorHandle} from '../document/RichDocumentEditor'
import {useContentAutosave} from './useContentAutosave'
import {PlainTextEditor,type PlainTextEditorHandle} from './PlainTextEditor'
import {FileViewer} from './FileViewer'
import {TagsEditor} from '../search/TagsEditor'
import {Backlinks} from '../editor/Backlinks'
import {printDocument} from './printDocument'
import './content.css'
const RichDocumentEditor=lazy(()=>import('../document/RichDocumentEditor').then(module=>({default:module.RichDocumentEditor})))
function formatLastEdited(value:string){const date=new Date(value);if(Number.isNaN(date.getTime()))return '时间未知';return new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date)}
export const TypedEditorPane=forwardRef<EditorPaneHandle,EditorPaneProps>(function TypedEditorPane(props,ref){
 const {document,notes,files,assets,assetReader,links,onNavigateNote,search,onDocumentAdopt,onConvertFileToDocument,onSaveStateChange,onDraftChange,autosaveDelayMs,external}=props
 const save=useContentAutosave(document,notes,autosaveDelayMs)
 const rich=useRef<RichDocumentEditorHandle>(null)
 const text=useRef<PlainTextEditorHandle>(null)
 const [blocked,setBlocked]=useState(false)
 const [exporting,setExporting]=useState(false)
 const [error,setError]=useState<string|null>(null)
 const exportRef=useRef<(kind:'word'|'pdf')=>Promise<boolean>>(()=>Promise.resolve(false))
 const [title,setTitle]=useState(document.title)
 const body=useRef<HTMLDivElement>(null)
 const commit=useCallback(async()=>{await rich.current?.commitComposition();await text.current?.commitComposition()},[])
 const flush=useCallback(async()=>{try{await commit();return await save.flush()}catch{setError('请先完成当前输入，再重试保存。');return false}},[commit,save.flush]); const reloadLatest=useCallback(async()=>{const latest=await save.reloadLatest();if(latest){onDocumentAdopt?.(latest)}else setError('无法载入最新版本，请重试。')},[onDocumentAdopt,save.reloadLatest])
 useImperativeHandle(ref,()=>({
   flush,
   beginEditBarrier:async()=>{await commit();flushSync(()=>setBlocked(true))},
   endEditBarrier:()=>setBlocked(false),
   navigateToHeading:(_line,index)=>rich.current?.navigateToHeading(index),
   exportDocument:(kind)=>exportRef.current(kind),
 }),[commit,flush])
 useEffect(()=>onSaveStateChange?.(save.state.status),[save.state.status,onSaveStateChange])
 useEffect(()=>{
  if(save.state.status!=='saved'||!onDocumentAdopt)return
  let active=true
  void notes.loadNote(document.id).then(authoritative=>{
   if(active&&authoritative.id===document.id)onDocumentAdopt(authoritative)
  }).catch(()=>undefined)
  return()=>{active=false}
 },[document.id,notes,onDocumentAdopt,save.savedRevision,save.state.status])
 useEffect(()=>setTitle(document.title),[document.title])
 const update=(content:NoteContent)=>{save.update(content);onDraftChange?.(contentOutlineMarkdown({content}))}
 const action=async(fn:()=>Promise<unknown>):Promise<boolean>=>{setError(null);try{await fn();return true}catch{setError('操作未完成，请检查保存状态后重试。');return false}}
 const readOnly=blocked||exporting
 const exportDocument=async(kind:'word'|'pdf'):Promise<boolean>=>{
  if(readOnly)return false
  setExporting(true)
  const succeeded=await action(async()=>{
   if(!await flush())throw new Error('Save failed')
   if(kind==='word'){
    const current=await notes.loadNote(document.id)
    const {buildDocumentDocx}=await import('./documentExport')
    const bytes=await buildDocumentDocx(current,assetReader)
    await files?.saveDocumentExport?.(document.id,bytes,current.title)
   }else if(body.current){
    await printDocument(body.current.querySelector<HTMLElement>('.tiptap')??body.current,title)
   }
  })
  setExporting(false)
  return succeeded
 }
 exportRef.current=exportDocument

  return <div className="typed-editor">
  <div className="typed-editor__header">
   <input className="typed-editor__title" aria-label="笔记标题" value={title} readOnly={readOnly||!props.onRenameNote} onChange={e=>setTitle(e.target.value)} onBlur={()=>{if(title.trim()&&title!==document.title&&props.onRenameNote)void action(async()=>{if(!await flush())throw new Error();await props.onRenameNote!(title.trim())})}}/>
  </div>
  <div className="typed-editor__metadata"><span>最后编辑于 <time dateTime={save.updatedAt}>{formatLastEdited(save.updatedAt)}</time></span>{search&&<TagsEditor tags={document.tags} onChange={async tags=>{if(blocked||!await flush())throw new Error('save');await search.updateTags(document.id,tags);onDocumentAdopt?.(await notes.loadNote(document.id))}}/>}</div>
  {error&&<p role="alert">{error}</p>}
  {save.state.status==='error'&&<p role="alert">{save.state.message}<button type="button" onClick={save.state.retry}>重试保存</button>{save.state.message.includes('其他窗口')&&<button type="button" onClick={()=>void reloadLatest()}>载入最新版本</button>}</p>}
  <div className="typed-editor__body" ref={body}>
   {save.content.type==='text'&&<PlainTextEditor ref={text} value={save.content.text} editable={!readOnly} onChange={value=>update({type:'text',text:value})}/>}
   {save.content.type==='file'&&<FileViewer document={{...document,content:save.content}} files={files} onConvertToDocument={onConvertFileToDocument}/>}
   {save.content.type==='document'&&<Suspense fallback={<p role="status">正在打开文档…</p>}><RichDocumentEditor ref={rich} value={save.content.document} onChange={value=>update({type:'document',document:value})} editable={!readOnly} noteId={document.id} assets={assets} assetReader={assetReader} links={links} external={external} onNavigateNote={onNavigateNote} onNavigateEntry={onNavigateNote}/></Suspense>}
  </div>
  {links&&onNavigateNote&&<Backlinks noteId={document.id} links={links} onNavigate={onNavigateNote} refreshToken={`${save.updatedAt}:${save.state.status}`}/>}
 </div>
})
