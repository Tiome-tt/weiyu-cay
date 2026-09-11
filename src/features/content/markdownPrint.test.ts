import {expect,it,vi} from 'vitest'
import {prepareMarkdownPrint} from './markdownPrint'
import {note} from '../../test/fakes'
it('renders a fresh Markdown snapshot and resolves local images without leaking link UUIDs', async()=>{
 const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local')
 const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{})
 const source=note('# 最新正文\n\n![截图](assets/screenshot-019c0000-0000-7000-8000-000000000003.png)\n\n[[目标|019c0000-0000-7000-8000-000000000002]]')
 const reader={readImage:vi.fn(async()=>({mediaType:'image/png',bytes:new Uint8Array([1])}))}
 const snapshot=await prepareMarkdownPrint(source,reader)
 expect(snapshot.element.querySelector('h1')?.textContent).toBe('最新正文')
 expect(snapshot.element.textContent).not.toContain('019c0000')
 expect(snapshot.element.querySelector('img')?.getAttribute('src')).toBe('blob:local')
 snapshot.dispose()
 expect(revoke).toHaveBeenCalledWith('blob:local')
 create.mockRestore();revoke.mockRestore()
})
