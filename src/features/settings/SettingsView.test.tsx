import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiPort, AppSettings, SettingsPort } from '../../domain/ports'
import { SettingsView } from './SettingsView'
import { DEFAULT_APP_SETTINGS } from './theme'
import type { UpdateController } from './UpdateSettings'

afterEach(cleanup)

it('saves the selected image quality from Storage settings', async () => {
  const update = vi.fn().mockImplementation(async (patch: Partial<AppSettings>) => ({ ...DEFAULT_APP_SETTINGS, ...patch }))
  render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
  await userEvent.click(screen.getByRole('tab', { name: '存储' }))
  const quality = screen.getByRole('combobox', { name: '图片保存质量' })
  expect(quality).toHaveValue('webp-q95')
  expect(screen.getByRole('option', { name: '高清压缩（推荐）' })).toHaveValue('webp-q95')
  expect(screen.getByRole('option', { name: '省空间压缩' })).toHaveValue('webp-q85')
  expect(screen.getByRole('option', { name: '保留原图' })).toHaveValue('original')
  expect(screen.getByText(/高清压缩可能微损画质；仅处理新插入的静态图片/)).toBeVisible()
  expect(screen.queryByText(/仅影响今后插入的静态图片/)).not.toBeInTheDocument()
  expect(screen.getByRole('separator', { name: '图片保存与数据位置分隔' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '存储位置与迁移' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: '迁移目标文件夹' })).toBeVisible()
  await userEvent.selectOptions(quality, 'original')
  await waitFor(() => expect(update).toHaveBeenCalledWith({ imageSaveQuality: 'original' }))
  expect(screen.getByText(/保留原有格式与画质/)).toBeVisible()
})

function settingsPort(overrides: Partial<SettingsPort> = {}): SettingsPort {
  return {
    load: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
    update: vi.fn().mockImplementation(async (patch: Partial<AppSettings>) => ({ ...DEFAULT_APP_SETTINGS, ...patch })),
    reset: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
    getStorageInfo: vi.fn().mockResolvedValue({ root: 'Application data', noteBytes: 1024, assetBytes: 2048, trashBytes: 0 }),
    chooseStorageDirectory: vi.fn().mockResolvedValue('D:\\Notes'),
    moveStorageRoot: vi.fn().mockResolvedValue(undefined),
    restartApplication: vi.fn().mockResolvedValue(undefined),
    onChanged: vi.fn().mockResolvedValue(() => undefined),
    setShortcutRecording: vi.fn().mockResolvedValue(undefined),
  getShortcutStatus: vi.fn().mockResolvedValue({ current: DEFAULT_APP_SETTINGS.shortcut, registration: { state: 'active' }, acceptingTriggers: true, startupError: null }),
    ...overrides,
  }
}

function aiPort(overrides: Partial<AiPort> = {}): AiPort {
  return {
    getCredentialStatus: vi.fn().mockResolvedValue({ configured: false, storage: 'encrypted-file' }),
    saveDeepSeekApiKey: vi.fn().mockResolvedValue({ configured: true, storage: 'system-keyring' }),
    clearDeepSeekApiKey: vi.fn().mockResolvedValue({ configured: false, storage: 'encrypted-file' }),
    getCachedSummary: vi.fn().mockResolvedValue(null),
    summarize: vi.fn().mockResolvedValue({ summary: '', keyPoints: [], outline: [], todos: [], keywords: [] }),
    ...overrides,
  }
}
describe('SettingsView', () => {
  it('records the search shortcut from its field', async () => {
    const port = settingsPort()
    render(<SettingsView settings={port} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async()=>()=>undefined}/>)
    const user=userEvent.setup()
    await user.click(screen.getByRole('tab', {name:'按键'}))
    await user.click(screen.getByRole('textbox', {name:'搜索快捷键'}))
    await user.keyboard('{Control>}k{/Control}')
    await waitFor(()=>expect(port.update).toHaveBeenCalledWith(expect.objectContaining({searchShortcut:'Control+K'})))
  })

  it('restores capture when leaving the recording category', async () => {
    const setShortcutRecording=vi.fn().mockResolvedValue(undefined)
    const user=userEvent.setup()
    render(<SettingsView settings={settingsPort({setShortcutRecording})} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async()=>()=>undefined}/>)
    await user.click(screen.getByRole('tab',{name:'按键'}))
    await user.click(screen.getByRole('textbox',{name:'便笺快捷键'}))
    await user.click(screen.getByRole('tab',{name:'常规'}))
    await waitFor(()=>expect(setShortcutRecording).toHaveBeenLastCalledWith(false))
  })
  it('shows native shortcut labels and suspends capture until recording finishes', async () => {
    const setShortcutRecording = vi.fn().mockResolvedValue(undefined)
    render(<SettingsView settings={settingsPort({ setShortcutRecording })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: '按键' }))
    expect(screen.getByLabelText('便笺快捷键')).toHaveValue('Ctrl+Shift+D')
    await user.click(screen.getByRole('textbox', { name: '便笺快捷键' }))
    await waitFor(() => expect(setShortcutRecording).toHaveBeenCalledWith(true))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(setShortcutRecording).toHaveBeenLastCalledWith(false))
    expect(screen.getByLabelText('便笺快捷键')).toHaveValue('Ctrl+Shift+D')
  })

  afterEach(cleanup)
  it('navigates settings categories without discarding an unfinished API Key', async () => {
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} ai={aiPort()} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    const user = userEvent.setup()
    expect(screen.getByRole('tab', { name: '常规' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('tab', { name: 'AI' }))
    await user.type(screen.getByLabelText('DeepSeek API Key'), 'sk-draft')
    await user.click(screen.getByRole('tab', { name: '系统' }))
    expect(screen.getByLabelText('主题')).not.toBeVisible()
    expect(screen.getByLabelText('开机启动')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'AI' }))
    expect(screen.getByLabelText('DeepSeek API Key')).toHaveValue('sk-draft')
  })

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
    expect(screen.getByLabelText('界面字号')).toHaveAttribute('min', '12')
    expect(screen.getByLabelText('每日歌词')).toBeChecked()
    expect(screen.queryByText('只调整应用界面，不影响笔记正文')).not.toBeInTheDocument()
    expect(screen.getByLabelText('行高')).toHaveAttribute('max', '2.2')
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))
    fireEvent.click(screen.getByRole('tab', { name: '按键' }))
    expect(screen.getByLabelText('便笺快捷键')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))
    expect(screen.getByLabelText('开机启动')).toBeVisible()
    expect(screen.getByLabelText('关闭主窗口时隐藏到托盘')).toBeChecked()
    fireEvent.click(screen.getByRole('tab', { name: '常规' }))
    expect(screen.getByLabelText('默认编辑视图')).toBeVisible()
    expect(screen.getByRole('option', { name: '文档编辑' })).toHaveValue('source')
    expect(screen.getByRole('option', { name: '分栏校对' })).toHaveValue('split')
    expect(screen.getByRole('option', { name: '阅读视图' })).toHaveValue('preview')
    expect(screen.getByLabelText('自动保存延迟')).toHaveAttribute('min', '150')
    fireEvent.click(screen.getByRole('tab', { name: '存储' }))
    expect(await screen.findByText(/3 KB/)).toBeVisible()
  })

  it('passes a newly entered API Key to the AI port and clears the draft after saving', async () => {
    const saveDeepSeekApiKey = vi.fn().mockResolvedValue({ configured: true, storage: 'system-keyring' })
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} ai={aiPort({ saveDeepSeekApiKey })} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))

    await user.type(screen.getByLabelText('DeepSeek API Key'), 'sk-test-key')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(saveDeepSeekApiKey).toHaveBeenCalledWith('sk-test-key'))
    expect(screen.getByLabelText('DeepSeek API Key')).toHaveValue('')
    expect(screen.queryByText('已配置（加密保存）')).not.toBeInTheDocument()
  })
  it('persists the daily lyric visibility switch', async () => {
    const update = vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, dailyLyrics: false })
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)

    await user.click(screen.getByLabelText('每日歌词'))

    expect(update).toHaveBeenCalledWith({ dailyLyrics: false })
  })
  it('persists an explicit Windows close behavior and marks the first-close choice confirmed', async () => {
    const update = vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, closeToTray: false, closeBehaviorConfirmed: true })
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} platform="windows" onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))

    await user.click(screen.getByLabelText('关闭主窗口时隐藏到托盘'))

    expect(update).toHaveBeenCalledWith({ closeToTray: false, closeBehaviorConfirmed: true })
    expect(screen.queryByLabelText('在菜单栏显示微屿图标')).not.toBeInTheDocument()
  })

  it('lets Windows users show the close choice again without changing their tray preference', async () => {
    const initial = { ...DEFAULT_APP_SETTINGS, closeToTray: false, closeBehaviorConfirmed: true }
    const user = userEvent.setup()
    render(
      <SettingsView
        settings={settingsPort({ update: async (patch) => ({ ...initial, ...patch }) })}
        value={initial}
        platform="windows"
        onChange={vi.fn()}
        onClose={vi.fn()}
        prepareStorageMove={async () => () => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))

    await user.click(screen.getByRole('button', { name: '下次关闭时重新询问' }))

    expect(screen.getByLabelText('关闭主窗口时隐藏到托盘')).not.toBeChecked()
    expect(await screen.findByRole('button', { name: '下次关闭时会询问' })).toBeDisabled()
  })

  it('keeps native close semantics on macOS and offers only the menu-bar icon setting', () => {
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} platform="macos" onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))

    expect(screen.getByLabelText('在菜单栏显示微屿图标')).toBeChecked()
    expect(screen.queryByLabelText('关闭主窗口时隐藏到托盘')).not.toBeInTheDocument()
  })

  it('records a shortcut from the keyboard instead of asking for accelerator text', async () => {
    const user = userEvent.setup()
    const update = vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, shortcut: 'Control+Alt+N' })
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))
    await user.click(screen.getByRole('tab', { name: '按键' }))
    const record = screen.getByRole('textbox', { name: '便笺快捷键' })
    await user.click(record)
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}')
    expect(screen.getByLabelText('便笺快捷键')).toHaveValue('Ctrl+Alt+N')
    expect(update).toHaveBeenCalledWith({ shortcut: 'Control+Alt+N' })
  })

  it('records a single key after it is released', async () => {
    const user = userEvent.setup()
    const update = vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, shortcut: 'F8' })
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))
    await user.click(screen.getByRole('tab', { name: '按键' }))
    await user.click(screen.getByRole('textbox', { name: '便笺快捷键' }))
    await user.keyboard('{F8}')
    expect(screen.getByLabelText('便笺快捷键')).toHaveValue('F8')
    expect(update).toHaveBeenCalledWith({ shortcut: 'F8' })
  })

  it('renders storage and export copy in Chinese and hides the Windows path prefix', async () => {
    render(<SettingsView settings={settingsPort({ getStorageInfo: vi.fn().mockResolvedValue({ root: '\\\\?\\C:\\Notes', noteBytes: 1, assetBytes: 2, trashBytes: 0 }) })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} exportController={{ busy: false, report: null, status: null, error: null, startExport: vi.fn() }} />)
    fireEvent.click(screen.getByRole('tab', { name: '存储' }))
    expect(await screen.findByText('当前位置：C:\\Notes · 3 B')).toBeVisible()
    expect(screen.getByRole('dialog', { name: '设置' })).toHaveTextContent('便携式导出')
    expect(screen.queryByText('Portable export')).not.toBeInTheDocument()
  })

  it('hosts the explicit update controls inside settings', async () => {
    const check = vi.fn().mockResolvedValue(undefined)
    const updateController: UpdateController = { state: { status: 'idle' }, check, install: vi.fn(), restart: vi.fn() }
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} updateController={updateController} />)
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))

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
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))
    expect(await screen.findByRole('status', { name: '快捷键状态警告' })).toHaveTextContent('便笺快捷键未能启用')
    expect(screen.getByRole('dialog', { name: '设置' })).toBeVisible()
  })

  it('reports shortcut conflicts without replacing the prior shortcut', async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error('shortcut conflict'))
    const user = userEvent.setup()
    render(<SettingsView settings={settingsPort({ update })} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))
    await user.click(screen.getByRole('tab', { name: '按键' }))
    await user.click(screen.getByRole('textbox', { name: '便笺快捷键' }))
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
    fireEvent.click(screen.getByRole('tab', { name: '系统' }))
    expect(await screen.findByRole('status', { name: '快捷键状态警告' })).toBeVisible()
    await user.click(screen.getByRole('tab', { name: '按键' }))
    await user.click(screen.getByRole('textbox', { name: '便笺快捷键' }))
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
    expect(screen.getByRole('button', { name: '移动数据', hidden: true })).toBeDisabled()
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

    fireEvent.click(screen.getByRole('tab', { name: '存储' }))
    await user.click(screen.getByRole('button',{name:'选择数据目录'}))
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
    fireEvent.click(screen.getByRole('tab', { name: '存储' }))
    await user.click(screen.getByRole('button',{name:'选择数据目录'}))
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
    fireEvent.click(screen.getByRole('tab', { name: '存储' }))
    await user.click(screen.getByRole('button',{name:'选择数据目录'}))
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
    fireEvent.click(screen.getByRole('tab', { name: '存储' }))
    await user.click(screen.getByRole('button',{name:'选择数据目录'}))
    await user.click(screen.getByRole('button', { name: '移动数据' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请先解决保存错误')
    expect(moveStorageRoot).not.toHaveBeenCalled()
  })

  it('describes verified migration while preserving unknown files', async () => {
    render(<SettingsView settings={settingsPort()} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async () => () => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: '存储' }))
    await screen.findByText(/Application data/)
    expect(screen.queryByRole('button', { name: '查看旧数据清理说明' })).not.toBeInTheDocument()
    expect(screen.getByText(/重启确认后清理旧笔记/)).toBeVisible()
    expect(screen.getByText(/系统启动配置和未知文件保留/)).toBeVisible()
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
    await screen.findByText('当前位置：E:\\Notes · 6 B')
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

it('toggles only the checkbox and lists the search shortcut', async () => {
 const settings=settingsPort(); const user=userEvent.setup()
 render(<SettingsView settings={settings} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async()=>()=>undefined}/>)
 expect(screen.queryByText('只调整应用界面，不影响笔记正文')).not.toBeInTheDocument()
 expect(screen.getByText('ms')).toBeVisible()
 await user.click(screen.getByRole('tab',{name:'系统'}))
 await user.click(screen.getByText('开机启动'))
 expect(settings.update).not.toHaveBeenCalled()
 await user.click(screen.getByRole('checkbox',{name:'开机启动'}))
 expect(settings.update).toHaveBeenCalledWith({launchAtStartup:true})
 await user.click(screen.getByRole('tab',{name:'按键'}))
 expect(screen.getByRole('textbox',{name:'搜索快捷键'})).toHaveValue('Ctrl+F')
})

it('chooses a storage directory and preserves the previous choice on cancellation',async()=>{
 const chooseStorageDirectory=vi.fn().mockResolvedValueOnce('D:\\Notes').mockResolvedValueOnce(null)
 const user=userEvent.setup()
 render(<SettingsView settings={settingsPort({chooseStorageDirectory})} value={DEFAULT_APP_SETTINGS} onChange={vi.fn()} onClose={vi.fn()} prepareStorageMove={async()=>()=>undefined}/>)
 await user.click(screen.getByRole('tab',{name:'存储'}))
 const field=screen.getByRole('textbox',{name:'迁移目标文件夹'})
 expect(field).toHaveAttribute('readonly')
 await user.click(screen.getByRole('button',{name:'选择数据目录'}))
 expect(field).toHaveValue('D:\\Notes')
 await user.click(screen.getByRole('button',{name:'选择数据目录'}))
 expect(field).toHaveValue('D:\\Notes')
})
