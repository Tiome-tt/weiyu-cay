import { describe, expect, it, vi } from 'vitest'
import { decodeBinaryPayload, TauriFilePort } from './filePort'
import { TauriClient } from './client'
import { note } from '../../test/fakes'
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null), save: vi.fn(async () => null) }))
describe('managed file boundary', () => {
  it('does not import or export when the user cancels selection', async () => {
    const client = new TauriClient()
    const invoke = vi.spyOn(client,'invoke')
    const port = new TauriFilePort(client)
    expect(await port.chooseFiles()).toEqual([])
    expect(await port.saveFileAs(note('').id)).toBe(false)
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
