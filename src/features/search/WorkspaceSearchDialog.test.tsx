import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeSearchPort } from '../../test/fakes'
import type { FolderId, NoteId } from '../../domain/model'
import { WorkspaceSearchDialog } from './WorkspaceSearchDialog'
afterEach(cleanup)
it('searches folders and notes and keeps the dialog open when navigation is blocked', async () => {
 const search=fakeSearchPort({search:vi.fn().mockResolvedValue([{noteId:'019c0000-0000-7000-8000-000000000061' as NoteId,title:'项目笔记',folderBreadcrumb:[],tags:[],excerpt:'测试',score:1}])})
 const onSelect=vi.fn().mockResolvedValue(false), onClose=vi.fn()
 render(<WorkspaceSearchDialog search={search} folders={[{id:'folder' as FolderId,name:'项目资料',parentId:null,sortOrder:0}]} onSelect={onSelect} onClose={onClose}/>)
 fireEvent.change(screen.getByRole('searchbox'), {target:{value:'项目'}})
 const folder=await screen.findByRole('option',{name:/项目资料/})
 await screen.findByRole('option',{name:/项目笔记/})
 expect(screen.queryByText('测试')).not.toBeInTheDocument() // Unrelated excerpts are never shown.
 fireEvent.click(folder)
 await waitFor(()=>expect(onSelect).toHaveBeenCalledWith({kind:'folder',id:'folder'}))
 expect(onClose).not.toHaveBeenCalled()
 expect(await screen.findByRole('alert')).toHaveTextContent('保存')
 fireEvent.keyDown(screen.getByRole('searchbox'),{key:'Escape'})
 expect(onClose).toHaveBeenCalledOnce()
})
