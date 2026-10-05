import {numberedBlockTypes} from './documentBlockCount'
export {documentBlockCount} from './documentBlockCount'
import {Extension} from '@tiptap/core'
import {Plugin} from '@tiptap/pm/state'
import {Decoration, DecorationSet} from '@tiptap/pm/view'
export const BlockNumbers=Extension.create({
 name:'blockNumbers',
 addProseMirrorPlugins(){return [new Plugin({props:{decorations(state){
  const decorations:Decoration[]=[]; let number=0
  state.doc.descendants((node,pos)=>{
   if(!numberedBlockTypes.has(node.type.name))return
   // Inline attachments belong to their containing text block.
   if(node.isInline)return false
   decorations.push(Decoration.node(pos,pos+node.nodeSize,{'data-block-number':String(++number),'data-block-position':String(pos)}))
   return false
  })
  return DecorationSet.create(state.doc,decorations)
 }}})]},
})
