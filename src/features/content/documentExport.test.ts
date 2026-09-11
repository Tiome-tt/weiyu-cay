import {expect,it} from 'vitest'
import {buildDocumentDocx} from './documentExport'
import {note} from '../../test/fakes'
import {inflateRawSync} from 'node:zlib'
it('exports Chinese text and merged table cells into real DOCX XML',async()=>{

 const paragraph = {type:'paragraph',content:[{type:'text',text:'微屿文档',marks:[{type:'highlight',attrs:{color:'yellow'}}]}]}
 const cell = {type:'tableCell',attrs:{colspan:2,rowspan:1},content:[{type:'paragraph',content:[{type:'text',text:'合并内容'}]}]}
 const table = {type:'table',content:[{type:'tableRow',content:[cell]}]}
 const bytes=await buildDocumentDocx({...note(''),content:{type:'document',document:{schemaVersion:1,root:{type:'doc',content:[paragraph,table]}}}})

 const data=Buffer.from(bytes)
 let xml=''
 for(let i=0;i+30<data.length;){
  if(data.readUInt32LE(i)!==0x04034b50)break
  const method=data.readUInt16LE(i+8),size=data.readUInt32LE(i+18),nameLength=data.readUInt16LE(i+26),extra=data.readUInt16LE(i+28)
  const name=data.subarray(i+30,i+30+nameLength).toString()
  const start=i+30+nameLength+extra
  if(name==='word/document.xml'){const value=data.subarray(start,start+size);xml=(method===8?inflateRawSync(value):value).toString()}
  i=start+size
 }
 expect(xml).toContain('微屿文档')
 expect(xml).toContain('合并内容')
 expect(xml).toContain('w:gridSpan w:val="2"')
 expect(xml).toContain('w:highlight')
})
