import '@testing-library/jest-dom/vitest'
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {FileViewer} from './FileViewer'
import {Icon} from '../../shared/Icon'
import {note} from '../../test/fakes'
import type {FilePort} from '../../domain/ports'
afterEach(cleanup)
it('shows an attachment and explains external edits without reading executable bytes',async()=>{
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn(),saveFileAs:async()=>true,openFile:vi.fn()}
 render(<FileViewer document={{...note(''),content:{type:'file',file:{storageName:'x',originalName:'工具.exe',mediaType:'application/octet-stream',size:12,sha256:'x'}}}} files={files}/> )
 expect(screen.queryByText('工具.exe')).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'用系统应用打开'})).not.toBeInTheDocument()
 expect(files.readFile).not.toHaveBeenCalled()
})
it('shows the PDF format in its themed file icon',()=>{
 render(<Icon name="file-pdf"/>)
 expect(screen.getByTestId('icon-file-pdf').querySelector('text')).toBeNull()
 expect(screen.getByTestId('icon-file-pdf').querySelector('path')).toBeInTheDocument()
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
 // PDF.js starts a worker even for malformed bytes; allow cold CI runners time
 // to load and reject the document before asserting the structured fallback.
 await waitFor(()=>expect(readFile).toHaveBeenCalledOnce(),{timeout:15000})
},20000)
it('reuses cached preview bytes when reopening the same file revision',async()=>{
 const readFileBytes=vi.fn().mockResolvedValue(new Uint8Array([37,80,68,70,45]))
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn().mockResolvedValue({mediaType:'application/pdf',bytes:new Uint8Array([37,80,68,70,45])}),readFileBytes,saveFileAs:async()=>true,openFile:async()=>{}}
 const document={...note(''),content:{type:'file' as const,file:{storageName:'x',originalName:'resume.pdf',mediaType:'application/pdf',size:12,sha256:'cache-test'}}}
 const first=render(<FileViewer document={document} files={files}/> )
 await waitFor(()=>expect(readFileBytes).toHaveBeenCalledOnce())
 first.unmount()
 render(<FileViewer document={document} files={files}/> )
 await waitFor(()=>expect(screen.getByRole('button',{name:'另存为'})).toBeInTheDocument())
 expect(readFileBytes).toHaveBeenCalledOnce()
})
it('keeps a failed image preview actionable',async()=>{
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn().mockRejectedValue(new Error('missing')),saveFileAs:async()=>true,openFile:async()=>{}}
 render(<FileViewer document={{...note(''),content:{type:'file',file:{storageName:'x',originalName:'照片.png',mediaType:'image/png',size:12,sha256:'x'}}}} files={files}/>)
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('无法读取'))
 expect(screen.getByRole('button',{name:'另存为'})).toBeEnabled()
})
it('offers a themed DOCX conversion action when a converter is available',async()=>{
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn().mockResolvedValue({mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:new Uint8Array([1])}),saveFileAs:async()=>true,openFile:async()=>{}}
 const convert=vi.fn(async()=>{})
 const document={...note(''),content:{type:'file' as const,file:{storageName:'x',originalName:'会议.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:12,sha256:'x'}}}
 render(<FileViewer document={document} files={files} onConvertToDocument={convert}/>)
 await screen.findByRole('button',{name:'转为可编辑文档'})
 expect(screen.queryByText(/这是一个完整的/)).not.toBeInTheDocument()
 fireEvent.click(await screen.findByRole('button',{name:'转为可编辑文档'}))
 await waitFor(()=>expect(convert).toHaveBeenCalledWith(document,expect.any(Uint8Array)))
})
it('can initialize an empty modern Office payload for editing',()=>{
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn(),saveFileAs:async()=>true,openFile:vi.fn()}
 const document={...note(''),content:{type:'file' as const,file:{storageName:'x',originalName:'空白.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:0,sha256:'x'}}}
 render(<FileViewer document={document} files={files}/> )
 expect(screen.queryByRole('button',{name:'用系统应用打开'})).not.toBeInTheDocument()
 expect(screen.queryByText(/文件内容为空/)).not.toBeInTheDocument()
 expect(screen.getByRole('button',{name:'打开进行编辑'})).toBeEnabled()
})
it('renders imported Office content directly and offers original format in Save As',async()=>{
 const saveFileAs=vi.fn(async()=>true)
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn(),readOfficeParts:async()=>[{name:'word/document.xml',text:'<document><body><p><r><t>会议正文</t></r></p></body></document>'}],saveFileAs,openFile:vi.fn()}
 render(<FileViewer document={{...note(''),content:{type:'file',file:{storageName:'x',originalName:'会议.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:12,sha256:'x'}}}} files={files}/>)
 expect(await screen.findByText('会议正文')).toBeInTheDocument()
 expect(screen.queryByText('会议.docx')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'另存为'}))
 expect(screen.getByRole('combobox',{name:'另存格式'})).toHaveValue('original')
 fireEvent.click(within(screen.getByRole('dialog',{name:'另存为'})).getByRole('button',{name:'另存为'}))
 await waitFor(()=>expect(saveFileAs).toHaveBeenCalledOnce())
})

it('allows editing an empty modern Office file and adopts synchronized revisions on focus',async()=>{
 const updated={...note(''),content:{type:'file' as const,file:{originalName:'blank.pptx',mediaType:'application/octet-stream',storageName:'payload-original.bin',size:5,sha256:'b'.repeat(64)}},revision:2}
 const syncExternalFile=vi.fn().mockResolvedValueOnce(null).mockResolvedValue(updated),adopt=vi.fn()
 const files:FilePort={chooseFiles:async()=>[],importFiles:async()=>({imported:[],failed:[]}),readFile:vi.fn(),saveFileAs:async()=>true,openFile:vi.fn(),syncExternalFile}
 render(<FileViewer document={{...updated,revision:1,content:{...updated.content,file:{...updated.content.file,size:0}}}} files={files} onDocumentAdopt={adopt}/>)
 expect(screen.getByRole('button',{name:'打开进行编辑'})).toBeEnabled()
 await waitFor(()=>expect(syncExternalFile).toHaveBeenCalled())
 fireEvent.focus(window)
 await waitFor(()=>expect(adopt).toHaveBeenCalledWith(updated))
 expect(document.querySelector('footer.file-viewer__actions')).toBeNull()
})
