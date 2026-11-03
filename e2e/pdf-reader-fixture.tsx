import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { jsPDF } from 'jspdf'
import type { NoteDocument, NoteId } from '../src/domain/model'
import type { FilePort, WindowPreferenceMap, WindowPreferencePort } from '../src/domain/ports'
import { TypedEditorPane } from '../src/features/content/TypedEditorPane'
import '../src/styles/tokens.css'
import '../src/styles/app.css'

const pdf = new jsPDF()
for (let page = 1; page <= 8; page++) {
  if (page > 1) pdf.addPage()
  pdf.text(`Reading position test - page ${page}`, 20, 25)
  for (let line = 0; line < 30; line++) pdf.text(`Line ${line + 1}: local PDF reading`, 20, 40 + line * 7)
}
const bytes = new Uint8Array(pdf.output('arraybuffer'))
const document: NoteDocument = {
  id: '019c0000-0000-7000-8000-000000000901' as NoteId,
  kind: 'formal', title: '阅读位置.pdf', folderId: null, tags: [], markdown: '', revision: 1,
  createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z',
  content: { type: 'file', file: { storageName: 'payload.bin', originalName: 'reading.pdf', mediaType: 'application/pdf', size: bytes.length, sha256: 'pdf-reading-fixture' } },
}
const preferences: WindowPreferencePort = {
  async getWindowPreference<Key extends keyof WindowPreferenceMap>(key: Key) {
    const saved = localStorage.getItem(key)
    return saved === null ? undefined : JSON.parse(saved) as WindowPreferenceMap[Key]
  },
  async setWindowPreference(key, value) { localStorage.setItem(key, JSON.stringify(value)) },
}
const files: FilePort = {
  chooseFiles: async () => [], importFiles: async () => ({ imported: [], failed: [] }),
  readFile: async () => ({ mediaType: 'application/pdf', bytes: bytes.slice() }),
  openFile: async () => {}, saveFileAs: async () => false,
}
const notes = { loadNote: async () => document, saveNote: async (value: NoteDocument) => value }
function App() {
  const [open, setOpen] = useState(true)
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <button onClick={() => setOpen(value => !value)}>{open ? '关闭 PDF' : '打开 PDF'}</button>
    <div style={{ flex: 1, minHeight: 0 }}>{open && <TypedEditorPane document={document} notes={notes} files={files} preferences={preferences}/>}</div>
  </div>
}
createRoot(window.document.getElementById('root')!).render(<App/> )
