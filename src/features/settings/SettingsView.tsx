import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { AppSettings, SettingsPort, StorageInfo } from '../../domain/ports'
import { ExportLibrary, type ExportLibraryController } from './ExportLibrary'
import { normalizeSettings } from './theme'
import { APP_NAME } from '../../shared/brand'
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
}

export function SettingsView({ settings, value, onChange, onClose, prepareStorageMove, onRestartRequired, exportController, updateController }: SettingsViewProps) {
  const [draft, setDraft] = useState(value)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState<'update' | 'reset' | 'move' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restartRequired, setRestartRequired] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [cleanupExpanded, setCleanupExpanded] = useState(false)
  const [shortcutWarning, setShortcutWarning] = useState<string | null>(null)
  const requestRef = useRef(0)
  const busyRef = useRef(false)
  const draftRef = useRef(value)
  const shortcutStatusRequest = useRef(0)
  const restartBarrierReleaseRef = useRef<(() => void) | null>(null)
  const operationBusy = busy !== null || exportController?.busy === true

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
        setCleanupExpanded(false)
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
      setShortcutWarning(status.startupError !== null || !status.acceptingTriggers ? '全局快捷键未能启用；本地笔记仍可正常使用。请更换快捷键后重试。' : null)
    } catch {
      if (shortcutStatusRequest.current === request) setShortcutWarning('无法确认全局快捷键状态；本地笔记仍可正常使用。')
    }
  }, [settings])
  useEffect(() => {
    void refreshShortcutStatus()
    return () => { shortcutStatusRequest.current += 1 }
  }, [refreshShortcutStatus])

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
          {error && <p className="settings-view__error" role="alert">{error}</p>}
          <button type="button" disabled={restarting} onClick={() => void restart()}>立即重启</button>
        </section>
      </div>
    )
  }

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="settings-view" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
        <header><div><span className="library-pane__eyebrow">{APP_NAME}</span><h1 id="settings-heading">设置</h1></div><button type="button" disabled={operationBusy} onClick={onClose} aria-label="关闭设置">×</button></header>
        {error && <p className="settings-view__error" role="alert">{error}</p>}
        {shortcutWarning && <p className="settings-view__warning" role="status" aria-label="快捷键状态警告">{shortcutWarning}</p>}
        <div className="settings-view__body">
          <fieldset disabled={operationBusy}>
            <legend>外观与编辑</legend>
            <label>主题<select aria-label="主题" value={draft.theme} onChange={(event) => void update({ theme: event.target.value as AppSettings['theme'] })}><option value="forest">潮汐浅色</option><option value="sand">沙岸暖色</option><option value="night">夜海深色</option><option value="system">跟随系统</option></select></label>
            <label>正文字体<input aria-label="正文字体" value={draft.bodyFont} onChange={(event) => editDraft({ bodyFont: event.target.value })} onBlur={() => void update({ bodyFont: draftRef.current.bodyFont })} /></label>
            <label>代码字体<input aria-label="代码字体" value={draft.codeFont} onChange={(event) => editDraft({ codeFont: event.target.value })} onBlur={() => void update({ codeFont: draftRef.current.codeFont })} /></label>
            <label>字号<input aria-label="字号" type="number" min="12" max="28" value={draft.fontSize} onChange={updateNumberDraft('fontSize')} onBlur={() => void update({ fontSize: draftRef.current.fontSize })} /></label>
            <label>行高<input aria-label="行高" type="number" min="1.2" max="2.2" step="0.1" value={draft.lineHeight} onChange={updateNumberDraft('lineHeight')} onBlur={() => void update({ lineHeight: draftRef.current.lineHeight })} /></label>
            <label>默认编辑视图<select aria-label="默认编辑视图" value={draft.defaultEditorMode} onChange={(event) => void update({ defaultEditorMode: event.target.value as AppSettings['defaultEditorMode'] })}><option value="source">Markdown 源码</option><option value="split">源码与预览</option><option value="preview">预览</option></select></label>
            <label>自动保存延迟<input aria-label="自动保存延迟" type="number" min="150" max="2000" step="50" value={draft.autosaveDelayMs} onChange={updateNumberDraft('autosaveDelayMs')} onBlur={() => void update({ autosaveDelayMs: draftRef.current.autosaveDelayMs })} /><span>毫秒</span></label>
          </fieldset>
          <fieldset disabled={operationBusy}>
            <legend>系统</legend>
            <label className="settings-view__shortcut">全局快捷键<input aria-label="全局快捷键" value={draft.shortcut} onChange={(event) => editDraft({ shortcut: event.target.value })} /><button type="button" onClick={() => void update({ shortcut: draftRef.current.shortcut }, 'shortcut')}>应用快捷键</button></label>
            <label className="settings-view__check"><input aria-label="开机启动" type="checkbox" checked={draft.launchAtStartup} onChange={(event) => void update({ launchAtStartup: event.target.checked })} />开机启动</label>
          </fieldset>
          {updateController !== undefined && (
            <fieldset disabled={operationBusy}>
              <legend>应用更新</legend>
              <UpdateSettings controller={updateController} />
            </fieldset>
          )}
          <fieldset disabled={operationBusy}>
            <legend>本地存储</legend>
            <p>{storage ? `${storage.root} · ${formatBytes(storage.noteBytes + storage.assetBytes + storage.trashBytes)}` : '正在读取存储信息…'}</p>
            <p>应用不会自动删除旧位置中的数据。请保留应用配置和未知文件，直到你确认新位置中的笔记与附件完整可用。</p>
            <label className="settings-view__shortcut">新的数据位置<input aria-label="新的数据位置" value={destination} onChange={(event) => setDestination(event.target.value)} /><button type="button" disabled={destination.trim().length === 0 || busy === 'move'} onClick={() => void moveStorage()}>移动数据</button></label>
            {storage?.previousStorageCleanup !== undefined && (
              <div className="settings-cleanup">
                <button type="button" aria-expanded={cleanupExpanded} aria-controls="settings-cleanup-candidates" onClick={() => setCleanupExpanded((value) => !value)}>
                  {cleanupExpanded ? '收起旧位置候选项' : '查看旧位置候选项'}
                </button>
                {cleanupExpanded && <div id="settings-cleanup-candidates" className="settings-cleanup__guidance">
                  <p><strong>{APP_NAME} 不提供自动删除。</strong>请先核验新位置的笔记与附件。绝不要删除旧位置根目录、<code>settings.json</code>、应用配置或任何未知文件。</p>
                  <label>旧位置（仅供核对）<input aria-label="旧位置（仅供核对）" readOnly value={storage.previousStorageCleanup.root} onFocus={(event) => event.currentTarget.select()} /></label>
                  <ul aria-label="可手动核对的旧数据候选项">
                    {storage.previousStorageCleanup.candidates.map((candidate) => <li key={`${candidate.kind}:${candidate.relativePath}`}><code>{candidate.relativePath}</code> <span>{candidate.kind}</span></li>)}
                  </ul>
                </div>}
              </div>
            )}
          </fieldset>
          {exportController !== undefined && (
            <fieldset disabled={busy !== null}>
              <legend>Portable export</legend>
              <ExportLibrary controller={exportController} />
            </fieldset>
          )}
        </div>
        <footer><div><button type="button" disabled={operationBusy} onClick={() => void reset()}>恢复默认设置</button><span>笔记数据不会被删除。</span></div><button type="button" disabled={operationBusy} onClick={onClose}>完成</button></footer>
      </section>
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
