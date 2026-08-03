import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './App'
import userEvent from '@testing-library/user-event'
import { fakeAssetPort, fakeFolderPort, fakeLinkPort, fakeNotePort, fakeSearchPort, fakeSettingsPort, fakeSystemPort } from '../test/fakes'

describe('App', () => {
  afterEach(cleanup)
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
})
