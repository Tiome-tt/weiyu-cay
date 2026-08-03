import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import userEvent from '@testing-library/user-event'
import { fakeAssetPort, fakeFolderPort, fakeLinkPort, fakeNotePort, fakeSearchPort, fakeSettingsPort, fakeSystemPort } from '../test/fakes'
import type { AppSettings, SettingsPort } from '../domain/ports'
import { DEFAULT_APP_SETTINGS } from '../features/settings/theme'
import { EditorView } from '@codemirror/view'
import type { NoteDocument, NoteId } from '../domain/model'

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
    render(<App services={{
      notes: fakeNotePort(), folders: fakeFolderPort(), system: fakeSystemPort(),
      assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }), search: fakeSearchPort(), links: fakeLinkPort(),
      temporary: { load: vi.fn().mockResolvedValue(capture), save, create: vi.fn(), list: vi.fn(), convert: vi.fn(), delete: vi.fn(), undoDelete: vi.fn() },
      temporaryWindows: { hide: vi.fn(), show: vi.fn(), setAlwaysOnTop: vi.fn(), startDragging: vi.fn() },
      settings: fakeSettingsPort({ load: vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, autosaveDelayMs: 150 }) }),
    }} />)
    await act(async () => undefined)
    await act(async () => undefined)
    const editor = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    expect(screen.getByTestId('sticky-window')).not.toHaveAttribute('style')
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'new' } })
    await vi.advanceTimersByTimeAsync(149)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledOnce()
    window.history.replaceState(null, '', previousUrl)
    vi.useRealTimers()
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
