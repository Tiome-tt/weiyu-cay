import type {RichDocument, RichNode} from '../../domain/content'
export const numberedBlockTypes=new Set(['paragraph','heading','codeBlock','image','table','horizontalRule','rawMarkdown','mathBlock','attachment'])
export function documentBlockCount(document:RichDocument):number {
 const count=(node:RichNode):number=>numberedBlockTypes.has(node.type)?1:(node.content??[]).reduce((total,child)=>total+count(child),0)
 return count(document.root)
}
