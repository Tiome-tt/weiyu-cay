import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TauriClient } from './client'
import { createTauriPorts } from './ports'
import type { NoteId } from '../../domain/model'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: vi.fn() }))

const invokeMock = vi.mocked(invoke)
const currentWindowMock = vi.mocked(getCurrentWebviewWindow)
const nativeWindow = {
  close: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => undefined),
  minimize: vi.fn().mockResolvedValue(undefined),
  startDragging: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
}

describe('TauriClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  beforeEach(() => {
    invokeMock.mockReset()
    currentWindowMock.mockReset()
    currentWindowMock.mockReturnValue(nativeWindow as never)
    for (const method of [nativeWindow.close, nativeWindow.listen, nativeWindow.minimize, nativeWindow.startDragging, nativeWindow.toggleMaximize]) {
      method.mockClear()
    }
  })

  it('routes main-window chrome through the current Tauri webview window', async () => {
    const { windowChrome } = createTauriPorts()

    await windowChrome.startDragging()
    await windowChrome.minimize()
    await windowChrome.toggleMaximize()
    await windowChrome.requestClose()

    expect(nativeWindow.startDragging).toHaveBeenCalledOnce()
    expect(nativeWindow.minimize).toHaveBeenCalledOnce()
    expect(nativeWindow.toggleMaximize).toHaveBeenCalledOnce()
    expect(nativeWindow.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15', 'macos'],
  ] as const)('normalizes the Tauri WebView user agent to %s window chrome', (userAgent, platform) => {
    vi.stubGlobal('navigator', { userAgent })

    expect(createTauriPorts().windowChrome.platform).toBe(platform)
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ updated: 0, failedSourceIds: [], failure: null })
    const { links } = createTauriPorts()

    await links.listTargets()
    await links.resolve(target)
    await links.backlinks(target)
    await links.renameTargetLabels(target, 'New title')

    expect(invokeMock.mock.calls).toEqual([
      ['list_link_targets', undefined],
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
    await trash.purgeExpired()

    expect(invokeMock.mock.calls).toEqual([
      ['trash_notes', { noteIds: [first, second] }],
      ['list_trash', undefined],
      ['restore_trash', { noteIds: [second] }],
      ['undo_trash', { operationId: '019c0000-0000-7000-8000-000000000099' }],
      ['purge_expired_trash', undefined],
    ])
  })

  it('sends create, rename, and move through the production typed note contract', async () => {
    const folderId = '019c0000-0000-7000-8000-000000000001' as import('../../domain/model').FolderId
    const noteId = '019c0000-0000-7000-8000-000000000002' as import('../../domain/model').NoteId
    invokeMock.mockResolvedValue({ id: '019c0000-0000-7000-8000-000000000002' })
    const { notes } = createTauriPorts()

    await notes.createNote({ folderId, title: '发布检查' })
    await notes.renameNote(noteId, '上线检查')
    await notes.moveNote(noteId, null)

    expect(invokeMock.mock.calls).toEqual([
      ['create_note', { input: { folderId, title: '发布检查' } }],
      ['rename_note', { noteId, title: '上线检查' }],
      ['move_note', { noteId, folderId: null }],
    ])
  })

  it('loads sticky appearance through its least-privilege command', async () => {
    invokeMock.mockResolvedValue({
      theme: 'forest', stickyColorMode: 'follow-theme', bodyFont: 'system-ui', codeFont: 'monospace',
      fontSize: 16, lineHeight: 1.6, autosaveDelayMs: 500,
    })
    const { stickySettings } = createTauriPorts()

    await stickySettings.load()

    expect(invokeMock).toHaveBeenCalledWith('load_sticky_settings', undefined)
  })

  it('maps portable export to one typed Tauri command', async () => {
    const report = {
      completed: true,
      outputRoot: 'D:\\Portable Notes\\微屿导出',
      incompleteRoot: null,
      globalFailure: null,
      notesExported: 1,
      assetsExported: 0,
      renamedPaths: [],
      failed: [],
    }
    invokeMock.mockResolvedValue(report)
    const { exporter } = createTauriPorts()

    const received = await exporter.exportLibrary('D:\\Portable Notes')

    expect(invokeMock).toHaveBeenCalledWith('export_library', { destination: 'D:\\Portable Notes' })
    expect(received).toEqual(report)
  })

  it('maps the explicit updater lifecycle to the main-only Tauri commands', async () => {
    invokeMock
      .mockResolvedValueOnce({ version: '0.1.1', notes: 'Security fixes' })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
    const { updater } = createTauriPorts()

    await expect(updater.check()).resolves.toEqual({ version: '0.1.1', notes: 'Security fixes' })
    await updater.install()
    await updater.restart()

    expect(invokeMock.mock.calls).toEqual([
      ['check_for_update', undefined],
      ['install_pending_update', undefined],
      ['restart_after_update', undefined],
    ])
  })

  it('maps close listener readiness and generation acknowledgements to main-only commands', async () => {
    invokeMock.mockResolvedValueOnce(17).mockResolvedValue(undefined)
    const { lifecycle } = createTauriPorts()

    const token = await lifecycle.beginCloseListenerRegistration()
    await lifecycle.setListenerReady(true, token)
    await lifecycle.completeClose(9, false)

    expect(invokeMock.mock.calls).toEqual([
      ['begin_main_window_close_listener_registration', undefined],
      ['set_main_window_close_listener_ready', { ready: true, registrationToken: 17 }],
      ['complete_main_window_close', { generation: 9, saved: false }],
    ])
  })

  it('maps preview reads and explicit external opens to privileged production commands', async () => {
    const noteId = '019c0000-0000-7000-8000-000000000002' as NoteId
    const relativePath = `assets/screenshot-${noteId}.png`
    invokeMock.mockResolvedValueOnce({ mediaType: 'image/png', bytes: [137, 80, 78, 71] })
      .mockResolvedValueOnce(undefined)
    const { assets, system } = createTauriPorts()

    await expect(assets.readImage({ noteId, relativePath })).resolves.toEqual({
      mediaType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71]),
    })
    await system.openExternal('https://example.com/path')

    expect(invokeMock.mock.calls).toEqual([
      ['read_image_asset', { input: { noteId, relativePath } }],
      ['open_external_link', { url: 'https://example.com/path' }],
    ])
  })
})
