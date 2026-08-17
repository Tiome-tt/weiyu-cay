import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import tauriConfig from '../../src-tauri/tauri.conf.json'
import { fakeWindowChromePort } from '../test/fakes'
import { AppChrome } from './AppChrome'

describe('AppChrome', () => {
  afterEach(cleanup)

  it('leaves drag gestures to the Tauri region and routes labelled controls through the port', async () => {
    const chrome = fakeWindowChromePort()
    const user = userEvent.setup()
    render(<AppChrome windowChrome={chrome}><p>workspace</p></AppChrome>)

    const dragRegion = screen.getByTestId('window-drag-region')
    expect(dragRegion).toHaveAttribute('data-tauri-drag-region')
    expect(dragRegion).not.toHaveTextContent('微屿')
    expect(screen.getByText('workspace')).toBeVisible()

    fireEvent.pointerDown(dragRegion, { button: 0 })
    await user.dblClick(dragRegion)
    await user.click(screen.getByRole('button', { name: '最小化窗口' }))
    await user.click(screen.getByRole('button', { name: '最大化或还原窗口' }))
    await user.click(screen.getByRole('button', { name: '关闭窗口' }))

    expect(chrome.startDragging).not.toHaveBeenCalled()
    expect(chrome.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(chrome.minimize).toHaveBeenCalledTimes(1)
    expect(chrome.requestClose).toHaveBeenCalledTimes(1)
  })

  it('keeps window controls outside the drag region and follows platform placement', () => {
    const windowsChrome = fakeWindowChromePort({ platform: 'windows' })
    const windows = render(<AppChrome windowChrome={windowsChrome}>windows</AppChrome>)
    const windowsRow = screen.getByTestId('window-titlebar')
    expect(windowsRow.lastElementChild).toHaveAttribute('data-testid', 'window-controls')
    expect(within(screen.getByTestId('window-drag-region')).queryByRole('button')).not.toBeInTheDocument()
    windows.unmount()

    const macosChrome = fakeWindowChromePort({ platform: 'macos' })
    render(<AppChrome windowChrome={macosChrome}>macos</AppChrome>)
    const macosRow = screen.getByTestId('window-titlebar')
    expect(macosRow.firstElementChild).toHaveAttribute('data-testid', 'window-controls')
  })

  it('does not start a drag from interactive window controls', () => {
    const chrome = fakeWindowChromePort()
    render(<AppChrome windowChrome={chrome}>workspace</AppChrome>)

    fireEvent.pointerDown(screen.getByRole('button', { name: '关闭窗口' }), { button: 0 })

    expect(chrome.startDragging).not.toHaveBeenCalled()
  })

  it('keeps the frameless main window at its approved working size contract', () => {
    expect(tauriConfig.app.windows[0]).toMatchObject({
      decorations: false,
      width: 1180,
      height: 760,
      minWidth: 800,
      minHeight: 560,
    })
  })
})
