import '@testing-library/jest-dom/vitest'
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {FileViewer} from './FileViewer'
import {note} from '../../test/fakes'
import type {FilePort} from '../../domain/ports'
afterEach(cleanup)
it('shows an attachment and explains external edits without reading executable bytes',async()=>{
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn(),saveFileAs:async()=>true,openFile:vi.fn()}
 render(<FileViewer document={{...note(''),content:{type:'file',file:{storageName:'x',originalName:'工具.exe',mediaType:'application/octet-stream',size:12,sha256:'x'}}}} files={files}/> )
 expect(screen.getByText('工具.exe')).toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'用系统应用打开'})).not.toBeInTheDocument()
 expect(files.readFile).not.toHaveBeenCalled()
})
it('shows the PDF format in its themed file icon',()=>{
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn().mockResolvedValue({mediaType:'application/pdf',bytes:new Uint8Array([37,80,68,70,45])}),saveFileAs:async()=>true,openFile:vi.fn()}
 render(<FileViewer document={{...note(''),content:{type:'file',file:{storageName:'x',originalName:'resume.pdf',mediaType:'application/pdf',size:12,sha256:'x'}}}} files={files}/> )
 expect(screen.getByTestId('icon-file-pdf')).toHaveTextContent('PDF')
})
it('uses the binary file port for PDF previews',async()=>{
 const readFile=vi.fn().mockResolvedValue({mediaType:'application/pdf',bytes:new Uint8Array([37,80,68,70,45])})
 const readFileBytes=vi.fn().mockResolvedValue(new Uint8Array([37,80,68,70,45]))
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile,readFileBytes,saveFileAs:async()=>true,openFile:async()=>{}}
 render(<FileViewer document={{...note(''),content:{type:'file',file:{storageName:'x',originalName:'resume.pdf',mediaType:'application/pdf',size:12,sha256:'x'}}}} files={files}/>)
 await waitFor(()=>expect(readFileBytes).toHaveBeenCalled())
 expect(readFile).not.toHaveBeenCalled()
})
it('falls back to the structured reader when binary preview loading fails',async()=>{
 const readFileBytes=vi.fn().mockRejectedValue(new Error('binary command unavailable'))
 const readFile=vi.fn().mockResolvedValue({mediaType:'application/pdf',bytes:new Uint8Array([37,80,68,70,45])})
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile,readFileBytes,saveFileAs:async()=>true,openFile:async()=>{}}
 const document={...note(''),content:{type:'file' as const,file:{storageName:'x',originalName:'resume.pdf',mediaType:'application/pdf',size:12,sha256:'fallback-test'}}}
 render(<FileViewer document={document} files={files}/> )
 await waitFor(()=>expect(readFileBytes).toHaveBeenCalledOnce())
 await waitFor(()=>expect(readFile).toHaveBeenCalledOnce())
})
it('falls back after PDF.js rejects binary data',async()=>{
 const readFileBytes=vi.fn().mockResolvedValue(new Uint8Array([37,80,68,70,45]))
 const readFile=vi.fn().mockResolvedValue({mediaType:'application/pdf',bytes:new Uint8Array([37,80,68,70,45])})
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile,readFileBytes,saveFileAs:async()=>true,openFile:async()=>{}}
 const document={...note(''),content:{type:'file' as const,file:{storageName:'x',originalName:'broken.pdf',mediaType:'application/pdf',size:12,sha256:'parser-fallback'}}}
 render(<FileViewer document={document} files={files}/> )
 await waitFor(()=>expect(readFile).toHaveBeenCalledOnce(),{timeout:5000})
})
it('reuses cached preview bytes when reopening the same file revision',async()=>{
 const readFileBytes=vi.fn().mockResolvedValue(new Uint8Array([37,80,68,70,45]))
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn().mockResolvedValue({mediaType:'application/pdf',bytes:new Uint8Array([37,80,68,70,45])}),readFileBytes,saveFileAs:async()=>true,openFile:async()=>{}}
 const document={...note(''),content:{type:'file' as const,file:{storageName:'x',originalName:'resume.pdf',mediaType:'application/pdf',size:12,sha256:'cache-test'}}}
 const first=render(<FileViewer document={document} files={files}/> )
 await waitFor(()=>expect(readFileBytes).toHaveBeenCalledOnce())
 first.unmount()
 render(<FileViewer document={document} files={files}/> )
 await waitFor(()=>expect(screen.getByText('resume.pdf')).toBeInTheDocument())
 expect(readFileBytes).toHaveBeenCalledOnce()
})
it('keeps a failed image preview actionable',async()=>{
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn().mockRejectedValue(new Error('missing')),saveFileAs:async()=>true,openFile:async()=>{}}
 render(<FileViewer document={{...note(''),content:{type:'file',file:{storageName:'x',originalName:'照片.png',mediaType:'image/png',size:12,sha256:'x'}}}} files={files}/>)
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('无法读取'))
 expect(screen.getByRole('button',{name:'另存文件'})).toBeEnabled()
})
it('offers a themed DOCX conversion action when a converter is available',async()=>{
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn().mockResolvedValue({mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:new Uint8Array([1])}),saveFileAs:async()=>true,openFile:async()=>{}}
 const convert=vi.fn(async()=>{})
 const document={...note(''),content:{type:'file' as const,file:{storageName:'x',originalName:'会议.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:12,sha256:'x'}}}
 render(<FileViewer document={document} files={files} onConvertToDocument={convert}/>)
 await screen.findByRole('button',{name:'转为可编辑文档'})
 expect(screen.getByTestId('icon-file-word')).toBeInTheDocument()
 expect(screen.getAllByText(/Word 文档/).length).toBeGreaterThan(0)
 fireEvent.click(await screen.findByRole('button',{name:'转为可编辑文档'}))
 await waitFor(()=>expect(convert).toHaveBeenCalledWith(document,expect.any(Uint8Array)))
})
it('does not offer system opening for an empty Office payload',()=>{
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn(),saveFileAs:async()=>true,openFile:vi.fn()}
 const document={...note(''),content:{type:'file' as const,file:{storageName:'x',originalName:'空白.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:0,sha256:'x'}}}
 render(<FileViewer document={document} files={files}/> )
 expect(screen.queryByRole('button',{name:'用系统应用打开'})).not.toBeInTheDocument()
 expect(screen.getByText(/无法直接用系统应用打开/)).toBeInTheDocument()
})
