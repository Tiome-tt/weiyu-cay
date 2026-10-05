import {Editor} from '@tiptap/core'
import {it,expect} from 'vitest'
import {richEditorExtensions} from './extensions'
import {captureFormat,applyFormat} from './formatPainter'
it('copies formatting once without copying text or link destinations',()=>{
 const editor=new Editor({extensions:richEditorExtensions(),content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'源',marks:[{type:'bold'},{type:'font',attrs:{family:'sans',size:'16'}},{type:'link',attrs:{href:'https://example.com'}}]},{type:'text',text:'目标'}]}]}})
 editor.commands.setTextSelection({from:1,to:2})
 const format=captureFormat(editor)
 editor.commands.setTextSelection({from:2,to:4})
 applyFormat(editor,format)
 expect(editor.getText()).toBe('源目标')
 const target=editor.getJSON().content?.[0].content?.slice(-1)[0]
 expect(target).toMatchObject({text:'目标'})
 expect(target?.marks).toHaveLength(2)
 expect(target?.marks).toEqual(expect.arrayContaining([{type:'bold'},{type:'font',attrs:{family:'sans',size:'16'}}]))
 expect(editor.commands.undo()).toBe(true)
 expect(editor.getJSON().content?.[0].content?.slice(-1)[0]?.marks).toBeUndefined()
 editor.destroy()
})

it('paints heading levels and restores paragraph style without copying markers as content',()=>{
 const editor=new Editor({extensions:richEditorExtensions(),content:{type:'doc',content:[{type:'heading',attrs:{level:4,sourceMarker:true},content:[{type:'text',text:'#### 源标题'}]},{type:'paragraph',content:[{type:'text',text:'目标'}]}]}})
 editor.commands.setTextSelection({from:6,to:9})
 const format=captureFormat(editor)
 let destination=0
 editor.state.doc.descendants((node,pos)=>{if(node.type.name==='paragraph'&&node.textContent==='目标')destination=pos+1})
 editor.commands.setTextSelection({from:destination,to:destination+2})
 applyFormat(editor,format)
 expect(editor.getJSON().content?.[1]).toMatchObject({type:'heading',attrs:{level:4},content:[{text:'#### 目标'}]})
 editor.destroy()
})

it('paints paragraph style over a heading and undoes the level change',()=>{
 const editor=new Editor({extensions:richEditorExtensions(),content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'正文源'}]},{type:'heading',attrs:{level:4,sourceMarker:true},content:[{type:'text',text:'#### 目标'}]}]}})
 editor.commands.setTextSelection({from:1,to:4})
 const format=captureFormat(editor)
 let destination=0
 editor.state.doc.descendants((node,pos)=>{if(node.type.name==='heading')destination=pos+6})
 editor.commands.setTextSelection({from:destination,to:destination+2})
 expect(applyFormat(editor,format)).toBe(true)
 expect(editor.getJSON().content?.[1]).toMatchObject({type:'paragraph',content:[{text:'目标'}]})
 expect(editor.commands.undo()).toBe(true)
 expect(editor.getJSON().content?.[1]).toMatchObject({type:'heading',attrs:{level:4},content:[{text:'#### 目标'}]})
 editor.destroy()
})
