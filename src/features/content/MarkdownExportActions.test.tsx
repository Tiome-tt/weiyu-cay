import '@testing-library/jest-dom/vitest'
import {cleanup,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {EditorPane} from '../editor/EditorPane'
import {note,fakeNotePort} from '../../test/fakes'
afterEach(()=>{cleanup();vi.clearAllMocks()})
it('does not expose conversion actions for Markdown notes',async()=>{
 render(<EditorPane document={note('旧正文')} notes={fakeNotePort()}/>)
 expect(screen.queryByRole('button',{name:'笔记更多操作'})).not.toBeInTheDocument()
 expect(screen.queryByRole('menuitem',{name:'转换为文档副本'})).not.toBeInTheDocument()
})
