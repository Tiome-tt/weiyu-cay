import type {Editor} from '@tiptap/core'
import type {Mark} from '@tiptap/pm/model'
const copiedMarks=new Set(['bold','italic','strike','underline','font','highlight','subscript','superscript'])
export interface PaintedFormat { from:number; to:number; marks:Mark[]; alignment:string|null; headingLevel:number|null }
export function captureFormat(editor:Editor):PaintedFormat {
 const selection=editor.state.selection
 let marks=editor.state.storedMarks??selection.$from.marks()
 if(!selection.empty) {
  let found=false
  editor.state.doc.nodesBetween(selection.from,selection.to,node=>{if(node.isText&&!found){marks=node.marks;found=true}return !found})
 }
 return {from:selection.from,to:selection.to,marks:marks.filter(mark=>copiedMarks.has(mark.type.name)),headingLevel:selection.$from.parent.type.name==='heading'?Number(selection.$from.parent.attrs.level):null,alignment:typeof selection.$from.parent.attrs.textAlign==='string'?selection.$from.parent.attrs.textAlign:null}
}
export function applyFormat(editor:Editor,format:PaintedFormat):boolean {
 const {from,to,empty}=editor.state.selection
 if(empty || (from===format.from && to===format.to))return false
 const tr=editor.state.tr
 for(const name of copiedMarks)if(editor.schema.marks[name])tr.removeMark(from,to,editor.schema.marks[name])
 for(const mark of format.marks)tr.addMark(from,to,mark)
 editor.state.doc.nodesBetween(from,to,(node,pos)=>{
  if(!['paragraph','heading'].includes(node.type.name))return
  const contentStart=pos+1
  if(node.type.name==='heading' && node.attrs.sourceMarker) {
    const prefix=node.textContent.match(/^#{1,6} ?/)?.[0] ?? ''
    const replacement=format.headingLevel ? '#'.repeat(format.headingLevel)+' ' : ''
    tr.insertText(replacement,tr.mapping.map(contentStart),tr.mapping.map(contentStart+prefix.length))
  }
  const type=format.headingLevel?editor.schema.nodes.heading:editor.schema.nodes.paragraph
  tr.setNodeMarkup(tr.mapping.map(pos),type,{textAlign:format.alignment,...(format.headingLevel?{level:format.headingLevel,sourceMarker:node.type.name==='heading'&&node.attrs.sourceMarker}: {})})
 })
 editor.view.dispatch(tr)
 return true
}
