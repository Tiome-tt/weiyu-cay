import { beforeEach, expect, it, vi } from 'vitest'
import { createTauriPorts } from './ports'
const dialog = vi.hoisted(()=>({open:vi.fn(),save:vi.fn()}))
vi.mock('@tauri-apps/plugin-dialog',()=>dialog)
beforeEach(()=>vi.clearAllMocks())
it('uses the native single-directory picker without invoking storage migration',async()=>{
 dialog.open.mockResolvedValue('D:\\Notes')
 expect(await createTauriPorts().settings.chooseStorageDirectory?.()).toBe('D:\\Notes')
 expect(dialog.open).toHaveBeenCalledWith({directory:true,multiple:false,title:'选择数据目录'})
})
it('returns cancellation without accepting multiple directory results',async()=>{
 dialog.open.mockResolvedValueOnce(null).mockResolvedValueOnce(['D:\\Notes'])
 const settings=createTauriPorts().settings
 expect(await settings.chooseStorageDirectory?.()).toBeNull()
 expect(await settings.chooseStorageDirectory?.()).toBeNull()
})
