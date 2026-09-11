import {cleanup,render,screen,fireEvent} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {PlainTextEditor} from './PlainTextEditor'
afterEach(cleanup)
it('shows Markdown punctuation as literal plain text',()=>{
 render(<PlainTextEditor value={'# 标题\n==原文=='} onChange={vi.fn()}/>)
 expect(screen.getByRole('textbox',{name:'纯文本正文'}).textContent).toContain('# 标题')
 expect(document.querySelector('h1')).toBeNull()
})
it('preserves a read-only text editor during save barriers',()=>{
 const change=vi.fn()
 render(<PlainTextEditor value="原文" onChange={change} editable={false}/>)
 const el=screen.getByRole('textbox',{name:'纯文本正文'})
 expect(el.getAttribute('contenteditable')).toBe('false')
 fireEvent.input(el)
 expect(change).not.toHaveBeenCalled()
})
