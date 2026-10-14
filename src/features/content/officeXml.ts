export interface OfficeXmlPart { name: string; text: string }
export interface OfficeSection { title: string; rows: string[][]; kind: 'text' | 'table' | 'slide'; truncated?: boolean; images?:string[] }
function xml(source: string): Document {
 if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Office XML contains unsupported declarations')
 const result=new DOMParser().parseFromString(source,'application/xml')
 if(result.getElementsByTagName('parsererror').length)throw new Error('Invalid Office XML')
 return result
}
const descendants=(node:Document|Element,name:string)=>Array.from(node.getElementsByTagNameNS('*',name))
const bodyText=(node:Element):string=>{
 if(node.localName==='t')return node.textContent??''
 if(node.localName==='tab')return '\t'
 if(node.localName==='br'||node.localName==='cr')return '\n'
 return Array.from(node.children).map(bodyText).join('')
}
function orderedParts(parts:OfficeXmlPart[],documentName:string,relationshipsName:string,element:string,prefix:string):OfficeXmlPart[]{
 const source=parts.find(part=>part.name===documentName)?.text
 const relationships=parts.find(part=>part.name===relationshipsName)?.text
 if(!source||!relationships)return []
 const targets=new Map(descendants(xml(relationships),'Relationship').filter(node=>node.getAttribute('TargetMode')!=='External').map(node=>[node.getAttribute('Id'),node.getAttribute('Target')??'']))
 return descendants(xml(source),element).flatMap(node=>{
  const id=node.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id')
  const target=targets.get(id)?.replace(/^\/?ppt\//,'')
  const part=parts.find(part=>part.name===`${prefix}/${target}`)
  return part ? [part] : []
 })
}
export function parseOfficePreview(extension: string, parts: OfficeXmlPart[]): OfficeSection[] {
 const get=(name:string)=>parts.find(part=>part.name===name)?.text
 if(extension==='docx'){
  const source=get('word/document.xml');if(!source)return []
  const body=descendants(xml(source),'body')[0];if(!body)return []
  return Array.from(body.children).flatMap<OfficeSection>(node=>node.localName==='p' ? [{title:'',rows:[[bodyText(node)]],kind:'text' as const}] : node.localName==='tbl' ? [{title:'',rows:descendants(node,'tr').map(row=>Array.from(row.children).filter(cell=>cell.localName==='tc').map(cell=>descendants(cell,'p').map(bodyText).join('\n'))),kind:'table' as const}] : [])
 }
 if(extension==='pptx'){
  const ordered=orderedParts(parts,'ppt/presentation.xml','ppt/_rels/presentation.xml.rels','sldId','ppt')
  const slides=ordered.length ? ordered : parts.filter(part=>/^ppt\/slides\/slide\d+\.xml$/.test(part.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))
  return slides.map((part,index)=>{
   const slide=xml(part.text),relationship=get(part.name.replace('ppt/slides/','ppt/slides/_rels/')+'.rels')
   const targets=new Map(relationship?descendants(xml(relationship),'Relationship').filter(node=>node.getAttribute('TargetMode')!=='External').map(node=>[node.getAttribute('Id'),node.getAttribute('Target')??'']):[])
   const images=descendants(slide,'blip').flatMap(node=>{
    const target=targets.get(node.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','embed'))
    if(!target||!/^\.\.\/media\/[^/\\]+$/.test(target))return []
    const data=get(target.replace('../','ppt/'))
    return data&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)?[data]:[]
   })
   return {title:`第 ${index+1} 页`,kind:'slide' as const,rows:descendants(slide,'p').map(node=>[bodyText(node)]),images}
  })
 }
 if(extension!=='xlsx')return []
 const shared=get('xl/sharedStrings.xml'), strings=shared ? descendants(xml(shared),'si').map(bodyText) : []
 const workbook=get('xl/workbook.xml'), sheets=workbook ? descendants(xml(workbook),'sheet') : []
 const relationships=get('xl/_rels/workbook.xml.rels')
 const targets=new Map(relationships ? descendants(xml(relationships),'Relationship').filter(node=>node.getAttribute('TargetMode')!=='External').map(node=>[node.getAttribute('Id'),node.getAttribute('Target')??'']) : [])
 const ordered=sheets.flatMap(sheet=>{
  const id=sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id')
  const target=targets.get(id)?.replace(/^\/?xl\//,'')
  const part=parts.find(part=>part.name===`xl/${target}`)
  return part ? [{part,title:sheet.getAttribute('name')??''}] : []
 })
 const selected=ordered.length ? ordered : parts.filter(part=>/^xl\/worksheets\/sheet\d+\.xml$/.test(part.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true})).map((part,index)=>({part,title:sheets[index]?.getAttribute('name')??''}))
 return selected.map(({part,title},index)=>{
  const rows:string[][]=[];let truncated=false
  for(const row of descendants(xml(part.text),'row')){
   const number=row.hasAttribute('r') ? Number(row.getAttribute('r')) : rows.length+1
   if(!Number.isSafeInteger(number)||number<1)continue
   if(number>500){truncated=true;continue}
   rows[number-1]??=[]
   for(const cell of descendants(row,'c')){
    const letters=/^[A-Z]+/.exec(cell.getAttribute('r')??'')?.[0]??'A'
    let column=0;for(const letter of letters)column=column*26+letter.charCodeAt(0)-64
    if(column>100){truncated=true;continue}
    const value=descendants(cell,'v')[0]?.textContent??''
    rows[number-1][column-1]=cell.getAttribute('t')==='s' ? strings[Number(value)]??'' : cell.getAttribute('t')==='inlineStr' ? bodyText(cell) : cell.getAttribute('t')==='b' ? value==='1'?'TRUE':'FALSE' : value
   }
  }
  const columns=Math.max(0,...Array.from(rows,row=>row?.length??0))
  return {title:title||`工作表 ${index+1}`,kind:'table' as const,truncated,rows:Array.from({length:rows.length},(_,r)=>Array.from({length:columns},(_,c)=>rows[r]?.[c]??''))}
 })
}
