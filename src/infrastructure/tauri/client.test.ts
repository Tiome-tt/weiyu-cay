import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TauriClient } from './client'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const invokeMock = vi.mocked(invoke)

describe('TauriClient', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('forwards a typed command and its arguments through the sole invoke boundary', async () => {
    invokeMock.mockResolvedValue({ title: '登录流程' })

    const result = await new TauriClient().invoke<{ title: string }>('load_note', {
      id: '019c0000-0000-7000-8000-000000000002',
    })

    expect(result).toEqual({ title: '登录流程' })
    expect(invokeMock).toHaveBeenCalledWith('load_note', {
      id: '019c0000-0000-7000-8000-000000000002',
    })
  })

  it.each([
    ['validation', 'The request is invalid.'],
    ['not_found', 'The requested item was not found.'],
    ['conflict', 'The request conflicts with the current state.'],
    ['io', 'The operation could not be completed on local storage.'],
    ['database', 'The local note index is unavailable.'],
    ['unsupported', 'This operation is not supported.'],
  ] as const)('normalizes a structured %s rejection', async (code, message) => {
    invokeMock.mockRejectedValue({ code, message: 'backend-safe-but-not-authoritative' })

    await expect(new TauriClient().invoke('save_note')).rejects.toEqual({ code, message })
  })

  it('maps unknown rejections to unsupported without exposing diagnostics', async () => {
    invokeMock.mockRejectedValue({
      code: 'internal',
      message: 'C:\\Users\\person\\secret-notes\\note.md',
      source: 'database connection string',
    })

    await expect(new TauriClient().invoke('unknown_command')).rejects.toEqual({
      code: 'unsupported',
      message: 'This operation is not supported.',
    })
  })
})
