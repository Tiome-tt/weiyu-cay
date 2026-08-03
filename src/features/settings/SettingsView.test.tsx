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
    getStorageInfo: vi.fn().mockResolvedValue({ root: 'Application data', noteBytes: 1024, assetBytes: 2048, trashBytes: 0, previousRoot: null, previousRootCleanupReady: false }),
    moveStorageRoot: vi.fn().mockResolvedValue(undefined),
    restartApplication: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('SettingsView', () => {
  afterEach(cleanup)
  it('exposes the complete accessible settings surface and loads storage information', async () => {
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
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
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={onChange} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)

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
    render(<SettingsView settings={settingsPort({ moveStorageRoot, reset })} value={DEFAULT_APP_SETTINGS} onChange={onChange} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)

    await user.click(screen.getByRole('button', { name: '恢复默认设置' }))
    expect(reset).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'sand' }))
    expect(screen.getByText('笔记数据不会被删除。')).toBeVisible()

    await user.type(screen.getByLabelText('新的数据位置'), 'D:\\Notes')
    const moveButton = screen.getByRole('button', { name: '移动数据' })
    await user.click(moveButton)
    expect(moveButton).toBeDisabled()
    expect(moveStorageRoot).toHaveBeenCalledTimes(1)
    move.resolve()
    expect(await screen.findByRole('heading', { name: '需要重新启动' })).toBeVisible()
  })

  it('flushes behind edit barriers before moving and releases them when the move fails', async () => {
    const events: string[] = []
    const release = vi.fn(() => events.push('release'))
    const prepareStorageMove = vi.fn(async () => { events.push('prepare'); return release })
    const moveStorageRoot = vi.fn(async () => { events.push('move'); throw new Error('copy failed') })
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ moveStorageRoot })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={prepareStorageMove} />)
    await user.type(screen.getByLabelText('新的数据位置'), 'D:\\Notes')
    await user.click(screen.getByRole('button', { name: '移动数据' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('原数据位置仍然有效')
    expect(events).toEqual(['prepare', 'move', 'release'])
  })

  it('retains barriers after a move and exposes only the required restart action', async () => {
    const release = vi.fn()
    const restartApplication = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ restartApplication })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={onClose} prepareStorageMove={async () => release} />)
    await user.type(screen.getByLabelText('新的数据位置'), 'D:\\Notes')
    await user.click(screen.getByRole('button', { name: '移动数据' }))
    expect(await screen.findByRole('heading', { name: '需要重新启动' })).toBeVisible()
    expect(release).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '关闭设置' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '完成' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '立即重启' }))
    expect(restartApplication).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not start relocation when held drafts cannot be flushed', async () => {
    const moveStorageRoot = vi.fn()
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ moveStorageRoot })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => null} />)
    await user.type(screen.getByLabelText('新的数据位置'), 'D:\\Notes')
    await user.click(screen.getByRole('button', { name: '移动数据' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请先解决保存错误')
    expect(moveStorageRoot).not.toHaveBeenCalled()
  })

  it('hides old-root cleanup until reopen verification marks it ready', async () => {
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    await screen.findByText(/Application data/)
    expect(screen.queryByRole('button', { name: '查看旧数据清理说明' })).not.toBeInTheDocument()
  })

  it('discloses manual cleanup guidance without deleting the verified old root', async () => {
    const user = userEvent.setup()
    const previousRoot = 'D:\\Simple Notes Previous'
    render(<SettingsView settings={settingsPort({
      getStorageInfo: vi.fn().mockResolvedValue({
        root: 'E:\\Simple Notes', noteBytes: 1024, assetBytes: 2048, trashBytes: 0,
        previousRoot, previousRootCleanupReady: true,
      }),
    })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    const disclosure = await screen.findByRole('button', { name: '查看旧数据清理说明' })
    expect(screen.queryByLabelText('旧数据位置')).not.toBeInTheDocument()
    await user.click(disclosure)
    expect(screen.getByLabelText('旧数据位置')).toHaveValue(previousRoot)
    expect(screen.getByLabelText('旧数据位置')).toHaveAttribute('readonly')
    expect(screen.getByText(/不会自动删除旧数据/)).toBeVisible()
    expect(screen.getByText(/确认笔记和图片附件/)).toBeVisible()
    expect(screen.getByText(/settings\.json/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /删除旧数据/ })).not.toBeInTheDocument()
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
