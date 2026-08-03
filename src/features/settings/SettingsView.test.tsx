import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, SettingsPort } from '../../domain/ports'
import { SettingsView } from './SettingsView'
import { DEFAULT_APP_SETTINGS } from './theme'

function settingsPort(overrides: Partial<SettingsPort> = {}): SettingsPort {
  return {
    load: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
    update: vi.fn().mockImplementation(async (patch: Partial<AppSettings>) => ({ ...DEFAULT_APP_SETTINGS, ...patch })),
    reset: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
    getStorageInfo: vi.fn().mockResolvedValue({ root: 'Application data', noteBytes: 1024, assetBytes: 2048, trashBytes: 0 }),
    moveStorageRoot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('SettingsView', () => {
  afterEach(cleanup)
  it('exposes the complete accessible settings surface and loads storage information', async () => {
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '设置' })).toBeVisible()
    expect(screen.getByLabelText('主题')).toHaveValue('forest')
    expect(screen.getByLabelText('正文字体')).toBeVisible()
    expect(screen.getByLabelText('代码字体')).toBeVisible()
    expect(screen.getByLabelText('字号')).toHaveAttribute('min', '12')
    expect(screen.getByLabelText('行高')).toHaveAttribute('max', '2.2')
    expect(screen.getByLabelText('全局快捷键')).toBeVisible()
    expect(screen.getByLabelText('开机启动')).toBeVisible()
    expect(screen.getByLabelText('默认编辑视图')).toBeVisible()
    expect(screen.getByLabelText('自动保存延迟')).toHaveAttribute('min', '150')
    expect(await screen.findByText(/3 KB/)).toBeVisible()
  })

  it('publishes only the latest successful update and reports shortcut conflicts', async () => {
    const first = deferred<AppSettings>()
    const second = deferred<AppSettings>()
    const update = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockRejectedValueOnce(new Error('shortcut conflict'))
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={onChange} onClose={vi.fn()} />)

    await user.selectOptions(screen.getByLabelText('主题'), 'sand')
    await user.selectOptions(screen.getByLabelText('主题'), 'system')
    second.resolve({ ...DEFAULT_APP_SETTINGS, theme: 'system' })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'system' })))
    first.resolve({ ...DEFAULT_APP_SETTINGS, theme: 'sand' })
    await Promise.resolve()
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ theme: 'sand' }))

    const shortcut = screen.getByLabelText('全局快捷键')
    await user.clear(shortcut)
    await user.type(shortcut, 'Ctrl+Space')
    await user.click(screen.getByRole('button', { name: '应用快捷键' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('快捷键已被占用')
  })

  it('blocks duplicate mutations, moves storage explicitly, and resets without deleting data', async () => {
    const move = deferred<void>()
    const moveStorageRoot = vi.fn().mockReturnValue(move.promise)
    const reset = vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, theme: 'sand' })
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ moveStorageRoot, reset })} value={DEFAULT_APP_SETTINGS} onChange={onChange} onClose={vi.fn()} />)

    await user.type(screen.getByLabelText('新的数据位置'), 'D:\\Notes')
    const moveButton = screen.getByRole('button', { name: '移动数据' })
    await user.click(moveButton)
    expect(moveButton).toBeDisabled()
    expect(moveStorageRoot).toHaveBeenCalledTimes(1)
    move.resolve()
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复默认设置' })).toBeEnabled())
    expect(screen.getByLabelText('新的数据位置')).toHaveValue('')

    await user.click(screen.getByRole('button', { name: '恢复默认设置' }))
    expect(reset).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'sand' }))
    expect(screen.getByText('笔记数据不会被删除。')).toBeVisible()
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
