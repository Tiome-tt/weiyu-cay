import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import userEvent from '@testing-library/user-event'
import { defaultStickySettings, fakeAssetPort, fakeFolderPort, fakeLinkPort, fakeNotePort, fakeSearchPort, fakeSettingsPort, fakeStickySettingsPort, fakeSystemPort } from '../test/fakes'
import type { AppSettings, ExportReport, SettingsPort, StickySettings, StickySettingsPort } from '../domain/ports'
import { DEFAULT_APP_SETTINGS } from '../features/settings/theme'
import { EditorView } from '@codemirror/view'
import type { FolderId, NoteDocument, NoteId } from '../domain/model'

describe('App', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/') })
  it('renders the local library shell without authentication', () => {
    render(
      <App
        services={{
          notes: fakeNotePort(),
          folders: fakeFolderPort(),
          system: fakeSystemPort(),
          assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }),
          search: fakeSearchPort(),
          links: fakeLinkPort(),
        }}
      />,
    )
    expect(screen.getByRole('application', { name: 'Simple Notes' })).toBeVisible()
    expect(screen.getByRole('navigation', { name: '文件夹' })).toBeVisible()
    expect(screen.queryByText(/sign in|登录/i)).not.toBeInTheDocument()
  })

  it('acknowledges a native close only after the dirty editor flushes behind a barrier', async () => {
    const pendingSave = deferred<NoteDocument>()
    const activeId = '019c0000-0000-7000-8000-000000000052' as NoteId
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([{ ...fakeNotePortDocument(activeId, 'Close-safe note'), excerpt: '' }]),
      loadNote: vi.fn().mockResolvedValue(fakeNotePortDocument(activeId, 'Close-safe note', 'old body')),
      saveNote: vi.fn(() => pendingSave.promise),
    })
    let requestClose!: () => void
    const completeClose = vi.fn().mockResolvedValue(undefined)
    const lifecycle = {
      onCloseRequested: vi.fn(async (handler: () => void) => {
        requestClose = handler
        return () => undefined
      }),
      completeClose,
    }
    const services = {
      notes, folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      lifecycle,
    }
    const user = userEvent.setup()
    render(<App services={services} />)
    await user.click(await screen.findByRole('button', { name: /^Close-safe note/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'dirty close draft' } }))
    await waitFor(() => expect(lifecycle.onCloseRequested).toHaveBeenCalledOnce())

    act(() => requestClose())

    await waitFor(() => expect(notes.saveNote).toHaveBeenCalledOnce())
    expect(completeClose).not.toHaveBeenCalled()
    expect(editor.state.facet(EditorView.editable)).toBe(false)
    await act(async () => pendingSave.resolve({ ...fakeNotePortDocument(activeId, 'Close-safe note', 'dirty close draft'), revision: 2 }))
    await waitFor(() => expect(completeClose).toHaveBeenCalledWith(true))
  })

  it('checks, confirms, installs, and reports updater failures only after explicit main-window actions', async () => {
    const user = userEvent.setup()
    const check = vi.fn().mockResolvedValue({ version: '0.1.1', notes: 'Security fixes' })
    const install = vi.fn().mockRejectedValue(new Error('signature verification failed'))
    const restart = vi.fn()
    const services = {
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      updater: { check, install, restart },
    }
    render(<App services={services} />)

    expect(check).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(check).toHaveBeenCalledOnce()
    expect(await screen.findByText('Version 0.1.1 is ready to install.')).toBeVisible()
    expect(install).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Download and install version 0.1.1' }))
    expect(install).toHaveBeenCalledOnce()
    expect(await screen.findByRole('alert')).toHaveTextContent('Update installation failed. Your notes are unchanged.')
  })

  it('keeps an installed update recoverable when explicit restart fails', async () => {
    const user = userEvent.setup()
    const restart = vi.fn().mockRejectedValue(new Error('restart denied'))
    const services = {
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      updater: { check: vi.fn().mockResolvedValue({ version: '0.1.1', notes: null }), install: vi.fn().mockResolvedValue(undefined), restart },
    }
    render(<App services={services} />)

    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    await user.click(await screen.findByRole('button', { name: 'Download and install version 0.1.1' }))
    await user.click(await screen.findByRole('button', { name: 'Restart to finish update' }))

    expect(restart).toHaveBeenCalledOnce()
    expect(await screen.findByRole('alert')).toHaveTextContent('Update installed, but restart failed. Restart Simple Notes manually.')
  })

  it('flushes and locks a dirty editor before restarting into an installed update', async () => {
    const pendingSave = deferred<NoteDocument>()
    const activeId = '019c0000-0000-7000-8000-000000000053' as NoteId
    const notes = fakeNotePort({
      listNotes: vi.fn().mockResolvedValue([{ ...fakeNotePortDocument(activeId, 'Update-safe note'), excerpt: '' }]),
      loadNote: vi.fn().mockResolvedValue(fakeNotePortDocument(activeId, 'Update-safe note', 'old body')),
      saveNote: vi.fn(() => pendingSave.promise),
    })
    const restart = vi.fn().mockResolvedValue(undefined)
    const services = {
      notes, folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      updater: { check: vi.fn().mockResolvedValue({ version: '0.1.1', notes: null }), install: vi.fn().mockResolvedValue(undefined), restart },
    }
    const user = userEvent.setup()
    render(<App services={services} />)
    await user.click(await screen.findByRole('button', { name: /^Update-safe note/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'dirty update draft' } }))
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))
    await user.click(await screen.findByRole('button', { name: 'Download and install version 0.1.1' }))
    await user.click(await screen.findByRole('button', { name: 'Restart to finish update' }))

    await waitFor(() => expect(notes.saveNote).toHaveBeenCalledOnce())
    expect(restart).not.toHaveBeenCalled()
    expect(editor.state.facet(EditorView.editable)).toBe(false)
    await act(async () => pendingSave.resolve({ ...fakeNotePortDocument(activeId, 'Update-safe note', 'dirty update draft'), revision: 2 }))
    await waitFor(() => expect(restart).toHaveBeenCalledOnce())
  })

  it('announces the actual startup recovery report in the main application', async () => {
    render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      recovery: {
        load: vi.fn().mockResolvedValue({ recovered: [{ noteId: '019c0000-0000-7000-8000-000000000002', revision: 2 }], quarantined: [], ambiguous: [], indexRebuilt: true, indexQuarantine: null }),
        retry: vi.fn(),
      },
    }} />)

    expect(await screen.findByText('已恢复 1 篇笔记并重建本地索引')).toHaveAttribute('role', 'status')
  })

  it('keeps the application usable when startup recovery fails and retries the recovery operation', async () => {
    const retry = vi.fn()
      .mockRejectedValueOnce(new Error('disk still busy'))
      .mockResolvedValue({
      recovered: [], quarantined: [], ambiguous: [], indexRebuilt: true, indexQuarantine: null, failure: null,
      })
    render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      recovery: {
        load: vi.fn().mockResolvedValue({
          recovered: [], quarantined: [], ambiguous: [], indexRebuilt: false, indexQuarantine: null,
          failure: { code: 'database', message: 'The local note index is unavailable.' },
        }),
        retry,
      },
    }} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('本地索引恢复未完成')
    expect(screen.getByRole('application', { name: 'Simple Notes' })).toBeVisible()
    await userEvent.setup().click(screen.getByRole('button', { name: '重试启动恢复' }))
    await waitFor(() => expect(retry).toHaveBeenCalledOnce())
    expect(screen.getByRole('alert')).toHaveTextContent('本地索引恢复仍未完成')
    await userEvent.setup().click(screen.getByRole('button', { name: '重试启动恢复' }))
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/并重建本地索引/)).toHaveAttribute('role', 'status')
  })

  it('refreshes recovered folders, notes, and the mounted temporary inbox after a repeated retry', async () => {
    const recoveredFolderId = '019c0000-0000-7000-8000-000000000041' as FolderId
    const recoveredNoteId = '019c0000-0000-7000-8000-000000000042' as NoteId
    const recoveredTemporaryId = '019c0000-0000-7000-8000-000000000043' as NoteId
    const listFolders = vi.fn()
      .mockRejectedValueOnce(new Error('recovery incomplete'))
      .mockResolvedValue([{ id: recoveredFolderId, parentId: null, name: 'Recovered folder', sortOrder: 0 }])
    const listNotes = vi.fn()
      .mockRejectedValueOnce(new Error('recovery incomplete'))
      .mockResolvedValue([{ id: recoveredNoteId, title: 'Recovered formal note', folderId: null, tags: [], updatedAt: '2026-08-10T00:00:00Z' }])
    const listTemporary = vi.fn()
      .mockRejectedValueOnce(new Error('recovery incomplete'))
      .mockResolvedValue([{
        id: recoveredTemporaryId, kind: 'temporary', title: 'Recovered capture', folderId: null,
        tags: [], markdown: 'durable temporary truth', revision: 1,
        createdAt: '2026-08-10T00:00:00Z', updatedAt: '2026-08-10T00:00:00Z',
      }])
    const retry = vi.fn()
      .mockRejectedValueOnce(new Error('disk still busy'))
      .mockResolvedValue({
        recovered: [], quarantined: [], ambiguous: [], indexRebuilt: true,
        indexQuarantine: null, failure: null,
      })
    const temporary = {
      create: vi.fn(), load: vi.fn(), save: vi.fn(), list: listTemporary,
      convert: vi.fn(), delete: vi.fn(), undoDelete: vi.fn(),
    }

    render(<App services={{
      notes: fakeNotePort({ listNotes }), folders: fakeFolderPort({ listFolders }), system: fakeSystemPort(),
      temporary, assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }),
      search: fakeSearchPort(), links: fakeLinkPort(),
      recovery: {
        load: vi.fn().mockResolvedValue({
          recovered: [], quarantined: [], ambiguous: [], indexRebuilt: false, indexQuarantine: null,
          failure: { code: 'database', message: 'The local note index is unavailable.' },
        }),
        retry,
      },
    }} />)

    expect(await screen.findByRole('alert')).toBeVisible()
    await waitFor(() => expect(listFolders).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(1))
    await userEvent.setup().click(screen.getAllByRole('treeitem')[1])
    await waitFor(() => expect(listTemporary).toHaveBeenCalledTimes(1))

    await userEvent.setup().click(screen.getAllByRole('alert')[0].querySelector('button')!)
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
    expect(listFolders).toHaveBeenCalledTimes(1)
    expect(listNotes).toHaveBeenCalledTimes(1)
    expect(listTemporary).toHaveBeenCalledTimes(1)

    await userEvent.setup().click(screen.getAllByRole('alert')[0].querySelector('button')!)
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listFolders).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listTemporary).toHaveBeenCalledTimes(2))
    expect((await screen.findAllByText('durable temporary truth')).length).toBeGreaterThan(0)
    expect(screen.getByText('Recovered folder')).toBeVisible()

    await userEvent.setup().click(screen.getAllByRole('treeitem')[0])
    expect(await screen.findByText('Recovered formal note')).toBeVisible()
  })

  it('keeps recovery retry single-flight while the retry and its refresh are deferred', async () => {
    const retryResult = deferred<{
      recovered: never[]; quarantined: never[]; ambiguous: never[]; indexRebuilt: boolean
      indexQuarantine: null; failure: null
    }>()
    const refreshFolders = deferred<never[]>()
    const listFolders = vi.fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => refreshFolders.promise)
    const retry = vi.fn(() => retryResult.promise)
    render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort({ listFolders }), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      recovery: {
        load: vi.fn().mockResolvedValue({
          recovered: [], quarantined: [], ambiguous: [], indexRebuilt: false, indexQuarantine: null,
          failure: { code: 'database', message: 'The local note index is unavailable.' },
        }),
        retry,
      },
    }} />)

    const retryButton = await screen.findByRole('button', { name: '重试启动恢复' })
    fireEvent.click(retryButton)
    fireEvent.click(retryButton)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retryButton).toBeDisabled()

    retryResult.resolve({
      recovered: [], quarantined: [], ambiguous: [], indexRebuilt: true,
      indexQuarantine: null, failure: null,
    })
    await waitFor(() => expect(listFolders).toHaveBeenCalledTimes(2))
    fireEvent.click(retryButton)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retryButton).toBeDisabled()

    refreshFolders.resolve([])
    expect(await screen.findByText(/重建本地索引/)).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('button', { name: '重试启动恢复' })).not.toBeInTheDocument()
  })

  it('loads application settings, applies their theme, and opens settings from the main window', async () => {
    const user = userEvent.setup()
    render(
      <App services={{
        notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
        assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
        settings: fakeSettingsPort({ load: async () => ({
          theme: 'sand', stickyColorMode: 'follow-theme', bodyFont: 'serif', codeFont: 'monospace', fontSize: 18,
          lineHeight: 1.7, shortcut: 'Ctrl+N', launchAtStartup: false, defaultEditorMode: 'split', autosaveDelayMs: 800,
          dataRoot: { mode: 'default' },
        }) }),
      }} />,
    )
    const app = screen.getByRole('application', { name: 'Simple Notes' })
    await waitFor(() => expect(app).toHaveAttribute('data-theme', 'sand'))
    expect(app.style.getPropertyValue('--body-font-size')).toBe('18px')
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(screen.getByRole('dialog', { name: '设置' })).toBeVisible()
  })

  it('owns a deferred export across settings close attempts and preserves its report after reopen', async () => {
    const pending = deferred<ExportReport>()
    const exportLibrary = vi.fn(() => pending.promise)
    const user = userEvent.setup()
    render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      settings: fakeSettingsPort(), exporter: { exportLibrary },
      exportDestinationPicker: { chooseExportDestination: vi.fn().mockResolvedValue('D:\\Portable Notes') },
    }} />)

    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: 'Export complete library' }))
    expect(exportLibrary).toHaveBeenCalledTimes(1)
    const dialog = screen.getByRole('dialog', { name: '设置' })
    const headerClose = dialog.querySelector<HTMLButtonElement>('header button')
    const footerClose = dialog.querySelector<HTMLButtonElement>('footer > button')
    expect(headerClose).toBeDisabled()
    expect(footerClose).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Exporting library…' }))
    expect(exportLibrary).toHaveBeenCalledTimes(1)
    expect(dialog).toBeVisible()

    pending.resolve({
      completed: true,
      outputRoot: 'D:\\Portable Notes\\Simple Notes Export',
      incompleteRoot: null,
      globalFailure: null,
      notesExported: 2,
      assetsExported: 1,
      renamedPaths: [],
      failed: [],
    })
    expect(await screen.findByText(/Exported 2 notes and 1 asset\./)).toBeVisible()
    expect(headerClose).toBeEnabled()
    await user.click(headerClose!)
    expect(screen.queryByRole('dialog', { name: '设置' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(screen.getByText(/Exported 2 notes and 1 asset\./)).toBeVisible()
  })

  it('ignores a deferred export completion after the application unmounts', async () => {
    const pending = deferred<ExportReport>()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const user = userEvent.setup()
    const rendered = render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      settings: fakeSettingsPort(), exporter: { exportLibrary: vi.fn(() => pending.promise) },
      exportDestinationPicker: { chooseExportDestination: vi.fn().mockResolvedValue('D:\\Portable Notes') },
    }} />)
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: 'Export complete library' }))

    rendered.unmount()
    pending.resolve({
      completed: true,
      outputRoot: 'D:\\Portable Notes\\Simple Notes Export',
      incompleteRoot: null,
      globalFailure: null,
      notesExported: 1,
      assetsExported: 0,
      renamedPaths: [],
      failed: [],
    })
    await pending.promise
    await Promise.resolve()

    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('removes library navigation from interaction after storage relocation requires restart', async () => {
    const user = userEvent.setup()
    render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      settings: fakeSettingsPort(),
    }} />)
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.type(screen.getByLabelText('新的数据位置'), 'D:\\Notes')
    await user.click(screen.getByRole('button', { name: '移动数据' }))
    expect(await screen.findByRole('heading', { name: '需要重新启动' })).toBeVisible()
    expect(screen.queryByRole('navigation', { name: '文件夹' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('adopts settings events, ignores a stale load, and removes the listener on unmount', async () => {
    const pending = deferred<AppSettings>()
    let publish!: (value: AppSettings) => void
    const unlisten = vi.fn()
    const settings = {
      ...fakeSettingsPort({ load: vi.fn(() => pending.promise) }),
      onChanged: vi.fn(async (handler: (value: AppSettings) => void) => { publish = handler; return unlisten }),
    } as SettingsPort & { onChanged(handler: (value: AppSettings) => void): Promise<() => void> }
    const rendered = render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(), settings,
    }} />)
    await waitFor(() => expect(settings.onChanged).toHaveBeenCalledOnce())
    publish({ ...DEFAULT_APP_SETTINGS, theme: 'sand' })
    await waitFor(() => expect(screen.getByRole('application', { name: 'Simple Notes' })).toHaveAttribute('data-theme', 'sand'))
    pending.resolve({ ...DEFAULT_APP_SETTINGS, theme: 'forest' })
    await Promise.resolve()
    expect(screen.getByRole('application', { name: 'Simple Notes' })).toHaveAttribute('data-theme', 'sand')
    rendered.unmount()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('shows a recoverable load error without replacing settings received from an event', async () => {
    let publish!: (value: AppSettings) => void
    const first = deferred<AppSettings>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...DEFAULT_APP_SETTINGS, theme: 'forest' })
    const settings = {
      ...fakeSettingsPort({ load }),
      onChanged: vi.fn(async (handler: (value: AppSettings) => void) => { publish = handler; return () => undefined }),
    }
    render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(), settings,
    }} />)
    await waitFor(() => expect(settings.onChanged).toHaveBeenCalledOnce())
    publish({ ...DEFAULT_APP_SETTINGS, theme: 'sand' })
    first.reject(new Error('broken store'))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载设置')
    expect(screen.getByRole('application', { name: 'Simple Notes' })).toHaveAttribute('data-theme', 'sand')
    await userEvent.setup().click(screen.getByRole('button', { name: '重试加载设置' }))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('uses loaded autosave settings in a sticky route without an inline color override', async () => {
    vi.useFakeTimers()
    const previousUrl = window.location.href
    const temporaryId = '019c0000-0000-7000-8000-000000000031' as NoteId
    window.history.replaceState(null, '', `?sticky=${temporaryId}`)
    const capture: NoteDocument = {
      id: temporaryId, kind: 'temporary', title: 'Capture', folderId: null, tags: [], markdown: 'old', revision: 0,
      createdAt: '2026-07-30T08:00:00Z', updatedAt: '2026-07-30T08:00:00Z',
    }
    const save = vi.fn(async (document: NoteDocument) => ({ ...document, revision: 1 }))
    const fullSettingsLoad = vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS)
    render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      temporary: { load: vi.fn().mockResolvedValue(capture), save, create: vi.fn(), list: vi.fn(), convert: vi.fn(), delete: vi.fn(), undoDelete: vi.fn() },
      temporaryWindows: { hide: vi.fn(), show: vi.fn(), setAlwaysOnTop: vi.fn(), startDragging: vi.fn() },
      settings: fakeSettingsPort({ load: fullSettingsLoad }),
      stickySettings: fakeStickySettingsPort({ load: vi.fn().mockResolvedValue({ ...defaultStickySettings, theme: 'sand', bodyFont: 'Sticky Serif', codeFont: 'Sticky Mono', fontSize: 19, lineHeight: 1.8, autosaveDelayMs: 150 }) }),
    }} />)
    await act(async () => undefined)
    await act(async () => undefined)
    const editor = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    const shell = screen.getByTestId('sticky-window').parentElement
    expect(shell).toHaveAttribute('data-theme', 'sand')
    expect(shell?.style.getPropertyValue('--body-font')).toBe('Sticky Serif')
    expect(shell?.style.getPropertyValue('--code-font')).toBe('Sticky Mono')
    expect(shell?.style.getPropertyValue('--body-font-size')).toBe('19px')
    expect(shell?.style.getPropertyValue('--body-line-height')).toBe('1.8')
    expect(fullSettingsLoad).not.toHaveBeenCalled()
    expect(screen.getByTestId('sticky-window')).not.toHaveAttribute('style')
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'new' } })
    await vi.advanceTimersByTimeAsync(149)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledOnce()
    window.history.replaceState(null, '', previousUrl)
    vi.useRealTimers()
  })

  it('adopts narrowed sticky events, ignores a stale sticky load, and removes its listener', async () => {
    const temporaryId = '019c0000-0000-7000-8000-000000000031' as NoteId
    window.history.replaceState(null, '', `?sticky=${temporaryId}`)
    const pending = deferred<StickySettings>()
    let publish!: (value: StickySettings) => void
    const unlisten = vi.fn()
    const stickySettings = {
      ...fakeStickySettingsPort({ load: vi.fn(() => pending.promise) }),
      onChanged: vi.fn(async (handler: (value: StickySettings) => void) => { publish = handler; return unlisten }),
    } as StickySettingsPort
    const temporary = {
      load: vi.fn().mockResolvedValue({ id: temporaryId, kind: 'temporary', title: 'Capture', folderId: null, tags: [], markdown: '', revision: 0, createdAt: '', updatedAt: '' }),
      save: vi.fn(), create: vi.fn(), list: vi.fn(), convert: vi.fn(), delete: vi.fn(), undoDelete: vi.fn(),
    }
    const rendered = render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      temporary, temporaryWindows: { hide: vi.fn(), show: vi.fn(), setAlwaysOnTop: vi.fn(), startDragging: vi.fn() }, stickySettings,
    }} />)
    await waitFor(() => expect(stickySettings.onChanged).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('sticky-window')).not.toBeInTheDocument()
    act(() => publish({ ...defaultStickySettings, theme: 'sand', fontSize: 20 }))
    const sticky = await screen.findByTestId('sticky-window')
    expect(sticky.parentElement).toHaveAttribute('data-theme', 'sand')
    pending.resolve({ ...defaultStickySettings, theme: 'forest', fontSize: 14 })
    await act(async () => pending.promise)
    expect(sticky.parentElement).toHaveAttribute('data-theme', 'sand')
    rendered.unmount()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('shows sticky appearance load failure and retries without adopting an unmounted completion', async () => {
    const temporaryId = '019c0000-0000-7000-8000-000000000031' as NoteId
    window.history.replaceState(null, '', `?sticky=${temporaryId}`)
    const retry = deferred<StickySettings>()
    const unlisten = vi.fn()
    const load = vi.fn().mockRejectedValueOnce(new Error('denied')).mockReturnValueOnce(retry.promise)
    const stickySettings = fakeStickySettingsPort({ load, onChanged: vi.fn().mockResolvedValue(unlisten) })
    const rendered = render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(), stickySettings,
    }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载便签外观')
    await userEvent.setup().click(screen.getByRole('button', { name: '重试加载便签外观' }))
    expect(load).toHaveBeenCalledTimes(2)
    rendered.unmount()
    retry.resolve({ ...defaultStickySettings, theme: 'sand' })
    await retry.promise
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('tracks system color-scheme changes and cleans up the media listener', async () => {
    let listener!: (event: MediaQueryListEvent) => void
    const removeEventListener = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)', media: query,
      addEventListener: vi.fn((_type: string, next: (event: MediaQueryListEvent) => void) => { listener = next }),
      removeEventListener,
    })))
    const rendered = render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      settings: fakeSettingsPort({ load: vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, theme: 'system' }) }),
    }} />)
    const app = screen.getByRole('application', { name: 'Simple Notes' })
    await waitFor(() => expect(app.style.getPropertyValue('--color-canvas')).toBe('#202729'))
    act(() => listener({ matches: false } as MediaQueryListEvent))
    await waitFor(() => expect(app.style.getPropertyValue('--color-canvas')).toBe('#edf0f2'))
    rendered.unmount()
    expect(removeEventListener).toHaveBeenCalledOnce()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fakeNotePortDocument(id: NoteId, title: string, markdown = ''): NoteDocument {
  return {
    id,
    kind: 'formal',
    title,
    folderId: null,
    tags: [],
    markdown,
    revision: 1,
    createdAt: '2026-07-30T00:00:00Z',
    updatedAt: '2026-07-30T00:00:00Z',
  }
}
