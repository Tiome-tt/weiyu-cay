import '@testing-library/jest-dom/vitest'
import {act,cleanup,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {createRef} from 'react'
import {note,fakeNotePort} from '../../test/fakes'
import type {EditorPaneHandle} from '../editor/EditorPane'
import {TypedEditorPane} from './TypedEditorPane'
const exportMock = vi.hoisted(() => vi.fn(async () => new Uint8Array([80,75])))
const pdfExportMock = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./documentExport', () => ({buildDocumentDocx: exportMock}))
vi.mock('./pdfExport', () => ({exportTypedDocumentToPdf: pdfExportMock}))
vi.mock('../document/RichDocumentEditor', () => ({
 RichDocumentEditor: ({onChange}: {onChange:(value:{schemaVersion:1;root:{type:'doc';content:Array<unknown>}})=>void}) => <button type='button' onClick={() => onChange({schemaVersion:1,root:{type:'doc',content:[]}})}>文档正文</button>,
}))
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

it('does not reload the editor while PDF export is waiting for the file save', async () => {
 let resolveExport: ((value:boolean)=>void) | undefined
 pdfExportMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveExport = resolve }))
 const document={...note(''),revision:1,content:{type:'document' as const,document:{schemaVersion:1 as const,root:{type:'doc' as const,content:[{type:'paragraph'}]}}}}
 const authoritative={...document,revision:2,updatedAt:'2026-09-14T18:00:00+08:00',content:{type:'document' as const,document:{schemaVersion:1 as const,root:{type:'doc' as const,content:[]}}}}
 const adopted=vi.fn()
 const notes=fakeNotePort({saveNote:vi.fn().mockResolvedValue(authoritative),loadNote:vi.fn().mockResolvedValue(authoritative)})
 const files={chooseFiles:vi.fn(),importFiles:vi.fn(),readFile:vi.fn(),saveFileAs:vi.fn(),openFile:vi.fn(),savePdfExport:vi.fn()}
 const ref=createRef<EditorPaneHandle>()
 render(<TypedEditorPane ref={ref} document={document} notes={notes} files={files} onDocumentAdopt={adopted}/>)
 act(() => screen.getByRole('button',{name:'文档正文'}).click())
 let exportPromise:Promise<boolean>
 await act(async()=>{exportPromise=ref.current!.exportDocument('pdf');await new Promise<void>((resolve)=>setTimeout(resolve,50))})
 expect(notes.saveNote).toHaveBeenCalledTimes(1)
 expect(notes.loadNote).not.toHaveBeenCalled()
 expect(adopted).not.toHaveBeenCalled()
 resolveExport?.(true)
 await act(async()=>{await exportPromise})
 expect(notes.loadNote).not.toHaveBeenCalled()
 expect(adopted).not.toHaveBeenCalled()
})
