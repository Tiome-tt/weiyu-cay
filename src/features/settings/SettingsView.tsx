import {text} from '../../shared/i18n'
import { ErrorNotification } from '../../shared/notifications'
import { BODY_FONT_OPTIONS, CODE_FONT_OPTIONS } from './fontOptions'
import { useCallback, useEffect, useRef, useState, type ComponentProps, useLayoutEffect, type ChangeEvent } from 'react'
import type { AiPort, AppSettings, SettingsPort, StorageInfo, WindowChromePort } from '../../domain/ports'
import { ExportLibrary, type ExportLibraryController } from './ExportLibrary'
import { normalizeSettings } from './theme'
import { APP_NAME } from '../../shared/brand'
import { Icon } from '../../shared/Icon'
import { UpdateSettings, type UpdateController } from './UpdateSettings'

interface SettingsViewProps {
  settings: SettingsPort
  value: AppSettings
  onChange(value: AppSettings): void
  onClose(): void
  prepareStorageMove(): Promise<(() => void) | null>
  onRestartRequired?(): void
  exportController?: ExportLibraryController
  updateController?: UpdateController
  platform?: WindowChromePort['platform']
  ai?: AiPort
}

export function SettingsView({ settings, value, onChange, onClose, prepareStorageMove, onRestartRequired, exportController, updateController, platform = 'windows', ai }: SettingsViewProps) {
  const [section, setSection] = useState('appearance')
  const sections = [
    { id: 'appearance', label: text("常规","General") },
    { id: 'system', label: text("系统","System") },
    { id: 'keys', label: text("按键","Shortcuts") },
    { id: 'storage', label: text("存储","Storage") },
    { id: 'ai', label: 'AI' },
  ]
  const [draft, setDraft] = useState(value)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState<'update' | 'reset' | 'move' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restartRequired, setRestartRequired] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [shortcutWarning, setShortcutWarning] = useState<string | null>(null)
  const [recordingShortcut, setRecordingShortcut] = useState<'shortcut' | 'searchShortcut' | null>(null)
  const mountedRef = useRef(true)
  const recordingHeldRef = useRef(false)
  const recordingCancelledRef = useRef(false)
  const recordingStartingRef = useRef(false)
  const recordedShortcutKeysRef = useRef(new Set<string>())
  const pressedShortcutKeysRef = useRef(new Set<string>())
  const recordedNonModifierRef = useRef(false)
  const requestRef = useRef(0)
  const busyRef = useRef(false)
  const draftRef = useRef(value)
  const shortcutStatusRequest = useRef(0)
  const restartBarrierReleaseRef = useRef<(() => void) | null>(null)
  const operationBusy = busy !== null || exportController?.busy === true
  const closeDisabled = busy === 'move' || busy === 'reset' || exportController?.busy === true
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [credentialConfigured, setCredentialConfigured] = useState(false)
  const [credentialBusy, setCredentialBusy] = useState(false)

  useEffect(() => {
    let active = true
    if (ai === undefined) return () => { active = false }
    void ai.getCredentialStatus().then((status) => {
      if (active) setCredentialConfigured(status.configured)
    }).catch(() => {
      if (active) setCredentialConfigured(false)
    })
    return () => { active = false }
  }, [ai])

  useEffect(() => {
    if (busyRef.current) return
    draftRef.current = value
    setDraft(value)
  }, [value])
  useEffect(() => {
    const request = ++requestRef.current
    void settings.getStorageInfo().then((info) => {
      if (requestRef.current === request) {
        setStorage(info)
      }
    }).catch(() => {
      if (requestRef.current === request) setError(text("无法读取存储信息。","Could not read storage information."))
    })
    return () => { requestRef.current += 1 }
  }, [settings])
  const refreshShortcutStatus = useCallback(async () => {
    const request = ++shortcutStatusRequest.current
    try {
      const status = await settings.getShortcutStatus()
      if (shortcutStatusRequest.current !== request) return
      setShortcutWarning(status.startupError !== null || !status.acceptingTriggers ? text("便笺快捷键未能启用；本地笔记仍可正常使用。请更换快捷键后重试。","The sticky-note shortcut could not be enabled. Local notes remain available. Choose another shortcut and try again.") : null)
    } catch {
      if (shortcutStatusRequest.current === request) setShortcutWarning(text("无法确认便笺快捷键状态；本地笔记仍可正常使用。","Could not check the sticky-note shortcut. Local notes remain available."))
    }
  }, [settings])
  useEffect(() => {
    void refreshShortcutStatus()
    return () => { shortcutStatusRequest.current += 1 }
  }, [refreshShortcutStatus])

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; if (recordingHeldRef.current) void settings.setShortcutRecording(false).catch(() => undefined) } }, [settings])
  const finishRecording = async (shortcut?: string) => {
    setRecordingShortcut(null)
    try { if (shortcut !== undefined) await update({ [recordingShortcut ?? 'shortcut']: shortcut }, recordingShortcut === 'shortcut' ? 'shortcut' : 'general') }
    finally {
      try { await settings.setShortcutRecording(false); recordingHeldRef.current = false }
      catch { setError(text("便笺快捷键未恢复，请重新启动微屿。","The sticky-note shortcut was not restored. Please restart Cay.")) }
    }
  }
  useEffect(() => { if (section !== 'keys' && recordingShortcut) void finishRecording() }, [section, recordingShortcut])
  const beginRecording = async (target: 'shortcut' | 'searchShortcut' = 'shortcut') => {
    if (recordingStartingRef.current || recordingHeldRef.current) return
    recordingStartingRef.current = true
    recordingCancelledRef.current = false
    try {
      await settings.setShortcutRecording(true)
      if (!mountedRef.current || recordingCancelledRef.current) { await settings.setShortcutRecording(false); return }
      recordingHeldRef.current = true
      recordedShortcutKeysRef.current.clear(); pressedShortcutKeysRef.current.clear(); recordedNonModifierRef.current = false
      setRecordingShortcut(target)
    } catch { setError(text("无法开始录入快捷键，请重试。","Could not start shortcut recording. Try again.")) }
    finally { recordingStartingRef.current = false }
  }
  useEffect(() => {
    if (!recordingShortcut) return
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') { void finishRecording(); return }
      const key = keyName(event.key)
      recordedShortcutKeysRef.current.add(key)
      pressedShortcutKeysRef.current.add(key)
      if (!isShortcutModifier(key)) recordedNonModifierRef.current = true
    }
    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      event.preventDefault()
      pressedShortcutKeysRef.current.delete(keyName(event.key))
      if (pressedShortcutKeysRef.current.size !== 0 || !recordedNonModifierRef.current) return
      const shortcut = formatRecordedShortcut(recordedShortcutKeysRef.current)
      recordedShortcutKeysRef.current.clear()
      pressedShortcutKeysRef.current.clear()
      recordedNonModifierRef.current = false
      void finishRecording(shortcut)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [recordingShortcut])

  const update = async (patch: Partial<AppSettings>, kind: 'shortcut' | 'general' = 'general') => {
    if (busyRef.current) return
    busyRef.current = true
    const nextDraft = normalizeSettings({ ...draftRef.current, ...patch })
    draftRef.current = nextDraft
    setDraft(nextDraft)
    setError(null)
    const request = ++requestRef.current
    setBusy('update')
    try {
      const persisted = await settings.update(patch)
      if (requestRef.current !== request) return
      const normalized = normalizeSettings(persisted)
      draftRef.current = normalized
      setDraft(normalized)
      onChange(normalized)
      if (kind === 'shortcut') await refreshShortcutStatus()
    } catch {
      if (requestRef.current !== request) return
      setDraft(value)
      draftRef.current = value
      setError(kind === 'shortcut' ? text("快捷键已被占用，原快捷键保持不变。","This shortcut is in use. Your previous shortcut was kept.") : text("设置未能保存，已保留原设置。","Settings could not be saved. Your previous settings were kept."))
    } finally {
      busyRef.current = false
      if (requestRef.current === request) setBusy(null)
    }
  }

  const saveApiKey = async () => {
    if (ai === undefined || apiKeyDraft.trim().length === 0 || credentialBusy) return
    setCredentialBusy(true)
    setError(null)
    try {
      const status = await ai.saveDeepSeekApiKey(apiKeyDraft)
      setCredentialConfigured(status.configured)
      setApiKeyDraft('')
    } catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      setError(code === 'validation'
        ? text("API Key 格式不正确，请确认粘贴的是完整的 DeepSeek API Key。","Invalid API key format. Paste the complete DeepSeek API key.")
        : text("无法保存 API Key，请完全退出微屿后重试。","Could not save the API key. Quit Cay completely and try again."))
    } finally {
      setCredentialBusy(false)
    }
  }

  const chooseStorageDirectory = async () => {
    try {
      if (!settings.chooseStorageDirectory) { setError(text("当前环境无法选择目录。","Folder selection is unavailable in this environment.")); return }
      const selected = await settings.chooseStorageDirectory()
      if (selected !== null) setDestination(selected)
    } catch { setError(text("无法选择目录，请重试。","Could not select a folder. Try again.")) }
  }
  const editDraft = (patch: Partial<AppSettings>) => {
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraft(next)
  }

  const updateNumberDraft = (key: 'fontSize' | 'lineHeight' | 'autosaveDelayMs') =>
    (event: ChangeEvent<HTMLInputElement>) => editDraft({ [key]: Number(event.target.value) })

  const reset = async () => {
    if (busyRef.current) return
    busyRef.current = true
    const request = ++requestRef.current
    setBusy('reset')
    setError(null)
    try {
      const restored = normalizeSettings(await settings.reset())
      if (requestRef.current !== request) return
      setDraft(restored)
      draftRef.current = restored
      onChange(restored)
    } catch {
      if (requestRef.current === request) setError(text("无法恢复默认设置。","Could not restore default settings."))
    } finally {
      busyRef.current = false
      if (requestRef.current === request) setBusy(null)
    }
  }

  const moveStorage = async () => {
    const target = destination.trim()
    if (busyRef.current || target.length === 0) return
    busyRef.current = true
    const request = ++requestRef.current
    setBusy('move')
    setError(null)
    let release: (() => void) | null = null
    try {
      release = await prepareStorageMove()
      if (release === null) {
        setError(text("请先解决保存错误，再移动数据位置。","Resolve the save error before moving your library."))
        return
      }
      await settings.moveStorageRoot(target)
      if (requestRef.current !== request) return
      setRestartRequired(true)
      onRestartRequired?.()
      restartBarrierReleaseRef.current = release
      release = null
    } catch {
      release?.()
      if (requestRef.current === request) setError(text("移动失败，原数据位置仍然有效。","The move failed. Your original library location is still active."))
    } finally {
      busyRef.current = false
      if (requestRef.current === request) setBusy(null)
    }
  }

  const restart = async () => {
    if (restarting) return
    setRestarting(true)
    setError(null)
    try {
      await settings.restartApplication()
    } catch {
      restartBarrierReleaseRef.current?.()
      restartBarrierReleaseRef.current = null
      setError(text("无法重新启动应用，请手动退出后重新打开。","Could not restart the app. Quit and reopen it manually."))
      setRestarting(false)
    }
  }

  if (restartRequired) {
    return (
      <div className="settings-backdrop settings-backdrop--required" role="presentation">
        <section className="settings-restart" role="alertdialog" aria-modal="true" aria-labelledby="restart-heading">
          <span aria-hidden="true" className="content-placeholder__leaf">↻</span>
          <h1 id="restart-heading">{text("需要重新启动","Restart required")}</h1>
          <p>{text("数据已安全移动。重新启动后，","Your data has been moved safely. After restarting, ")}{APP_NAME}{text("将从新的位置继续工作。"," will use the new location.")}</p>
          <ErrorNotification error={error} />
          <button type="button" disabled={restarting} onClick={() => void restart()}>{text("立即重启","Restart now")}</button>
        </section>
      </div>
    )
  }

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="settings-view" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
        <header><div><span className="library-pane__eyebrow">{APP_NAME}</span><h1 id="settings-heading">{text("设置","Settings")}</h1></div><button className="settings-view__close" type="button" disabled={closeDisabled} onClick={onClose} aria-label={text("关闭设置","Close settings")}><Icon name="close" size={17} /></button></header>
        <ErrorNotification error={error} />
        {shortcutWarning && <p className="settings-view__warning" role="status" aria-label={text("快捷键状态警告","Shortcut status warning")}>{shortcutWarning}</p>}
        <div className="settings-view__body">
          <nav className="settings-view__navigation" role="tablist" aria-label={text("设置分类","Settings categories")} aria-orientation="vertical">
            {sections.map((item, index) => <button key={item.id} id={'settings-tab-' + item.id} type="button" role="tab" aria-selected={section === item.id} aria-controls={'settings-section-' + item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => setSection(item.id)} onKeyDown={(event) => {
              const nextIndex = event.key === 'ArrowDown' ? (index + 1) % sections.length : event.key === 'ArrowUp' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null
              if (nextIndex === null) return
              event.preventDefault()
              setSection(sections[nextIndex].id)
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
            }}><Icon name={item.id === 'appearance' ? 'settings' : item.id === 'system' ? 'monitor' : item.id === 'keys' ? 'keyboard' : item.id === 'storage' ? 'folder' : 'ai-fusion'} size={18} /><span>{item.label}</span></button>)}
          </nav>
          <div className="settings-view__content">
          <fieldset className="settings-view__appearance" disabled={operationBusy} id="settings-section-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" hidden={section !== 'appearance'}>
            <legend>{text("常规","General")}</legend>
            <label><span>{text("主题","Theme")}<small id="theme-description">{text("跟随系统使用 Windows 或 macOS 的浅色、深色外观。","Follow the light or dark appearance of Windows or macOS.")}</small></span><AdaptiveSelect aria-describedby="theme-description" aria-label={text("主题","Theme")} value={draft.theme} onChange={(event) => void update({ theme: event.target.value as AppSettings['theme'] })}><option value="forest">{text("潮汐绿","Tidal Green")}</option><option value="sand">{text("沙岸黄","Sandy Yellow")}</option><option value="ocean">{text("晴湾蓝","Clear Bay Blue")}</option><option value="night">{text("夜礁黑","Night Reef")}</option><option value="light">{text("云屿白","Cloud White")}</option><option value="system">{text("跟随系统","System")}</option></AdaptiveSelect></label>
            <label>{text("正文字体","Body font")}<AdaptiveSelect aria-label={text("正文字体","Body font")} value={draft.bodyFont} onChange={(event) => void update({ bodyFont: event.target.value })}>{BODY_FONT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</AdaptiveSelect></label>
            <label><span>{text("代码字体","Code font")}<small>{text("使用本机字体，未安装时自动回退。","Uses local fonts, with automatic fallback when unavailable.")}</small></span><AdaptiveSelect aria-label={text("代码字体","Code font")} title={text("使用本机字体；未安装时使用系统回退字体","Uses local fonts with system fallback")} value={draft.codeFont} onChange={(event) => void update({ codeFont: event.target.value })}>{CODE_FONT_OPTIONS.filter(option => option.value !== 'Segoe UI Mono' || draft.codeFont === option.value).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</AdaptiveSelect></label>
            <label>{text("默认编辑视图","Default editor view")}<AdaptiveSelect aria-label={text("默认编辑视图","Default editor view")} value={draft.defaultEditorMode} onChange={(event) => void update({ defaultEditorMode: event.target.value as AppSettings['defaultEditorMode'] })}><option value="source">{text("文档编辑","Edit")}</option><option value="split">{text("分栏校对","Split view")}</option><option value="preview">{text("阅读视图","Read")}</option></AdaptiveSelect></label>
            <label>{text("界面字号","Interface font size")}<div className="settings-view__number-unit"><input aria-label={text("界面字号","Interface font size")} type="number" min="12" max="28" value={draft.fontSize} onChange={updateNumberDraft('fontSize')} onBlur={() => void update({ fontSize: draftRef.current.fontSize })} /><span>px</span></div></label>
            <label>{text("行高","Line height")}<input aria-label={text("行高","Line height")} type="number" min="1.2" max="2.2" step="0.1" value={draft.lineHeight} onChange={updateNumberDraft('lineHeight')} onBlur={() => void update({ lineHeight: draftRef.current.lineHeight })} /></label>
            <label><span>{text("自动保存延迟","Autosave delay")}<small>{text("停止输入后等待多久保存。","How long to wait after typing before saving.")}</small></span><div className="settings-view__number-unit"><input aria-label={text("自动保存延迟","Autosave delay")} type="number" min="150" max="2000" step="50" value={draft.autosaveDelayMs} onChange={updateNumberDraft('autosaveDelayMs')} onBlur={() => void update({ autosaveDelayMs: draftRef.current.autosaveDelayMs })} /><span>ms</span></div></label>
            <div className="settings-view__check settings-view__check--described"><input aria-label={text("每日歌词","Daily verse")} type="checkbox" role="switch" checked={draft.dailyLyrics !== false} onChange={(event) => void update({ dailyLyrics: event.target.checked })} /><span><strong>{text("每日歌词","Daily verse")}</strong></span></div>
          </fieldset>
          <fieldset className="settings-view__ai-settings" disabled={operationBusy || credentialBusy} id="settings-section-ai" role="tabpanel" aria-labelledby="settings-tab-ai" hidden={section !== 'ai'}>
            <legend>AI</legend>
            <h2 className="settings-view__provider">DeepSeek</h2>
            <div className="settings-view__ai-key-row">
              <span className="settings-view__ai-key-label">DeepSeek API Key</span><div className="settings-view__key-control"><input aria-label="DeepSeek API Key" type="password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} autoComplete="off" placeholder={credentialConfigured ? text("已配置，输入新 Key 可替换","Configured; enter a new key to replace it") : text("粘贴 DeepSeek API Key","Paste your DeepSeek API key")} />
              <button type="button" disabled={ai === undefined || apiKeyDraft.trim().length === 0} onClick={() => void saveApiKey()}>{text("保存","Save")}</button></div>
            </div>
            <label className="settings-view__ai-model">{text("总结模型","Summary model")}<AdaptiveSelect aria-label={text("总结模型","Summary model")} value={draft.deepseekModel ?? "deepseek-flash"} onChange={(event) => void update({ deepseekModel: event.target.value })}><option value="deepseek-flash">DeepSeek V4.1 Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option></AdaptiveSelect></label>
          </fieldset>
          <fieldset disabled={operationBusy} id="settings-section-system" role="tabpanel" aria-labelledby="settings-tab-system" hidden={section !== 'system'}>
            <legend>{text("系统","System")}</legend>

            <div className="settings-view__check"><input aria-label={text("开机启动","Launch at startup")} type="checkbox" role="switch" checked={draft.launchAtStartup} onChange={(event) => void update({ launchAtStartup: event.target.checked })} /><span>{text("开机启动","Launch at startup")}</span></div>
            {platform === 'windows'
              ? <div className="settings-view__close-behavior">
                  <div className="settings-view__check settings-view__check--described">
                    <input aria-label={text("关闭主窗口时隐藏到托盘","Hide to tray when closing the main window")} type="checkbox" role="switch" checked={draft.closeToTray} onChange={(event) => void update({ closeToTray: event.target.checked, closeBehaviorConfirmed: true })} />
                    <span><strong>{text("关闭主窗口时隐藏到托盘","Hide to tray when closing the main window")}</strong><small>{text("托盘菜单仍可打开窗口或安全退出。","Use the tray menu to reopen the window or quit safely.")}</small></span>
                  </div>
                  <button
                    className="settings-view__text-action"
                    type="button"
                    disabled={!draft.closeBehaviorConfirmed}
                    onClick={() => void update({ closeBehaviorConfirmed: false })}
                  >
                    {draft.closeBehaviorConfirmed ? text("下次关闭时重新询问","Ask again on next close") : text("下次关闭时会询问","You will be asked on next close")}
                  </button>
                </div>
              : <div className="settings-view__check settings-view__check--described">
                  <input aria-label={text("在菜单栏显示微屿图标","Show Cay in the menu bar")} type="checkbox" role="switch" checked={draft.showMenuBarIcon} onChange={(event) => void update({ showMenuBarIcon: event.target.checked })} />
                  <span><strong>{text("在菜单栏显示微屿图标","Show Cay in the menu bar")}</strong><small>{text("关闭窗口仍遵循 macOS 的原生行为。","Closing windows follows native macOS behavior.")}</small></span>
                </div>}
          </fieldset>
          <fieldset disabled={operationBusy} id="settings-section-keys" role="tabpanel" aria-labelledby="settings-tab-keys" hidden={section !== 'keys'}>
            <legend>{text("按键","Shortcuts")}</legend>
            <label>{text("搜索","Search")}<input aria-label={text("搜索快捷键","Search shortcut")} readOnly onClick={() => void beginRecording('searchShortcut')} onBlur={() => { recordingCancelledRef.current = true; if (recordingShortcut === 'searchShortcut') void finishRecording() }} onKeyDown={event => { if (!recordingShortcut && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void beginRecording('searchShortcut') } }} value={recordingShortcut === 'searchShortcut' ? text("请按下按键…","Press your shortcut…") : (draft.searchShortcut ?? 'CommandOrControl+F').replace(/CommandOrControl/g, platform === 'macos' ? 'Command' : 'Ctrl').replace(/Control/g, 'Ctrl')} /></label>
            <label>{text("便笺","Sticky note")}<input aria-label={text("便笺快捷键","Sticky-note shortcut")} readOnly onClick={() => void beginRecording()} onBlur={() => { recordingCancelledRef.current = true; if (recordingShortcut) void finishRecording() }} onKeyDown={event => { if (!recordingShortcut && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void beginRecording() } }} value={recordingShortcut === 'shortcut' ? text("请按下按键…","Press your shortcut…") : draft.shortcut.replace(/CommandOrControl/g, platform === 'macos' ? 'Command' : 'Ctrl').replace(/Control/g, 'Ctrl')}  /></label>
          </fieldset>
          {updateController !== undefined && (
            <fieldset disabled={operationBusy} id="settings-section-updates" role="group" aria-label={text("应用更新","App updates")} hidden={section !== 'system'}>
              <legend>{text("应用更新","App updates")}</legend>
              <UpdateSettings controller={updateController} />
            </fieldset>
          )}
          <fieldset disabled={operationBusy} id="settings-section-storage" role="tabpanel" aria-labelledby="settings-tab-storage" hidden={section !== 'storage'}>
            <legend>{text("存储","Storage")}</legend>
            <label className="settings-view__image-quality">{text("图片保存质量","Image quality")}<AdaptiveSelect aria-label={text("图片保存质量","Image quality")} aria-describedby="image-save-quality-description" value={draft.imageSaveQuality} onChange={(event) => void update({ imageSaveQuality: event.target.value as AppSettings['imageSaveQuality'] })}><option value="webp-q95">{text("高清压缩（推荐）","High quality (recommended)")}</option><option value="webp-q85">{text("省空间压缩","Smaller files")}</option><option value="original">{text("保留原图","Keep originals")}</option></AdaptiveSelect></label>
            <p id="image-save-quality-description">{draft.imageSaveQuality === 'webp-q85' ? text("文件更小、细节可能减少；仅处理新插入的静态图片，动图或变大时保留原图。","Smaller files may lose detail. Applies to newly inserted still images; animations and larger results keep the original.") : draft.imageSaveQuality === 'original' ? text("保留原有格式与画质；新插入的 PNG 可能无损瘦身，动图保持原样。","Preserves format and quality. New PNG images may be optimized losslessly; animations stay unchanged.") : text("高清压缩可能微损画质；仅处理新插入的静态图片，动图或变大时保留原图。","High-quality compression may lose a little detail. Applies only to new still images; animations and larger results keep the original.")}</p>
            <div className="settings-view__storage-divider" role="separator" aria-label={text("图片保存与数据位置分隔","Image quality and storage location divider")} />
            <h3 className="settings-view__storage-heading">{text("存储位置与迁移","Library location and migration")}</h3>
            <p>{storage ? `当前位置：${displayStoragePath(storage.root)} · ${formatBytes(storage.noteBytes + storage.assetBytes + storage.trashBytes)}` : text("正在读取存储信息…","Reading storage information…")}</p>
            {storage?.previousStorageCleanup && <p role="status">{text("新位置已启用。旧数据未完成清理，仍为你保留；下次启动会重新检查。","The new location is active. Old data remains because cleanup is incomplete; it will be checked on next launch.")}</p>}
            {storage?.defaultMigrationPending && <p role="status">{text("默认资料库迁移尚未完成，当前继续使用原位置。请确认 app.cay 目标目录为空且可写，或通过下方控件选择新的位置；下次启动会重试。","Default library migration is incomplete. The original location remains active. Ensure the app.cay destination is empty and writable, or choose a new location below. Cay will retry on next launch.")}</p>}
            <p>{text("选择空文件夹后再移动数据。微屿会检查空间并校验复制结果，重启确认后清理旧笔记；系统启动配置和未知文件保留。","Choose an empty folder. Cay checks space and verifies copied data before restarting, then cleans up old notes after verification. Startup configuration and unknown files are preserved.")}</p>
            <label className="settings-view__shortcut settings-view__migration-target">{text("迁移目标文件夹","Destination folder")}<input aria-label={text("迁移目标文件夹","Destination folder")} readOnly value={destination} placeholder={text("选择目标文件夹","Choose destination folder")} onClick={() => void chooseStorageDirectory()} /><button type="button" className="settings-view__directory-pick" aria-label={text("选择数据目录","Choose library folder")} onClick={() => void chooseStorageDirectory()}><Icon name="folder" size={16} /></button><button type="button" disabled={destination.trim().length === 0 || busy === 'move'} onClick={() => void moveStorage()}>{text("移动数据","Move library")}</button></label>
          </fieldset>
          {exportController !== undefined && (
            <fieldset disabled={busy !== null} id="settings-section-export" role="group" aria-label={text("便携式导出","Portable export")} hidden={section !== 'storage'}>
              <legend>{text("便携式导出","Portable export")}</legend>
              <ExportLibrary controller={exportController} />
            </fieldset>
          )}
          </div>
        </div>
        <footer><div><button type="button" disabled={operationBusy} onClick={() => void reset()}>{text("恢复默认设置","Restore defaults")}</button><span>{text("笔记数据不会被删除。","Your notes will be kept.")}</span></div><button className="settings-view__done" type="button" disabled={closeDisabled} onClick={onClose}>{text("完成","Done")}</button></footer>
      </section>
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function displayStoragePath(path: string) {
  return path.replace(/^\\\\\?\\/u, '')
}


function keyName(key: string) {
  if (key === 'Control' || key === 'Ctrl') return 'Control'
  if (key === 'Meta' || key === 'Command') return 'Command'
  if (key === 'Alt' || key === 'Option') return 'Alt'
  if (key === 'Shift') return 'Shift'
  if (key === ' ') return 'Space'
  if (key.length === 1) return key.toUpperCase()
  return key
}

function isShortcutModifier(key: string) {
  return ['Command', 'Control', 'Alt', 'Shift', 'Super'].includes(key)
}

function formatRecordedShortcut(keys: Set<string>) {
  const order = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift', 'Super']
  const modifiers = order.filter((modifier) => keys.has(modifier))
  const normalKeys = [...keys].filter((key) => !isShortcutModifier(key))
  return [...modifiers, ...normalKeys].join('+')
}

/** The hidden text uses the same font as the control, so CJK and font changes size correctly. */
function AdaptiveSelect({children,value,...props}:ComponentProps<'select'>) {
 const ref=useRef<HTMLSelectElement>(null)
 const [label,setLabel]=useState('')
 useLayoutEffect(()=> {setLabel(ref.current?.selectedOptions[0]?.textContent ?? '')},[value,children])
 return <span className="settings-view__select"><span aria-hidden="true">{label}</span><select ref={ref} value={value} {...props}>{children}</select></span>
}
