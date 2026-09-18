import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { RichDocument } from '../src/domain/content'
import { RichDocumentEditor } from '../src/features/document/RichDocumentEditor'
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
      ],
    },
  })
  return <main className="main-window"><RichDocumentEditor value={value} onChange={setValue} /></main>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
