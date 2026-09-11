import '@testing-library/jest-dom/vitest'
import {act,cleanup,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {createRef} from 'react'
import {note,fakeNotePort} from '../../test/fakes'
import type {EditorPaneHandle} from '../editor/EditorPane'
import {TypedEditorPane} from './TypedEditorPane'
const exportMock = vi.hoisted(() => vi.fn(async () => new Uint8Array([80,75])))
vi.mock('./documentExport', () => ({buildDocumentDocx: exportMock}))
vi.mock('../document/RichDocumentEditor', () => ({RichDocumentEditor: () => <article>文档正文</article>}))
afterEach(() => {cleanup();vi.clearAllMocks()})
it('opens plain text without Markdown view controls and participates in save barriers',async()=>{
 const ref=createRef<EditorPaneHandle>()
 render(<TypedEditorPane ref={ref} document={{...note(''),content:{type:'text',text:'==原文=='}}} notes={fakeNotePort()}/>)
 expect(screen.getByRole('textbox',{name:'纯文本正文'})).toHaveTextContent('==原文==')
 expect(screen.queryByRole('button',{name:'分栏校对'})).not.toBeInTheDocument()
 await act(async()=>{await ref.current?.beginEditBarrier();expect(await ref.current?.flush()).toBe(true)})
 expect(screen.getByRole('textbox',{name:'纯文本正文'})).toHaveAttribute('contenteditable','false')
 act(()=>ref.current?.endEditBarrier())
 expect(screen.getByRole('textbox',{name:'纯文本正文'})).toHaveAttribute('contenteditable','true')
})

it('offers DOCX and PDF actions for documents without treating them as managed files', async () => {
 const saveDocumentExport=vi.fn(async()=>true)
 const files={chooseFiles:vi.fn(),importFiles:vi.fn(),readFile:vi.fn(),saveFileAs:vi.fn(),openFile:vi.fn(),saveDocumentExport}
 const document={...note(''),content:{type:'document' as const,document:{schemaVersion:1 as const,root:{type:'doc',content:[{type:'paragraph'}]}}}}
 render(<TypedEditorPane document={document} notes={fakeNotePort()} files={files}/>)
 expect(screen.queryByRole('button',{name:'另存原文件'})).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'打印 / 保存 PDF'})).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'导出 Word'})).not.toBeInTheDocument()
})
