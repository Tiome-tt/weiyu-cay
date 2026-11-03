import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {SettingsView} from '../src/features/settings/SettingsView'
import {DEFAULT_APP_SETTINGS} from '../src/features/settings/theme'
import {RichDocumentEditor} from '../src/features/document/RichDocumentEditor'
import {MarkdownSource} from '../src/features/editor/MarkdownSource'
import {emptyRichDocument} from '../src/domain/content'
import type {SettingsPort} from '../src/domain/ports'
import '../src/styles/tokens.css'
import '../src/styles/app.css'
import '../src/styles/main-window.css'
const port:SettingsPort={load:async()=>DEFAULT_APP_SETTINGS,update:async patch=>({...DEFAULT_APP_SETTINGS,...patch}),reset:async()=>DEFAULT_APP_SETTINGS,getStorageInfo:async()=>({root:'Local library',noteBytes:0,assetBytes:0,trashBytes:0}),moveStorageRoot:async()=>undefined,restartApplication:async()=>undefined,onChanged:async()=>()=>undefined,setShortcutRecording:async()=>undefined,getShortcutStatus:async()=>({current:null,registration:{state:'active'},acceptingTriggers:true,startupError:null})}
function Fixture(){
 const [value,setValue]=useState(DEFAULT_APP_SETTINGS)
 const [rich,setRich]=useState(emptyRichDocument())
 const [markdown,setMarkdown]=useState('# 中文用户内容\n\n| A | B |\n| --- | --- |\n| 原文 | text |')
 const mode=new URLSearchParams(location.search).get('mode')
 return <main className="main-window" style={{height:'100vh'}}>{mode==='rich'?<RichDocumentEditor value={rich} onChange={setRich}/>:mode==='markdown'?<MarkdownSource markdown={markdown} onChange={setMarkdown}/>:<SettingsView settings={port} value={value} onChange={setValue} onClose={()=>undefined} prepareStorageMove={async()=>null}/>}</main>
}
createRoot(document.getElementById('root')!).render(<Fixture/> )
