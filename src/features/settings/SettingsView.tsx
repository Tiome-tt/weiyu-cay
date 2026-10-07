import { ErrorNotification } from '../../shared/notifications'
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
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
    { id: 'appearance', label: '常规' },
    { id: 'system', label: '系统' },
    { id: 'keys', label: '按键' },
    { id: 'storage', label: '存储' },
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
      if (requestRef.current === request) setError('无法读取存储信息。')
    })
    return () => { requestRef.current += 1 }
  }, [settings])
  const refreshShortcutStatus = useCallback(async () => {
    const request = ++shortcutStatusRequest.current
    try {
      const status = await settings.getShortcutStatus()
      if (shortcutStatusRequest.current !== request) return
      setShortcutWarning(status.startupError !== null || !status.acceptingTriggers ? '便笺快捷键未能启用；本地笔记仍可正常使用。请更换快捷键后重试。' : null)
    } catch {
      if (shortcutStatusRequest.current === request) setShortcutWarning('无法确认便笺快捷键状态；本地笔记仍可正常使用。')
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
      catch { setError('便笺快捷键未恢复，请重新启动微屿。') }
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
    } catch { setError('无法开始录入快捷键，请重试。') }
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
      setError(kind === 'shortcut' ? '快捷键已被占用，原快捷键保持不变。' : '设置未能保存，已保留原设置。')
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
      console.error('[AI] 保存 API Key 失败', error)
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      const diagnostic = typeof error === 'object' && error !== null && 'diagnostic' in error && typeof error.diagnostic === 'string'
        ? error.diagnostic
        : undefined
      setError(code === 'validation'
        ? 'API Key 格式不正确，请确认粘贴的是完整的 DeepSeek API Key。'
        : import.meta.env.DEV && diagnostic !== undefined
          ? 'API Key 保存失败：' + diagnostic
          : 'API Key 未能写入本地加密凭据，请完全退出微屿后重试。')
    } finally {
      setCredentialBusy(false)
    }
  }

  const chooseStorageDirectory = async () => {
    try {
      if (!settings.chooseStorageDirectory) { setError('当前环境无法选择目录。'); return }
      const selected = await settings.chooseStorageDirectory()
      if (selected !== null) setDestination(selected)
    } catch { setError('无法选择目录，请重试。') }
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
      if (requestRef.current === request) setError('无法恢复默认设置。')
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
        setError('请先解决保存错误，再移动数据位置。')
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
      if (requestRef.current === request) setError('移动失败，原数据位置仍然有效。')
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
      setError('无法重新启动应用，请手动退出后重新打开。')
      setRestarting(false)
    }
  }

  if (restartRequired) {
    return (
      <div className="settings-backdrop settings-backdrop--required" role="presentation">
        <section className="settings-restart" role="alertdialog" aria-modal="true" aria-labelledby="restart-heading">
          <span aria-hidden="true" className="content-placeholder__leaf">↻</span>
          <h1 id="restart-heading">需要重新启动</h1>
          <p>数据已安全移动。重新启动后，{APP_NAME} 将从新的位置继续工作。</p>
          <ErrorNotification error={error} />
          <button type="button" disabled={restarting} onClick={() => void restart()}>立即重启</button>
        </section>
      </div>
    )
  }

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="settings-view" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
        <header><div><span className="library-pane__eyebrow">{APP_NAME}</span><h1 id="settings-heading">设置</h1></div><button className="settings-view__close" type="button" disabled={closeDisabled} onClick={onClose} aria-label="关闭设置"><Icon name="close" size={17} /></button></header>
        <ErrorNotification error={error} />
        {shortcutWarning && <p className="settings-view__warning" role="status" aria-label="快捷键状态警告">{shortcutWarning}</p>}
        <div className="settings-view__body">
          <nav className="settings-view__navigation" role="tablist" aria-label="设置分类" aria-orientation="vertical">
            {sections.map((item, index) => <button key={item.id} id={'settings-tab-' + item.id} type="button" role="tab" aria-selected={section === item.id} aria-controls={'settings-section-' + item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => setSection(item.id)} onKeyDown={(event) => {
              const nextIndex = event.key === 'ArrowDown' ? (index + 1) % sections.length : event.key === 'ArrowUp' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null
              if (nextIndex === null) return
              event.preventDefault()
              setSection(sections[nextIndex].id)
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
            }}>{item.label}</button>)}
          </nav>
          <div className="settings-view__content">
          <fieldset className="settings-view__appearance" disabled={operationBusy} id="settings-section-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" hidden={section !== 'appearance'}>
            <legend>常规</legend>
            <label>主题<select aria-label="主题" value={draft.theme} onChange={(event) => void update({ theme: event.target.value as AppSettings['theme'] })}><option value="forest">潮汐浅色</option><option value="sand">沙岸暖色</option><option value="night">夜海深色</option><option value="system">跟随系统</option></select></label>
            <label>正文字体<select aria-label="正文字体" value={draft.bodyFont} onChange={(event) => void update({ bodyFont: event.target.value })}><option value="KaiTi, STKaiti, serif">系统默认（楷体）</option><option value="PingFang SC, PingFang TC, sans-serif">苹方</option><option value="Hiragino Sans GB, Hiragino Sans, sans-serif">冬青黑体</option><option value="Microsoft YaHei, Microsoft YaHei UI, sans-serif">微软雅黑 UI</option><option value="DengXian, sans-serif">等线</option><option value="SimSun, NSimSun, serif">宋体</option><option value="SimHei, sans-serif">黑体</option><option value="FangSong, STFangsong, serif">仿宋</option><option value="Georgia, serif">Georgia</option><option value="serif">Serif</option></select></label>
            <label>代码字体<select aria-label="代码字体" value={draft.codeFont} onChange={(event) => void update({ codeFont: event.target.value })}><option value="ui-monospace, SFMono-Regular, Consolas, monospace">系统等宽</option><option value="Cascadia Code">Cascadia Code</option><option value="Cascadia Mono">Cascadia Mono</option><option value="Segoe UI Mono">Segoe UI Mono</option><option value="SFMono-Regular, Menlo, Monaco, monospace">SF Mono</option><option value="Menlo">Menlo</option><option value="Monaco">Monaco</option><option value="Consolas">Consolas</option><option value="Courier New">Courier New</option></select></label>
            <label>默认编辑视图<select aria-label="默认编辑视图" value={draft.defaultEditorMode} onChange={(event) => void update({ defaultEditorMode: event.target.value as AppSettings['defaultEditorMode'] })}><option value="source">文档编辑</option><option value="split">分栏校对</option><option value="preview">阅读视图</option></select></label>
            <label>界面字号<input aria-label="界面字号" type="number" min="12" max="28" value={draft.fontSize} onChange={updateNumberDraft('fontSize')} onBlur={() => void update({ fontSize: draftRef.current.fontSize })} /></label>
            <label>行高<input aria-label="行高" type="number" min="1.2" max="2.2" step="0.1" value={draft.lineHeight} onChange={updateNumberDraft('lineHeight')} onBlur={() => void update({ lineHeight: draftRef.current.lineHeight })} /></label>
            <label>自动保存延迟<div className="settings-view__number-unit"><input aria-label="自动保存延迟" type="number" min="150" max="2000" step="50" value={draft.autosaveDelayMs} onChange={updateNumberDraft('autosaveDelayMs')} onBlur={() => void update({ autosaveDelayMs: draftRef.current.autosaveDelayMs })} /><span>ms</span></div></label>
            <div className="settings-view__check settings-view__check--described"><input aria-label="每日歌词" type="checkbox" checked={draft.dailyLyrics !== false} onChange={(event) => void update({ dailyLyrics: event.target.checked })} /><span><strong>每日歌词</strong></span></div>
          </fieldset>
          <fieldset className="settings-view__ai-settings" disabled={operationBusy || credentialBusy} id="settings-section-ai" role="tabpanel" aria-labelledby="settings-tab-ai" hidden={section !== 'ai'}>
            <legend>AI</legend>
            <h2 className="settings-view__provider">DeepSeek</h2>
            <div className="settings-view__ai-key-row">
              <span className="settings-view__ai-key-label">DeepSeek API Key</span><div className="settings-view__key-control"><input aria-label="DeepSeek API Key" type="password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} autoComplete="off" placeholder={credentialConfigured ? "已配置，输入新 Key 可替换" : "粘贴 DeepSeek API Key"} />
              <button type="button" disabled={ai === undefined || apiKeyDraft.trim().length === 0} onClick={() => void saveApiKey()}>保存</button></div>
            </div>
            <label className="settings-view__ai-model">总结模型<select aria-label="总结模型" value={draft.deepseekModel ?? "deepseek-flash"} onChange={(event) => void update({ deepseekModel: event.target.value })}><option value="deepseek-flash">DeepSeek V4.1 Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option></select></label>
          </fieldset>
          <fieldset disabled={operationBusy} id="settings-section-system" role="tabpanel" aria-labelledby="settings-tab-system" hidden={section !== 'system'}>
            <legend>系统</legend>

            <div className="settings-view__check"><input aria-label="开机启动" type="checkbox" checked={draft.launchAtStartup} onChange={(event) => void update({ launchAtStartup: event.target.checked })} /><span>开机启动</span></div>
            {platform === 'windows'
              ? <div className="settings-view__close-behavior">
                  <div className="settings-view__check settings-view__check--described">
                    <input aria-label="关闭主窗口时隐藏到托盘" type="checkbox" checked={draft.closeToTray} onChange={(event) => void update({ closeToTray: event.target.checked, closeBehaviorConfirmed: true })} />
                    <span><strong>关闭主窗口时隐藏到托盘</strong><small>托盘菜单仍可打开窗口或安全退出。</small></span>
                  </div>
                  <button
                    className="settings-view__text-action"
                    type="button"
                    disabled={!draft.closeBehaviorConfirmed}
                    onClick={() => void update({ closeBehaviorConfirmed: false })}
                  >
                    {draft.closeBehaviorConfirmed ? '下次关闭时重新询问' : '下次关闭时会询问'}
                  </button>
                </div>
              : <div className="settings-view__check settings-view__check--described">
                  <input aria-label="在菜单栏显示微屿图标" type="checkbox" checked={draft.showMenuBarIcon} onChange={(event) => void update({ showMenuBarIcon: event.target.checked })} />
                  <span><strong>在菜单栏显示微屿图标</strong><small>关闭窗口仍遵循 macOS 的原生行为。</small></span>
                </div>}
          </fieldset>
          <fieldset disabled={operationBusy} id="settings-section-keys" role="tabpanel" aria-labelledby="settings-tab-keys" hidden={section !== 'keys'}>
            <legend>按键</legend>
            <label>搜索<input aria-label="搜索快捷键" readOnly onClick={() => void beginRecording('searchShortcut')} onBlur={() => { recordingCancelledRef.current = true; if (recordingShortcut === 'searchShortcut') void finishRecording() }} onKeyDown={event => { if (!recordingShortcut && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void beginRecording('searchShortcut') } }} value={recordingShortcut === 'searchShortcut' ? '请按下按键…' : (draft.searchShortcut ?? 'CommandOrControl+F').replace(/CommandOrControl/g, platform === 'macos' ? 'Command' : 'Ctrl').replace(/Control/g, 'Ctrl')} /></label>
            <label>便笺<input aria-label="便笺快捷键" readOnly onClick={() => void beginRecording()} onBlur={() => { recordingCancelledRef.current = true; if (recordingShortcut) void finishRecording() }} onKeyDown={event => { if (!recordingShortcut && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void beginRecording() } }} value={recordingShortcut === 'shortcut' ? '请按下按键…' : draft.shortcut.replace(/CommandOrControl/g, platform === 'macos' ? 'Command' : 'Ctrl').replace(/Control/g, 'Ctrl')}  /></label>
          </fieldset>
          {updateController !== undefined && (
            <fieldset disabled={operationBusy} id="settings-section-updates" role="group" aria-label="应用更新" hidden={section !== 'system'}>
              <legend>应用更新</legend>
              <UpdateSettings controller={updateController} />
            </fieldset>
          )}
          <fieldset disabled={operationBusy} id="settings-section-storage" role="tabpanel" aria-labelledby="settings-tab-storage" hidden={section !== 'storage'}>
            <legend>存储</legend>
            <label className="settings-view__image-quality">图片保存质量<select aria-label="图片保存质量" aria-describedby="image-save-quality-description" value={draft.imageSaveQuality} onChange={(event) => void update({ imageSaveQuality: event.target.value as AppSettings['imageSaveQuality'] })}><option value="webp-q95">高清压缩（推荐）</option><option value="webp-q85">省空间压缩</option><option value="original">保留原图</option></select></label>
            <p id="image-save-quality-description">{draft.imageSaveQuality === 'webp-q85' ? '文件更小、细节可能减少；仅处理新插入的静态图片，动图或变大时保留原图。' : draft.imageSaveQuality === 'original' ? '保留原有格式与画质；新插入的 PNG 可能无损瘦身，动图保持原样。' : '高清压缩可能微损画质；仅处理新插入的静态图片，动图或变大时保留原图。'}</p>
            <div className="settings-view__storage-divider" role="separator" aria-label="图片保存与数据位置分隔" />
            <h3 className="settings-view__storage-heading">存储位置与迁移</h3>
            <p>{storage ? `当前位置：${displayStoragePath(storage.root)} · ${formatBytes(storage.noteBytes + storage.assetBytes + storage.trashBytes)}` : '正在读取存储信息…'}</p>
            {storage?.previousStorageCleanup && <p role="status">新位置已启用。旧数据未完成清理，仍为你保留；下次启动会重新检查。</p>}
            <p>选择空文件夹后再移动数据。微屿会检查空间并校验复制结果，重启确认后清理旧笔记；系统启动配置和未知文件保留。</p>
            <label className="settings-view__shortcut settings-view__migration-target">迁移目标文件夹<input aria-label="迁移目标文件夹" readOnly value={destination} placeholder="选择目标文件夹" onClick={() => void chooseStorageDirectory()} /><button type="button" className="settings-view__directory-pick" aria-label="选择数据目录" onClick={() => void chooseStorageDirectory()}><Icon name="folder" size={16} /></button><button type="button" disabled={destination.trim().length === 0 || busy === 'move'} onClick={() => void moveStorage()}>移动数据</button></label>
          </fieldset>
          {exportController !== undefined && (
            <fieldset disabled={busy !== null} id="settings-section-export" role="group" aria-label="便携式导出" hidden={section !== 'storage'}>
              <legend>便携式导出</legend>
              <ExportLibrary controller={exportController} />
            </fieldset>
          )}
          </div>
        </div>
        <footer><div><button type="button" disabled={operationBusy} onClick={() => void reset()}>恢复默认设置</button><span>笔记数据不会被删除。</span></div><button className="settings-view__done" type="button" disabled={closeDisabled} onClick={onClose}>完成</button></footer>
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
