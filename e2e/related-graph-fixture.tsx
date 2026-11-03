import {RichDocumentEditor} from '../src/features/document/RichDocumentEditor'
import {emptyRichDocument} from '../src/domain/content'
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import type {NoteId} from '../src/domain/model'
import type {LinkPort} from '../src/domain/ports'
import {Backlinks} from '../src/features/editor/Backlinks'
import {EditorStatusBar} from '../src/features/editor/EditorStatusBar'
import '../src/styles/tokens.css'
import '../src/styles/app.css'
import '../src/styles/main-window.css'
const ids=[1,2,3,4].map(n=>`019c0000-0000-7000-8000-00000000000${n}` as NoteId)
const titles=['当前笔记','公文写作','申论基础','综合练习']
const links:LinkPort={
 listTargets:async()=>[],resolve:async()=>null,backlinks:async()=>[],renameTargetLabels:async()=>({updated:0,failedSourceIds:[],failure:null}),
 neighborhood:async(id)=>{
  const distances=[[0,1,1,2],[1,0,2,3],[1,2,0,1],[2,3,1,0]][ids.indexOf(id)]
  const nodes=ids.map((value,index)=>({id:value,title:titles[index],distance:distances[index]})).filter(node=>node.distance<=2)
  return {nodes,edges:[{source:ids[1],target:ids[0]},{source:ids[0],target:ids[2]},{source:ids[2],target:ids[3]}].filter(edge=>nodes.some(node=>node.id===edge.source)&&nodes.some(node=>node.id===edge.target)),truncated:false}
 },
}
function App(){
 const [active,setActive]=useState(ids[0])
 const [document,setDocument]=useState(emptyRichDocument())
 return <main className="main-window" style={{height:'100vh',display:'flex',flexDirection:'column'}}>
  {new URLSearchParams(location.search).has('rich') ? <div className="typed-editor__body"><RichDocumentEditor value={document} onChange={setDocument}/></div> : <article style={{flex:1,minHeight:0,padding:40}}><h1>{titles[ids.indexOf(active)]}</h1><p>笔记正文</p></article>}
  <EditorStatusBar text="笔记正文" updatedAt="2026-11-02T08:00:00Z" state={{status:'saved'}} related={<Backlinks noteId={active} noteTitle={titles[ids.indexOf(active)]} links={links} onNavigate={setActive}/>}/>
 </main>
}
createRoot(document.getElementById('root')!).render(<App/> )
