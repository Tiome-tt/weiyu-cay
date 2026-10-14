import { useState } from 'react'
import type { NoteSummary } from '../../domain/model'
import type { ExportSelection, FilePort } from '../../domain/ports'
import { noteExportOptions, type NoteExportKind } from '../../domain/noteExport'
import { dialogKeyboard } from '../../shared/dialogKeyboard'
import { Icon } from '../../shared/Icon'
import { defaultExportName } from '../../domain/exportSelection'
const labels:Record<NoteExportKind,string>={markdown:'Markdown',text:'TXT',html:'HTML',word:'DOCX',pdf:'PDF',original:'原格式'}
export function SaveAsDialog({note,files,onSave,onClose}:{note:NoteSummary;files?:Pick<FilePort,'chooseExportDirectory'>;onSave(kind:NoteExportKind,selection:ExportSelection):void;onClose():void}){
 const options=noteExportOptions(note)
 const extension=(kind:NoteExportKind)=>kind==='original' ? note.content?.type==='file' ? note.content.file.originalName.split('.').slice(1).pop()??'' : '' : ({markdown:'md',text:'txt',html:'html',word:'docx',pdf:'pdf'} as const)[kind]
 const initial:NoteExportKind=note.content?.type==='document'?'word':note.content?.type==='text'?'text':options[0].kind
 const [kind,setKind]=useState<NoteExportKind>(initial)
 const base=defaultExportName(note.title)
 const [name,setName]=useState(base+(extension(initial)&&!base.toLowerCase().endsWith('.'+extension(initial).toLowerCase()) ? '.'+extension(initial):''))
 const [directory,setDirectory]=useState(''),[choosing,setChoosing]=useState(false),[error,setError]=useState('')
 const valid=name.trim().length>0&&name.length<=200&&!/[<>:"/\\|?*\u0000-\u001f]/.test(name)&&!/[. ]$/.test(name)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)
 const choose=async()=>{setChoosing(true);setError('');try{const path=await files?.chooseExportDirectory?.();if(path)setDirectory(path)}catch{setError('无法选择目录，请重试。')}finally{setChoosing(false)}}
 return <div className="settings-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><form className="save-as-dialog save-as-dialog--compact" role="dialog" aria-modal="true" aria-labelledby="save-as-title" onKeyDown={event=>dialogKeyboard(event,onClose)} onSubmit={event=>{event.preventDefault();if(valid&&!choosing)onSave(kind,{filename:name.trim(),...(directory?{directory}:{})})}}>
 <header><h2 id="save-as-title">另存为</h2><button type="button" aria-label="关闭另存为" onClick={onClose}><Icon name="close" size={17}/></button></header>
 <label className="library-operation-dialog__field">文件名<input autoFocus aria-label="文件名" value={name} aria-invalid={!valid} onChange={event=>setName(event.target.value)}/></label>
 <label className="library-operation-dialog__field">格式<select aria-label="另存格式" value={kind} onChange={event=>{const next=event.target.value as NoteExportKind,old=extension(kind),suffix=extension(next);setName(current=>(old&&current.toLowerCase().endsWith('.'+old.toLowerCase())?current.slice(0,-old.length-1):current)+(suffix?'.'+suffix:''));setKind(next)}}>{options.map(option=><option key={option.kind} value={option.kind}>{option.kind==='original' ? extension(option.kind).toUpperCase()||labels.original : labels[option.kind]}</option>)}</select></label>
 <div className="library-operation-dialog__field"><label htmlFor="export-directory">保存位置</label><div className="library-operation-dialog__directory"><input id="export-directory" aria-label="保存位置" readOnly value={directory} placeholder="使用系统保存窗口选择" onClick={()=>void choose()}/><button type="button" aria-label="选择保存目录" disabled={choosing||!files?.chooseExportDirectory} onClick={()=>void choose()}><Icon name="folder" size={17}/></button></div></div>
 {error&&<p role="alert" className="library-operation-dialog__description">{error}</p>}
 {!valid&&<p className="library-operation-dialog__description">请输入有效文件名，避免路径字符和系统保留名称。</p>}
 {note.content?.type==='file'&&kind!=='original'&&<p className="library-operation-dialog__description">{note.content.file.mediaType.startsWith('image/')?'保存完整图片为 PDF。':'转换文字和表格；复杂版式、图表与图片请保留原格式。'}</p>}
 <footer><button type="button" onClick={onClose}>取消</button><button type="submit" disabled={!valid||choosing}>另存为</button></footer></form></div>
}
