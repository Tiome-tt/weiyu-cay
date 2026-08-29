import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, SettingsPort } from '../../domain/ports'
import { SettingsView } from './SettingsView'
import { DEFAULT_APP_SETTINGS } from './theme'
import type { UpdateController } from './UpdateSettings'

function settingsPort(overrides: Partial<SettingsPort> = {}): SettingsPort {
  return {
    load: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
    update: vi.fn().mockImplementation(async (patch: Partial<AppSettings>) => ({ ...DEFAULT_APP_SETTINGS, ...patch })),
    reset: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
    getStorageInfo: vi.fn().mockResolvedValue({ root: 'Application data', noteBytes: 1024, assetBytes: 2048, trashBytes: 0 }),
    moveStorageRoot: vi.fn().mockResolvedValue(undefined),
    restartApplication: vi.fn().mockResolvedValue(undefined),
    onChanged: vi.fn().mockResolvedValue(() => undefined),
    getShortcutStatus: vi.fn().mockResolvedValue({ current: DEFAULT_APP_SETTINGS.shortcut, registration: { state: 'active' }, acceptingTriggers: true, startupError: null }),
    ...overrides,
  }
}

describe('SettingsView', () => {
  afterEach(cleanup)
  it('exposes the complete accessible settings surface and loads storage information', async () => {
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    expect(screen.getByRole('heading', { name: '设置' })).toBeVisible()
    expect(screen.getByRole('dialog', { name: '设置' })).toHaveTextContent('微屿')
    expect(screen.queryByText('Simple Notes')).not.toBeInTheDocument()
    expect(screen.getByLabelText('主题')).toHaveValue('forest')
    expect(screen.getByRole('option', { name: '夜海深色' })).toHaveValue('night')
    expect(screen.getByLabelText('正文字体')).toHaveRole('combobox')
    expect(screen.getByLabelText('代码字体')).toHaveRole('combobox')
    expect(screen.getByRole('option', { name: '苹方' })).toHaveValue('PingFang SC, PingFang TC, sans-serif')
    expect(screen.getByRole('option', { name: '等线' })).toHaveValue('DengXian, sans-serif')
    expect(screen.getByRole('option', { name: 'Cascadia Mono' })).toHaveValue('Cascadia Mono')
    expect(screen.getByRole('option', { name: 'Menlo' })).toHaveValue('Menlo')
    expect(screen.getByLabelText('字号')).toHaveAttribute('min', '12')
    expect(screen.getByLabelText('行高')).toHaveAttribute('max', '2.2')
    expect(screen.getByLabelText('全局快捷键')).toBeVisible()
    expect(screen.getByLabelText('开机启动')).toBeVisible()
    expect(screen.getByLabelText('默认编辑视图')).toBeVisible()
    expect(screen.getByRole('option', { name: '文档编辑' })).toHaveValue('source')
    expect(screen.getByRole('option', { name: '分栏校对' })).toHaveValue('split')
    expect(screen.getByRole('option', { name: '阅读视图' })).toHaveValue('preview')
    expect(screen.getByLabelText('自动保存延迟')).toHaveAttribute('min', '150')
    expect(await screen.findByText(/3 KB/)).toBeVisible()
  })

  it('records a shortcut from the keyboard instead of asking for accelerator text', async () => {
    const user = userEvent.setup()
    const update = vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, shortcut: 'Control+Alt+N' })
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    const record = screen.getByRole('button', { name: '录制快捷键' })
    await user.click(record)
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}')
    expect(screen.getByLabelText('全局快捷键')).toHaveValue('Control+Alt+N')
    expect(update).toHaveBeenCalledWith({ shortcut: 'Control+Alt+N' })
  })

  it('records a single key after it is released', async () => {
    const user = userEvent.setup()
    const update = vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, shortcut: 'F8' })
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    await user.click(screen.getByRole('button', { name: '录制快捷键' }))
    await user.keyboard('{F8}')
    expect(screen.getByLabelText('全局快捷键')).toHaveValue('F8')
    expect(update).toHaveBeenCalledWith({ shortcut: 'F8' })
  })

  it('renders storage and export copy in Chinese and hides the Windows path prefix', async () => {
    render(<SettingsView settings={settingsPort({ getStorageInfo: vi.fn().mockResolvedValue({ root: '\\\\?\\C:\\Notes', noteBytes: 1, assetBytes: 2, trashBytes: 0 }) })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} exportController={{ busy: false, report: null, status: null, error: null, startExport: vi.fn() }} />)
    expect(await screen.findByText('C:\\Notes · 3 B')).toBeVisible()
    expect(screen.getByRole('dialog', { name: '设置' })).toHaveTextContent('便携式导出')
    expect(screen.queryByText('Portable export')).not.toBeInTheDocument()
  })

  it('hosts the explicit update controls inside settings', async () => {
    const check = vi.fn().mockResolvedValue(undefined)
    const updateController: UpdateController = { state: { status: 'idle' }, check, install: vi.fn(), restart: vi.fn() }
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} updateController={updateController} />)

    await user.click(screen.getByRole('button', { name: '检查更新' }))
    expect(check).toHaveBeenCalledOnce()
  })

  it('shows a startup shortcut registration warning without disabling local notes', async () => {
    render(<SettingsView settings={settingsPort({
      getShortcutStatus: vi.fn().mockResolvedValue({
        current: null, registration: { state: 'inactive' }, acceptingTriggers: false,
        startupError: { kind: 'conflict', reason: 'already registered', accelerator: 'CommandOrControl+Shift+Space' },
      }),
    })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    expect(await screen.findByRole('status', { name: '快捷键状态警告' })).toHaveTextContent('全局快捷键未能启用')
    expect(screen.getByRole('dialog', { name: '设置' })).toBeVisible()
  })

  it('reports shortcut conflicts without replacing the prior shortcut', async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error('shortcut conflict'))
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    await user.click(screen.getByRole('button', { name: '录制快捷键' }))
    await user.keyboard('{Control>}{Space}{/Control}')
    expect(await screen.findByRole('alert')).toHaveTextContent('快捷键已被占用')
  })

  it('refreshes shortcut startup status after a successful deferred shortcut update', async () => {
    const updated = deferred<AppSettings>()
    const refreshed = deferred<Awaited<ReturnType<SettingsPort['getShortcutStatus']>>>()
    const getShortcutStatus = vi.fn()
      .mockResolvedValueOnce({ current: null, registration: { state: 'inactive' }, acceptingTriggers: false, startupError: { kind: 'conflict', reason: 'occupied' } })
      .mockReturnValueOnce(refreshed.promise)
    const update = vi.fn().mockReturnValue(updated.promise)
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ update, getShortcutStatus })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    expect(await screen.findByRole('status', { name: '快捷键状态警告' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: '录制快捷键' }))
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}')
    expect(getShortcutStatus).toHaveBeenCalledOnce()
    updated.resolve({ ...DEFAULT_APP_SETTINGS, shortcut: 'Ctrl+Alt+N' })
    await waitFor(() => expect(getShortcutStatus).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('status', { name: '快捷键状态警告' })).toBeVisible()
    refreshed.resolve({ current: 'Ctrl+Alt+N', registration: { state: 'active' }, acceptingTriggers: true, startupError: null })
    await waitFor(() => expect(screen.queryByRole('status', { name: '快捷键状态警告' })).not.toBeInTheDocument())
  })

  it('serializes every settings mutation while an update is pending', async () => {
    const pending = deferred<AppSettings>()
    const update = vi.fn().mockReturnValue(pending.promise)
    const reset = vi.fn()
    const moveStorageRoot = vi.fn()
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ update, reset, moveStorageRoot })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    await user.selectOptions(screen.getByLabelText('主题'), 'sand')
    expect(update).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('主题')).toBeDisabled()
    expect(screen.getByRole('button', { name: '恢复默认设置' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '移动数据' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '恢复默认设置' }))
    expect(reset).not.toHaveBeenCalled()
    expect(moveStorageRoot).not.toHaveBeenCalled()
    pending.resolve({ ...DEFAULT_APP_SETTINGS, theme: 'sand' })
    await waitFor(() => expect(screen.getByLabelText('主题')).toBeEnabled())
  })

  it('allows closing while a font update is still pending', async () => {
    const pending = deferred<AppSettings>()
    const update = vi.fn().mockReturnValue(pending.promise)
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={onClose} prepareStorageMove={async () => () => undefined} />)

    await user.selectOptions(screen.getByLabelText('正文字体'), 'serif')
    await user.click(screen.getByRole('button', { name: '关闭设置' }))

    expect(onClose).toHaveBeenCalledOnce()
    pending.resolve({ ...DEFAULT_APP_SETTINGS, bodyFont: 'serif' })
  })

  it('keeps numeric input editable and persists its complete value on blur', async () => {
    const update = vi.fn().mockImplementation(async (patch: Partial<AppSettings>) => ({ ...DEFAULT_APP_SETTINGS, ...patch }))
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)

    const autosave = screen.getByLabelText('自动保存延迟')
    await user.clear(autosave)
    await user.type(autosave, '650')
    expect(autosave).toHaveValue(650)
    expect(update).not.toHaveBeenCalled()
    await user.tab()
    expect(update).toHaveBeenCalledWith({ autosaveDelayMs: 650 })
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

  it('never offers deletion of a previous root and warns that old data is retained', async () => {
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    await screen.findByText(/Application data/)
    expect(screen.queryByRole('button', { name: '查看旧数据清理说明' })).not.toBeInTheDocument()
    expect(screen.getByText(/不会自动删除旧位置中的数据/)).toBeVisible()
    expect(screen.getByText(/配置和未知文件/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /删除旧数据/ })).not.toBeInTheDocument()
  })

  it('does not expose the old-location candidate browser', async () => {
    render(<SettingsView settings={settingsPort({ getStorageInfo: vi.fn().mockResolvedValue({
      root: 'E:\\Notes', noteBytes: 1, assetBytes: 2, trashBytes: 3,
      previousStorageCleanup: {
        root: 'D:\\Old Notes',
        candidates: [
          { relativePath: 'notes', kind: 'notes' },
          { relativePath: 'index.sqlite-wal', kind: 'index-sidecar' },
        ],
      },
    }) })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    await screen.findByText('E:\\Notes · 6 B')
    expect(screen.queryByRole('button', { name: '查看旧位置候选项' })).not.toBeInTheDocument()
    expect(screen.queryByText('旧位置（仅供核对）')).not.toBeInTheDocument()
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
