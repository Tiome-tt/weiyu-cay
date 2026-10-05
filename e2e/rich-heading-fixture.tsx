import type { NoteDocument, NoteId } from '../src/domain/model'
import { TypedEditorPane } from '../src/features/content/TypedEditorPane'
import { createE2EAppServices } from '../src/app/e2eServices'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RichDocument } from '../src/domain/content'
import { RichDocumentEditor } from '../src/features/document/RichDocumentEditor'
import { MarkdownSource } from '../src/features/editor/MarkdownSource'
import '../src/styles/tokens.css'
import '../src/styles/app.css'
import '../src/styles/main-window.css'

function Fixture() {
  const [value, setValue] = useState<RichDocument>({
    schemaVersion: 1,
    root: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '上方正文' }] },
        { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Self-Attention' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '下方正文' }] },
        ...(new URLSearchParams(window.location.search).has('blocks') ? [
          {type:'image',attrs:{src:'assets/screenshot-019c0000-0000-7000-8000-000000000002.png',alt:'测试图片',width:240}},
          {type:'table',content:[{type:'tableRow',content:[{type:'tableCell',content:[{type:'paragraph',content:[{type:'text',text:'单元格一'}]}]},{type:'tableCell',content:[{type:'paragraph',content:[{type:'text',text:'单元格二'}]}]}]}]},
        ] : []),
      ],
    },
  })
  const [markdown,setMarkdown]=useState('# 标题\n\n正文内容')
  const pane = new URLSearchParams(window.location.search).get('pane')
  if(pane==='markdown')return <main className="main-window" style={{height:'100vh'}}><MarkdownSource markdown={markdown} onChange={setMarkdown}/></main>
  if (pane === 'document' || pane === 'text') {
    const services = createE2EAppServices()
    const document: NoteDocument = {
      id: '019c0000-0000-7000-8000-000000000702' as NoteId,
      kind: 'formal', title: pane === 'document' ? '文档笔记' : '纯文本笔记',
      folderId: null, tags: [], markdown: '', revision: 0,
      createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z',
      content: pane === 'document' ? {type:'document',document:value} : {type:'text',text:'这是一段纯文本。'},
    }
    return <main className="main-window" style={{height:'100vh'}}><TypedEditorPane document={document} notes={services.notes} search={services.search}/></main>
  }
  return <main className="main-window"><RichDocumentEditor value={value} onChange={setValue} /></main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
