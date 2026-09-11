import type {NoteDocument} from '../../domain/model'
import type {ImageReadPort} from '../../domain/ports'
import {displayInternalLinks} from '../editor/internalLinks'
import {applyMarkdownTableMerges,renderPreviewMarkdown} from '../editor/markdownPipeline'
import {printDocument} from './printDocument'

export async function prepareMarkdownPrint(note:NoteDocument,reader?:ImageReadPort) {
 const element=document.createElement('article')
 const markdown=displayInternalLinks(note.markdown)
 element.innerHTML=renderPreviewMarkdown(markdown)
 applyMarkdownTableMerges(element,markdown)
 const urls:string[]=[]
 const dispose=()=>urls.forEach(url=>URL.revokeObjectURL(url))
 try {
  for(const image of element.querySelectorAll<HTMLImageElement>('img[data-simple-notes-asset]')) {
   if(!reader)throw new Error('Images cannot be exported without an asset reader')
   const relativePath=image.getAttribute('data-simple-notes-asset')!
   const loaded=await reader.readImage({noteId:note.id,relativePath})
   const url=URL.createObjectURL(new Blob([loaded.bytes.slice().buffer],{type:loaded.mediaType}))
   urls.push(url);image.src=url
  }
  return {element,dispose}
 }catch(error){dispose();throw error}
}
export async function printMarkdown(note:NoteDocument,reader?:ImageReadPort) {
 const snapshot=await prepareMarkdownPrint(note,reader)
 try{await printDocument(snapshot.element,note.title)}finally{snapshot.dispose()}
}
