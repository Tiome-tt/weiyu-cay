import { describe, expect, it, vi } from 'vitest'
import { decodeBinaryPayload, TauriFilePort } from './filePort'
import { TauriClient } from './client'
import { note } from '../../test/fakes'
import { open, save } from '@tauri-apps/plugin-dialog'
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null), save: vi.fn(async () => null) }))
describe('managed file boundary', () => {
  it('reads only preview XML through the dedicated main-window command',async()=>{
    const client=new TauriClient()
    const parts=[{name:'word/document.xml',text:'<document/>'}]
    const invoke=vi.spyOn(client,'invoke').mockResolvedValue(parts)
    expect(await new TauriFilePort(client).readOfficeParts(note('').id)).toEqual(parts)
    expect(invoke).toHaveBeenCalledWith('read_office_preview_parts',{noteId:note('').id})
  })
  it('does not report success when a published Markdown bundle failed to export its note', async () => {
    vi.mocked(open).mockResolvedValueOnce('D:\\Exports')
    const client = new TauriClient()
    vi.spyOn(client, 'invoke').mockResolvedValue({ completed: true, notesExported: 0, failed: [{ message: 'Failed' }] })
    await expect(new TauriFilePort(client).exportMarkdownNote(note('').id, '正文')).rejects.toThrow('Markdown export incomplete')
  })
  it('does not import or export when the user cancels selection', async () => {
    const client = new TauriClient()
    const invoke = vi.spyOn(client,'invoke')
    const port = new TauriFilePort(client)
    expect(await port.chooseFiles()).toEqual([])
    expect(await port.saveFileAs(note('').id)).toBe(false)
    expect(await port.saveTextExport(note('').id, '正文', '标题', 'text')).toBe(false)
    expect(await port.exportMarkdownNote(note('').id, '正文')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })
  it('converts command bytes to typed arrays for local viewers', async () => {
    const client = new TauriClient()
    const invoke = vi.spyOn(client,'invoke').mockResolvedValue({mediaType:'application/pdf',bytes:[37,80,68,70]})
    expect(await new TauriFilePort(client).readFile(note('').id)).toEqual({mediaType:'application/pdf',bytes:Uint8Array.from([37,80,68,70])})
    expect(invoke).toHaveBeenCalledWith('read_managed_file',{noteId:note('').id})
  })
  it('normalizes cross-realm typed arrays and byte wrapper responses', () => {
    const bytes = Uint8Array.from([37,80,68,70])
    expect(decodeBinaryPayload(new DataView(bytes.buffer))).toEqual(bytes)
    expect(decodeBinaryPayload({data:[37,80,68,70]})).toEqual(bytes)
    expect(() => decodeBinaryPayload({value:'invalid'})).toThrow(TypeError)
  })
  it('keeps raw binary responses without JSON conversion', async () => {
    const client = new TauriClient()
    const bytes = Uint8Array.from([37,80,68,70])
    const invoke = vi.spyOn(client,'invoke').mockResolvedValue(bytes)
    expect(await new TauriFilePort(client).readFileBytes(note('').id)).toBe(bytes)
    expect(invoke).toHaveBeenCalledWith('read_managed_file_bytes',{noteId:note('').id})
  })
})

it('prefills the native save dialog with an edited name and selected location',async()=>{
 vi.mocked(save).mockResolvedValueOnce(null)
 const port=new TauriFilePort(new TauriClient())
 expect(await port.savePdfExport(note('').id,new Uint8Array([1]),'Original',{filename:'Custom',directory:'D:\\Exports'})).toBe(false)
 expect(save).toHaveBeenCalledWith(expect.objectContaining({defaultPath:'D:\\Exports/Custom.pdf'}))
})

 it('requires the writeback command before opening an external editing copy',async()=>{
  const client=new TauriClient(),invoke=vi.spyOn(client,'invoke').mockRejectedValue(new Error('unsupported command'))
  await expect(new TauriFilePort(client).openFile(note('').id)).rejects.toThrow('unsupported command')
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('sync_external_file',{noteId:note('').id,force:true})
 })
