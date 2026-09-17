import {Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,HeadingLevel,WidthType,AlignmentType,ExternalHyperlink,ImageRun,type ParagraphChild} from 'docx'
import type {RichNode} from '../../domain/content'
import type {NoteDocument} from '../../domain/model'
import type {ImageReadPort} from '../../domain/ports'
import { richFontSizePoints } from '../document/font'
const colors:Record<string,string>={green:'DCEDE5',yellow:'FFF0AD',blue:'DCEAF5',pink:'F5DDE3',purple:'E9DDF5',gray:'E5E8E6'}
const headings=[HeadingLevel.HEADING_1,HeadingLevel.HEADING_2,HeadingLevel.HEADING_3,HeadingLevel.HEADING_4,HeadingLevel.HEADING_5,HeadingLevel.HEADING_6]
function attr(node:RichNode,key:string){const value=node.attrs?.[key];return typeof value==='string'?value:''}
function markAttr(node:RichNode,type:string,key:string){const value=node.marks?.find(mark=>mark.type===type)?.attrs?.[key];return typeof value==='string'?value:''}
function alignment(node:RichNode){const value=attr(node,'textAlign');return value==='center'?AlignmentType.CENTER:value==='right'?AlignmentType.RIGHT:AlignmentType.LEFT}
function fontName(value:string){return value==='body'?'KaiTi':value==='serif'?'SimSun':value==='sans'?'Microsoft YaHei UI':value==='mono'?'Consolas':undefined}
function fontSize(value:string){const points=richFontSizePoints(value);return points===undefined?undefined:points*2}
function inline(node:RichNode):ParagraphChild[] {
 if(node.type==='hardBreak')return [new TextRun({break:1})]
 if(node.type==='internalLink')return [new TextRun(attr(node,'label'))]
 if(node.type==='math')return [new TextRun({text:'$'+attr(node,'latex')+'$'})]
 if(node.type!=='text')return (node.content??[]).flatMap(inline)
 const marks=node.marks??[];const has=(type:string)=>marks.some(m=>m.type===type)
 const run=new TextRun({text:node.text??'',bold:has('bold'),italics:has('italic'),strike:has('strike'),underline:has('underline')?{}:undefined,highlight:has('highlight')?'yellow':undefined,font:has('code')?'Consolas':fontName(markAttr(node,'font','family')),size:fontSize(markAttr(node,'font','size'))})
 const href=marks.find(m=>m.type==='link')?.attrs?.href
 return typeof href==='string'&&/^(https?:|mailto:)/i.test(href)?[new ExternalHyperlink({link:href,children:[run]})]:[run]
}
export async function buildDocumentDocx(note:NoteDocument,reader?:ImageReadPort):Promise<Uint8Array> {
 if(note.content?.type!=='document')throw new Error('Only documents export as DOCX')
 const blocks=async(node:RichNode,depth=0,list?:'bullet'|'ordered'):Promise<Array<Paragraph|Table>>=>{
  if(node.type==='table')return [new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:await Promise.all((node.content??[]).map(async row=>new TableRow({children:await Promise.all((row.content??[]).map(async cell=>{
   const content=await blocks({type:'doc',content:cell.content})
   const widths=cell.attrs?.colwidth
   return new TableCell({children:content.length?content:[new Paragraph('')],columnSpan:Number(cell.attrs?.colspan)||1,rowSpan:Number(cell.attrs?.rowspan)||1,width:Array.isArray(widths)&&widths.every(n=>typeof n==='number')?{size:widths.reduce((a:number,b:number)=>a+b,0)*15,type:WidthType.DXA}:undefined,shading:colors[attr(cell,'backgroundColor')]?{fill:colors[attr(cell,'backgroundColor')]}:undefined})
  }))})))})]
  if(node.type==='mathBlock')return [new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'$$'+attr(node,'latex')+'$$',font:'Cambria Math'})]})]
  if(node.type==='image'){
   if(!reader)throw new Error('Image reader is required to export embedded images')
   const image=await reader.readImage({noteId:note.id,relativePath:attr(node,'src')})
   let data=Uint8Array.from(image.bytes),type:'png'|'jpg'='png'
   if(image.mediaType==='image/jpeg')type='jpg'
   else if(image.mediaType!=='image/png'){
    const bitmap=await createImageBitmap(new Blob([data],{type:image.mediaType}))
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height
    canvas.getContext('2d')!.drawImage(bitmap,0,0);bitmap.close()
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Image conversion failed')),'image/png'))
    data=new Uint8Array(await blob.arrayBuffer())
   }
   return [new Paragraph({children:[new ImageRun({type,data,transformation:{width:480,height:320},altText:{title:attr(node,'alt'),description:attr(node,'alt'),name:attr(node,'alt')}})]})]
  }
  if(node.type==='paragraph'||node.type==='heading'||node.type==='codeBlock')return [new Paragraph({
   children:node.type==='codeBlock'?[(new TextRun({text:(node.content??[]).map(n=>n.text??'').join(''),font:'Consolas'}))]:inline(node),
   heading:node.type==='heading'?headings[Math.max(0,Math.min(5,(Number(node.attrs?.level)||1)-1))]:undefined,
   alignment:alignment(node),bullet:list==='bullet'?{level:Math.min(depth,8)}:undefined,numbering:list==='ordered'?{reference:'cay-list',level:Math.min(depth,8)}:undefined,
   spacing:{after:120},
  })]
  if(node.type==='rawMarkdown')return [new Paragraph({children:[new TextRun({text:attr(node,'source'),font:'Consolas'})]})]
  if(node.type==='attachment')return [new Paragraph('附件：'+(attr(node,'label')||attr(node,'fileName')))]
  if(node.type==='horizontalRule')return [new Paragraph({border:{bottom:{style:'single',size:4,color:'B0B8B2'}}})]
  const children:Array<Paragraph|Table>=[]
  for(const child of node.content??[]){
   if(node.type==='taskItem'&&child.type==='paragraph')children.push(new Paragraph({children:[new TextRun(node.attrs?.checked?'☑ ':'☐ '),...inline(child)]}))
   else children.push(...await blocks(child,node.type==='bulletList'||node.type==='orderedList'?depth+1:depth,node.type==='bulletList'?'bullet':node.type==='orderedList'?'ordered':list))
  }
  return children
 }
 const content=await blocks(note.content.document.root)
 const documentFile=new Document({title:note.title,creator:'Cay (微屿)',styles:{default:{document:{run:{font:'Microsoft YaHei',size:22}}}},numbering:{config:[{reference:'cay-list',levels:Array.from({length:9},(_,level)=>({level,format:'decimal',text:`%${level+1}.`,alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720*(level+1),hanging:260}}}}))}]},sections:[{children:[new Paragraph({text:note.title,heading:HeadingLevel.TITLE}),...content]}]})
 return Packer.toArrayBuffer(documentFile).then(buffer=>new Uint8Array(buffer))
}
