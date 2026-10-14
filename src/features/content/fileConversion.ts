import type { NoteDocument } from '../../domain/model'
import type { FilePort } from '../../domain/ports'
import type { NoteExportKind } from '../../domain/noteExport'
import { parseOfficePreview, type OfficeSection } from './officeXml'

export function officeProjection(sections:OfficeSection[]):{element:HTMLElement;text:string} {
  if(sections.some(section=>section.truncated))throw new Error('文件超出转换范围，请使用系统应用转换完整文件。')
  const element=document.createElement('article')
  const text:string[]=[]
  for(const section of sections){
    if(section.title){const heading=document.createElement('h2');heading.textContent=section.title;element.append(heading);text.push(section.title)}
    if(section.kind==='table'){
      const table=document.createElement('table')
      for(const row of section.rows){const tr=document.createElement('tr');for(const cell of row){const td=document.createElement('td');td.textContent=cell;tr.append(td)}table.append(tr)}
      element.append(table)
      text.push(section.rows.map(row=>row.map(cell=>/[\t\n"]/.test(cell)?`"${cell.replace(/"/g,'""')}"`:cell).join('\t')).join('\n'))
    }else for(const row of section.rows){const p=document.createElement('p');p.textContent=row[0];element.append(p);text.push(row[0])}
  }
  return {element,text:text.join('\n\n')}
}

export async function convertManagedFile(note:NoteDocument,kind:NoteExportKind,files:FilePort):Promise<boolean>{
  if(note.content?.type!=='file')throw new Error('文件转换不可用。')
  if(kind==='original')return files.saveFileAs(note.id)
  const file=note.content.file
  if(['image/png','image/jpeg','image/webp'].includes(file.mediaType)){
    if(kind!=='pdf'||!files.savePdfExport)throw new Error('此转换格式不可用。')
    const bytes=files.readFileBytes ? await files.readFileBytes(note.id) : (await files.readFile(note.id)).bytes
    const {jsPDF}=await import('jspdf')
    const pdf=new jsPDF({unit:'pt',format:'a4'})
    const properties=pdf.getImageProperties(bytes)
    const width=pdf.internal.pageSize.getWidth()-72,height=pdf.internal.pageSize.getHeight()-72
    const scale=Math.min(width/properties.width,height/properties.height)
    pdf.addImage(bytes,properties.fileType,(pdf.internal.pageSize.getWidth()-properties.width*scale)/2,36,properties.width*scale,properties.height*scale)
    return files.savePdfExport(note.id,new Uint8Array(pdf.output('arraybuffer')),note.title)
  }
  const extension=file.originalName.split('.').pop()?.toLowerCase()??''
  if(!['docx','xlsx','pptx'].includes(extension)||!files.readOfficeParts)throw new Error('此文件暂不支持转换。')
  const sections=parseOfficePreview(extension,await files.readOfficeParts(note.id))
  if(file.size>0&&sections.length===0)throw new Error('无法读取完整的转换内容。')
  const projection=officeProjection(sections)
  if(kind==='pdf'){
    const {exportTypedDocumentToPdf}=await import('./pdfExport')
    return exportTypedDocumentToPdf(note.id,note.title,projection.element,files)
  }
  if(!files.saveTextExport)throw new Error('此转换格式不可用。')
  if(kind==='text')return files.saveTextExport(note.id,projection.text,note.title,'text')
  if(kind==='html'){
    const title=document.createElement('title');title.textContent=note.title
    const html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">${title.outerHTML}<style>body{font-family:system-ui;max-width:1000px;margin:32px auto;padding:0 24px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:8px;white-space:pre-wrap}p{white-space:pre-wrap}</style></head><body>${projection.element.outerHTML}</body></html>`
    return files.saveTextExport(note.id,html,note.title,'html')
  }
  throw new Error('此转换格式不可用。')
}
