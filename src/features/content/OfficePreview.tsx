import { useEffect, useState } from 'react'
import type { FilePort } from '../../domain/ports'
import type { NoteId } from '../../domain/model'
import { parseOfficePreview, type OfficeSection } from './officeXml'
import { ErrorNotification } from '../../shared/notifications'
export function OfficePreview({noteId,extension,files,empty,revision=0}:{revision?:number;noteId:NoteId;extension:string;files?:FilePort;empty:boolean}){
 const [sections,setSections]=useState<OfficeSection[]>([]),[active,setActive]=useState(0),[error,setError]=useState<string|null>(null)
 useEffect(()=>{let current=true;setSections([]);setActive(0);setError(null);if(!empty&&files?.readOfficeParts)void files.readOfficeParts(noteId).then(parts=>{if(current)setSections(parseOfficePreview(extension,parts).filter(section=>section.rows.some(row=>row.some(cell=>cell.trim()!==''))||Boolean(section.images?.length)||section.truncated))}).catch(()=>{if(current)setError('无法预览此文件，可用系统应用打开。')});return()=>{current=false}},[noteId,extension,empty,files,revision])
 const visible=extension==='xlsx'?sections.slice(active,active+1):sections
 return <div className="office-preview"><ErrorNotification error={error}/>{extension==='xlsx'&&sections.length>1&&<div className="office-preview__tabs" role="tablist" aria-label="工作表">{sections.map((section,index)=><button key={index} type="button" role="tab" aria-selected={index===active} onClick={()=>setActive(index)}>{section.title}</button>)}</div>}{visible.map((section,index)=><section key={index} className={`office-preview__section office-preview__section--${section.kind}`}>{section.title&&<h3>{section.title}</h3>}{section.kind==='table'?<div className="office-preview__table"><table><tbody>{section.rows.map((row,r)=><tr key={r}>{row.map((cell,c)=><td key={c}>{cell}</td>)}</tr>)}</tbody></table></div>:section.rows.map((row,r)=><p key={r}>{row[0]||'\u00a0'}</p>)}{section.images?.map((src,imageIndex)=><img className="office-preview__picture" key={imageIndex} src={src} alt={`${section.title}图片 ${imageIndex+1}`} loading="lazy" decoding="async"/>)}{section.truncated&&<small>预览显示前 500 行、100 列，完整内容可用系统应用打开。</small>}</section>)}</div>
}
