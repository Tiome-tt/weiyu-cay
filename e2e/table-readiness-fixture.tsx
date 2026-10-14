import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RichDocument } from '../src/domain/content'
import { MarkdownSource } from '../src/features/editor/MarkdownSource'
import { RichDocumentEditor } from '../src/features/document/RichDocumentEditor'
import { tableMarkdownFromCells } from '../src/features/editor/markdownActions'
import '../src/styles/tokens.css'
import '../src/styles/app.css'
import '../src/styles/main-window.css'
function Fixture() {
  const [markdown, setMarkdown] = useState(tableMarkdownFromCells([['A','B','C'],['one','two','three'],['four','five','six']]))
  const [rich, setRich] = useState<RichDocument>({ schemaVersion: 1, root: { type: 'doc', content: [{ type: 'table', content: Array.from({ length: 3 }, (_, r) => ({ type: 'tableRow', content: Array.from({ length: 3 }, (_, c) => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: `selectable cell ${r}-${c}` }] }] })) })) }, { type: 'paragraph', content: [{ type: 'text', text: 'after table' }] }] } })
  return <main className="main-window" style={{ height: '100vh', padding: 30, boxSizing: 'border-box' }}>
    <output hidden data-testid="saved-markdown">{markdown}</output>
    <output hidden data-testid="saved-rich">{JSON.stringify(rich)}</output>
    <div className="editor-document" style={{ height: '100%', gridTemplateRows: 'minmax(0,1fr)' }}><div className="editor-document__body editor-document__body--source">
      {new URLSearchParams(location.search).has('rich') ? <RichDocumentEditor value={rich} onChange={setRich} /> : <MarkdownSource markdown={markdown} onChange={setMarkdown} />}
    </div></div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
