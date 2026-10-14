import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SaveAsDialog } from './SaveAsDialog'
import { note } from '../../test/fakes'
afterEach(cleanup)
it('keeps keyboard focus in the format dialog and cancels without saving',()=>{
 const onClose=vi.fn(),onSave=vi.fn()
 render(<SaveAsDialog note={{...note(''),excerpt:''}} onClose={onClose} onSave={onSave}/>)
 const last=screen.getByRole('button',{name:'另存为'}),first=screen.getByRole('button',{name:'关闭另存为'})
 last.focus();fireEvent.keyDown(last,{key:'Tab'})
 expect(first).toHaveFocus()
 fireEvent.keyDown(first,{key:'Tab',shiftKey:true})
 expect(last).toHaveFocus()
 fireEvent.keyDown(last,{key:'Escape'})
 expect(onClose).toHaveBeenCalledOnce()
 expect(onSave).not.toHaveBeenCalled()
})

it('passes the edited filename and chosen directory without renaming the note',async()=>{
 const onSave=vi.fn(),chooseExportDirectory=vi.fn(async()=> 'D:\\Exports')
 render(<SaveAsDialog note={{...note(''),title:'Original',excerpt:''}} files={{chooseExportDirectory}} onClose={vi.fn()} onSave={onSave}/>)
 fireEvent.change(screen.getByRole('textbox',{name:'文件名'}),{target:{value:'My copy'}})
 fireEvent.click(screen.getByRole('button',{name:'选择保存目录'}))
 await waitFor(()=>expect(screen.getByRole('textbox',{name:'保存位置'})).toHaveValue('D:\\Exports'))
 fireEvent.click(screen.getByRole('button',{name:'另存为'}))
 expect(onSave).toHaveBeenCalledWith('markdown',{filename:'My copy',directory:'D:\\Exports'})
})
it('defaults rich documents to DOCX and sanitizes only the copy filename',()=>{
 render(<SaveAsDialog note={{...note(''),title:'10/13 面试',excerpt:'',content:{type:'document',document:{schemaVersion:1,root:{type:'doc'}}}}} onClose={vi.fn()} onSave={vi.fn()}/>)
 expect(screen.getByRole('combobox',{name:'另存格式'})).toHaveValue('word')
 expect(screen.getByRole('textbox',{name:'文件名'})).toHaveValue('10_13 面试.docx')
})

it('labels Markdown without an attachment suffix',()=>{
 render(<SaveAsDialog note={{...note(''),excerpt:''}} onClose={vi.fn()} onSave={vi.fn()}/>)
 expect(screen.getByRole('option',{name:/^Markdown$/})).toHaveValue('markdown')
})
