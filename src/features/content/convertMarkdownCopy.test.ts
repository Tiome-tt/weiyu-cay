import {expect,it,vi} from 'vitest'
import {convertMarkdownCopy} from './convertMarkdownCopy'
import {note,fakeNotePort} from '../../test/fakes'
import type {NoteId} from '../../domain/model'
const image='assets/screenshot-019c0000-0000-7000-8000-000000000003.png'
function setup(){
 const source={...note('![截图]('+image+')'),tags:['项目']}
 const copy={...note(''),id:'019c0000-0000-7000-8000-000000000099' as NoteId,content:{type:'document' as const,document:{schemaVersion:1 as const,root:{type:'doc'}}}}
 const notes=fakeNotePort({createNote:vi.fn(async()=>copy),saveNote:vi.fn(async value=>({...value,revision:value.revision+1}))})
 const assets={saveImage:vi.fn(async()=>({relativePath:image.replace('003','004'),width:1,height:1}))}
 const assetReader={readImage:vi.fn(async()=>({mediaType:'image/png',bytes:new Uint8Array([1])}))}
 const trash={trash:vi.fn(async(ids:NoteId[])=>({operationId:'rollback',trashed:ids,failed:[]}))}
 return{source,copy,ports:{notes,assets,assetReader,trash}}
}
it('creates an independent UUID and copies images and tags without writing the original',async()=>{
 const {source,copy,ports}=setup()
 const result=await convertMarkdownCopy(source,ports)
 expect(result.id).toBe(copy.id)
 expect(result.tags).toEqual(source.tags)
 expect(ports.assets.saveImage).toHaveBeenCalledWith(expect.objectContaining({noteId:copy.id}))
 expect(JSON.stringify(result.content)).toContain('000000000004.png')
 expect(ports.notes.saveNote).toHaveBeenCalledTimes(1)
 expect(source.markdown).toContain(image)
 expect(ports.trash.trash).not.toHaveBeenCalled()
})
it('recovers a failed copy through trash and never deletes the source',async()=>{
 const {source,copy,ports}=setup()
 ports.assets.saveImage.mockRejectedValue(new Error('disk full'))
 await expect(convertMarkdownCopy(source,ports)).rejects.toThrow()
 expect(ports.trash.trash).toHaveBeenCalledWith([copy.id])
 expect(ports.notes.saveNote).not.toHaveBeenCalled()
})
