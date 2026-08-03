import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TauriClient } from './client'
import { createTauriPorts } from './ports'
import type { NoteId } from '../../domain/model'

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

  it('maps stable link ports to the narrow Tauri command boundary', async () => {
    const target = '019c0000-0000-7000-8000-000000000002' as NoteId
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ updated: 0, failedSourceIds: [] })
    const { links } = createTauriPorts()

    await links.resolve(target)
    await links.backlinks(target)
    await links.renameTargetLabels(target, 'New title')

    expect(invokeMock.mock.calls).toEqual([
      ['resolve_link', { noteId: target }],
      ['backlinks', { noteId: target }],
      ['rename_target_labels', { noteId: target, title: 'New title' }],
    ])
  })

  it('maps trash operations to the narrow Tauri command boundary', async () => {
    const first = '019c0000-0000-7000-8000-000000000031' as NoteId
    const second = '019c0000-0000-7000-8000-000000000032' as NoteId
    invokeMock.mockResolvedValue(undefined)
    const { trash } = createTauriPorts()

    await trash.trash([first, second])
    await trash.list()
    await trash.restore([second])
    await trash.undo('019c0000-0000-7000-8000-000000000099')

    expect(invokeMock.mock.calls).toEqual([
      ['trash_notes', { noteIds: [first, second] }],
      ['list_trash', undefined],
      ['restore_trash', { noteIds: [second] }],
      ['undo_trash', { operationId: '019c0000-0000-7000-8000-000000000099' }],
    ])
  })
})
