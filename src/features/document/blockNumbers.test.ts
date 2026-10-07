import {describe,it,expect} from 'vitest'
import {documentBlockCount} from './blockNumbers'
describe('document blocks',()=>{
 it('counts text, image and table as single blocks, without counting table cells',()=>{
  expect(documentBlockCount({schemaVersion:1,root:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'内容'}]},{type:'image'},{type:'table',content:[{type:'tableRow',content:[{type:'tableCell',content:[{type:'paragraph',content:[{type:'text',text:'内容'}]}]}]}]},{type:'bulletList',content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'内容'}]}]},{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'内容'}]}]}]}]}})).toBe(5)
 })
})

it('numbers empty paragraphs as editable content blocks',()=>{
 expect(documentBlockCount({schemaVersion:1,root:{type:'doc',content:[{type:'paragraph'},{type:'heading',attrs:{level:2},content:[{type:'text',text:'标题'}]}]}})).toBe(2)
})
