import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownSource } from '../src/features/editor/MarkdownSource'
import { tableMarkdownFromCells } from '../src/features/editor/markdownActions'
import { RichDocumentEditor } from '../src/features/document/RichDocumentEditor'
import { AiSummaryWidget } from '../src/features/ai/AiSummaryWidget'
import { WorkspaceSearchDialog } from '../src/features/search/WorkspaceSearchDialog'
import type { FolderId } from '../src/domain/model'
import '../src/styles/tokens.css'
import '../src/styles/app.css'
import '../src/styles/main-window.css'

function Fixture() {
  const [markdown, setMarkdown] = useState(tableMarkdownFromCells(Array.from({ length: 25 }, (_, r) => Array.from({ length: 12 }, (_, c) => `R${r}C${c}`))))
  const mode = new URLSearchParams(window.location.search).get('mode')
  return <main className="main-window" style={{ height: '100vh', padding: 30, boxSizing: 'border-box' }}>
    {mode === 'search' ? <WorkspaceSearchDialog search={{ search: async () => [] }} folders={Array.from({ length: 30 }, (_, i) => ({ id: `folder-${i}` as FolderId, name: `文件夹 ${i}`, parentId: null, sortOrder: i }))} onSelect={async () => true} onClose={() => {}} />
      : mode === 'ai' ? <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <div style={{ height: '100%', paddingTop: 80 }}><RichDocumentEditor value={{ schemaVersion: 1, root: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }] } }} onChange={() => {}} /></div>
        <AiSummaryWidget title="测试" markdown="正文" />
      </div> : <div className="editor-document" style={{ width: '100%', height: '100%', gridTemplateRows: 'minmax(0, 1fr)' }}><div className="editor-document__body editor-document__body--source"><MarkdownSource markdown={markdown} onChange={setMarkdown} /></div></div>}
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
