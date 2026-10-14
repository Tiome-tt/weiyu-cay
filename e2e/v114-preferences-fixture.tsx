import {OfficePreview} from '../src/features/content/OfficePreview'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RichDocument } from '../src/domain/content'
import type { NoteDocument, NoteId, FolderId } from '../src/domain/model'
import { FolderTree } from '../src/features/library/FolderTree'
import { NoteList } from '../src/features/library/NoteList'
import { RichDocumentEditor } from '../src/features/document/RichDocumentEditor'
import { AppChrome } from '../src/shared/AppChrome'
import { Icon } from '../src/shared/Icon'
import {TypedEditorPane} from '../src/features/content/TypedEditorPane'
import type { FilePort, SettingsPort } from '../src/domain/ports'
import { EditorPane } from '../src/features/editor/EditorPane'
import { StickyWindow } from '../src/features/temporary/StickyWindow'
import { DailyLyricDisplay } from '../src/features/lyrics/DailyLyricDisplay'
import { SettingsView } from '../src/features/settings/SettingsView'
import { DEFAULT_APP_SETTINGS, themeStyle } from '../src/features/settings/theme'
import '../src/styles/tokens.css'
import '../src/styles/app.css'
import '../src/styles/main-window.css'

const note: NoteDocument = {
  id: '019c0000-0000-7000-8000-000000000002' as NoteId, kind: 'formal', title: '缩放测试', folderId: null, tags: [],
  markdown: Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 段文字，用于缩放和滚动检查。`).join('\n\n'),
  revision: 1, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z',
}
const settings: SettingsPort = {
  load: async () => DEFAULT_APP_SETTINGS, update: async patch => ({ ...DEFAULT_APP_SETTINGS, ...patch }), reset: async () => DEFAULT_APP_SETTINGS,
  getStorageInfo: async () => ({ root: 'Test library', noteBytes: 0, assetBytes: 0, trashBytes: 0 }),
  moveStorageRoot: async () => {}, restartApplication: async () => {}, onChanged: async () => () => {},
  setShortcutRecording: async () => {},
  getShortcutStatus: async () => ({ current: DEFAULT_APP_SETTINGS.shortcut, registration: { state: 'active' }, acceptingTriggers: true, startupError: null }),
}
function Fixture() {
  const requestedTheme=new URLSearchParams(location.search).get('theme')
  const theme=requestedTheme==='night'||requestedTheme==='light'||requestedTheme==='ocean'||requestedTheme==='sand' ? requestedTheme : DEFAULT_APP_SETTINGS.theme
  const [value, setValue] = useState({ ...DEFAULT_APP_SETTINGS, theme })
  const [exportKind, setExportKind] = useState('')
  const mode = new URLSearchParams(location.search).get('mode')
  if(mode==='rich-code'){
    const code:RichDocument={schemaVersion:1,root:{type:'doc',content:[{type:'codeBlock',attrs:{language:'java'},content:[{type:'text',text:'public class Demo { String value = "Cay"; }'}]}]}}
    return <main className="main-window" style={{...themeStyle(value),height:'100vh'}}><RichDocumentEditor value={code} onChange={()=>{}}/></main>
  }
  if(mode==='keyboard-rich')return <main className="app-shell main-window" style={{...themeStyle(value),height:'100vh'}}><RichDocumentEditor links={{listTargets:async()=>[]}} value={{schemaVersion:1,root:{type:'doc',content:[{type:'codeBlock',attrs:{language:'java'},content:[{type:'text',text:'public class Begin {}'}]},...Array.from({length:60},(_,index)=>({type:'paragraph',content:[{type:'text',text:`第 ${index+1} 段文字`}]})),{type:'paragraph'}]}}} onChange={()=>{}}/></main>
  if(mode==='file-edit')return <FileEditFixture/>
  if(mode==='office-content')return <OfficeContentFixture/>
  if(mode==='images')return <ImageFixture/>
  if(mode==='settings')return <main className="main-window" style={{...themeStyle(value),height:'100vh'}}><AppChrome windowChrome={{platform:'windows',startDragging:async()=>{},minimize:async()=>{},toggleMaximize:async()=>{},requestClose:async()=>{}}}><SettingsView value={value} settings={settings} onChange={setValue} onClose={()=>{}} prepareStorageMove={async()=>()=>{}}/></AppChrome></main>
  if (mode === 'sticky') return <StickyWindow note={{ ...note, kind: 'temporary' }} temporary={{ save: async () => ({ revision: 2, updatedAt: note.updatedAt }) }} windows={{ hide: async () => {}, startDragging: async () => {}, onCloseRequested: async () => () => {}, setAlwaysOnTop: async (_id, alwaysOnTop) => ({ noteId: note.id, visible: true, x: 0, y: 0, width: 360, height: 420, alwaysOnTop }) }} />
  return <main className="main-window" style={{ ...themeStyle(value), height: '100vh', padding: 30, boxSizing: 'border-box' }}>
    {mode === 'icons' ? <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0,1fr)', height: '100%', gap: 1 }}>
      <div className="library-pane library-pane--folders"><FolderTree folders={[{ id: '019c0000-0000-7000-8000-000000000021' as FolderId, name: '开始使用', parentId: null, sortOrder: 0 }]} activeId={'019c0000-0000-7000-8000-000000000021' as FolderId} state="ready" onSelect={() => {}} onTemporaryInbox={() => {}} onTrash={() => {}} onCreate={async () => {}} onRename={async () => {}} onMove={async () => {}} onDelete={async () => {}} searchSlot={<div style={{ padding: 12 }}><Icon name="search" size={18} /> 搜索笔记</div>} folderContents={<NoteList notes={[{ ...note, title: '欢迎来到微屿' }, { ...note, id: '019c0000-0000-7000-8000-000000000022' as NoteId, title: '灵感与计划', content: { type: 'document', document: { schemaVersion: 1, root: { type: 'doc' } } } }]} activeId={note.id} state="ready" onSelect={() => {}} files={{chooseExportDirectory:async()=> 'D:/FixtureExports'}} onSetStars={()=>{}} folders={[{id:'019c0000-0000-7000-8000-000000000021' as FolderId,name:'开始使用',parentId:null,sortOrder:0}]} onMoveSelection={async()=>{}} onExport={(_note, kind) => setExportKind(kind)} />} /></div>
      <section style={{ minWidth: 0, background: 'var(--color-surface)' }}><h1 style={{ padding: '8px 40px' }}>灵感与计划</h1><RichDocumentEditor value={{ schemaVersion: 1, root: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '把生活里的小小灵感，收进自己的岛屿。' }] }] } }} onChange={() => {}} /><output aria-label="选择的导出格式">{exportKind}</output></section>
    </div> : mode === 'settings' ? <SettingsView value={value} settings={settings} onChange={setValue} onClose={() => {}} prepareStorageMove={async () => () => {}} />
      : mode === 'poem' ? <div style={{ width: '100%', height: 30 }}><DailyLyricDisplay enabled /></div>
        : <EditorPane document={mode === 'keyboard-markdown' ? {...note,markdown:''} : mode === 'code' ? { ...note, markdown: '```java\npublic class Demo {\n  String value = "微屿"; // comment\n}\n```' } : mode === 'table' ? { ...note, markdown: '| A | B | C | D | E | F | G | H |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |\n\n尾段' } : note} notes={{ saveNote: async () => ({ revision: 2, updatedAt: note.updatedAt }), loadNote: async () => note }} />}
  </main>
}
function FileEditFixture(){
 const initial:NoteDocument={...note,title:'空白演示.pptx',markdown:'',content:{type:'file',file:{originalName:'空白演示.pptx',storageName:'payload-original.bin',mediaType:'application/octet-stream',size:0,sha256:'0'.repeat(64)}}}
 const [document,setDocument]=useState(initial)
 const [files]=useState<FilePort>(()=>{let edited=false,reported=false;return {
 chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:async()=>({mediaType:'application/octet-stream',bytes:new Uint8Array()}),saveFileAs:async()=>true,
 openFile:async()=>{edited=true},syncExternalFile:async()=>{if(!edited||reported)return null;reported=true;return {...initial,revision:2,content:{type:'file',file:{...(initial.content?.type==='file'?initial.content.file:{}),originalName:'空白演示.pptx',storageName:'payload-edited.bin',mediaType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',size:512,sha256:'1'.repeat(64)}}}},
 readOfficeParts:async()=>[{name:'ppt/slides/slide1.xml',text:'<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:t>外部编辑已保存</a:t></a:p></p:sld>'}]
 }})
 return <main className="app-shell main-window" style={{...themeStyle(DEFAULT_APP_SETTINGS),height:'100vh'}}><TypedEditorPane document={document} notes={{saveNote:async()=>({revision:3,updatedAt:note.updatedAt}),loadNote:async()=>document}} files={files} onDocumentAdopt={setDocument}/></main>
}
function ImageFixture(){
  const [reads,setReads]=useState(0)
  const [reader]=useState(()=>({readImage:async()=>{
    setReads(current=>current+1)
    return {mediaType:'image/png',bytes:Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='),character=>character.charCodeAt(0))}
  }}))
  const images:RichDocument={schemaVersion:1,root:{type:'doc',content:Array.from({length:40},(_,index)=>({type:'image',attrs:{src:`assets/screenshot-019c0000-0000-7000-8000-${String(index+1).padStart(12,'0')}.png`,width:320}}))}}
  return <main className="main-window" style={{...themeStyle(DEFAULT_APP_SETTINGS),height:'100vh',overflow:'auto'}}><output aria-label="图片读取数" style={{position:'fixed',top:0,right:0,zIndex:100}}>{reads}</output><RichDocumentEditor noteId={note.id} assetReader={reader} value={images} onChange={()=>{}}/></main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)

function OfficeContentFixture(){
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:async()=>({mediaType:'',bytes:new Uint8Array()}),openFile:async()=>{},saveFileAs:async()=>true,readOfficeParts:async()=>[
 {name:'xl/workbook.xml',text:'<workbook><sheets><sheet name="Sheet1"/></sheets></workbook>'},
 {name:'xl/worksheets/sheet1.xml',text:'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>123</v></c></row><row r="3"><c r="B3"><v>456</v></c></row></sheetData></worksheet>'},
 {name:'ppt/slides/slide1.xml',text:'<sld xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><pic><blip r:embed="rId1"/></pic></sld>'},
 {name:'ppt/slides/_rels/slide1.xml.rels',text:'<Relationships><Relationship Id="rId1" Target="../media/picture.png"/></Relationships>'},
 {name:'ppt/media/picture.png',text:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII='}
 ]}
 return <main className="main-window" style={{...themeStyle(DEFAULT_APP_SETTINGS),padding:24}}><OfficePreview noteId={note.id} extension="xlsx" files={files} empty={false}/><OfficePreview noteId={note.id} extension="pptx" files={files} empty={false}/></main>
}
