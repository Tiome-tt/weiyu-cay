import { createRoot } from 'react-dom/client'
import { HtmlPreview } from '../src/features/content/HtmlPreview'
import type { NoteId } from '../src/domain/model'
import '../src/features/content/content.css'
const createPreview = async () => 'http://html-preview.test/token'
createRoot(document.getElementById('root')!).render(<HtmlPreview noteId={'019c0000-0000-7000-8000-000000000901' as NoteId} revision={1} createPreview={createPreview}/> )
