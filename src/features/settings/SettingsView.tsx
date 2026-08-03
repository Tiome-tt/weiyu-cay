import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { AppSettings, SettingsPort, StorageInfo } from '../../domain/ports'
import { normalizeSettings } from './theme'

interface SettingsViewProps {
  settings: SettingsPort
  value: AppSettings
  onChange(value: AppSettings): void
  onClose(): void
  prepareStorageMove(): Promise<(() => void) | null>
  onRestartRequired?(): void
}

export function SettingsView({ settings, value, onChange, onClose, prepareStorageMove, onRestartRequired }: SettingsViewProps) {
  const [draft, setDraft] = useState(value)
  const [storage, setStorage] = useState<StorageInfo | null>(null)
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState<'update' | 'reset' | 'move' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restartRequired, setRestartRequired] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [cleanupExpanded, setCleanupExpanded] = useState(false)
  const requestRef = useRef(0)
  const busyRef = useRef(false)

  useEffect(() => setDraft(value), [value])
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

  const update = async (patch: Partial<AppSettings>, kind: 'shortcut' | 'general' = 'general') => {
    const nextDraft = normalizeSettings({ ...draft, ...patch })
    setDraft(nextDraft)
    setError(null)
    const request = ++requestRef.current
    setBusy('update')
    try {
      const persisted = await settings.update(patch)
      if (requestRef.current !== request) return
      const normalized = normalizeSettings(persisted)
      setDraft(normalized)
      onChange(normalized)
    } catch {
      if (requestRef.current !== request) return
      setDraft(value)
      setError(kind === 'shortcut' ? '快捷键已被占用，原快捷键保持不变。' : '设置未能保存，已保留原设置。')
    } finally {
      if (requestRef.current === request) setBusy(null)
    }
  }

  const updateNumber = (key: 'fontSize' | 'lineHeight' | 'autosaveDelayMs') =>
    (event: ChangeEvent<HTMLInputElement>) => void update({ [key]: Number(event.target.value) })

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
          <p>数据已安全移动。重新启动后，Simple Notes 将从新的位置继续工作。</p>
          {error && <p className="settings-view__error" role="alert">{error}</p>}
          <button type="button" disabled={restarting} onClick={() => void restart()}>立即重启</button>
        </section>
      </div>
    )
  }

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="settings-view" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
        <header><div><span className="library-pane__eyebrow">Simple Notes</span><h1 id="settings-heading">设置</h1></div><button type="button" disabled={busy !== null} onClick={onClose} aria-label="关闭设置">×</button></header>
        {error && <p className="settings-view__error" role="alert">{error}</p>}
        <div className="settings-view__body">
          <fieldset disabled={busy === 'reset' || busy === 'move'}>
            <legend>外观与编辑</legend>
            <label>主题<select aria-label="主题" value={draft.theme} onChange={(event) => void update({ theme: event.target.value as AppSettings['theme'] })}><option value="forest">森林</option><option value="sand">沙丘</option><option value="system">跟随系统</option></select></label>
            <label>正文字体<input aria-label="正文字体" value={draft.bodyFont} onChange={(event) => setDraft({ ...draft, bodyFont: event.target.value })} onBlur={() => void update({ bodyFont: draft.bodyFont })} /></label>
            <label>代码字体<input aria-label="代码字体" value={draft.codeFont} onChange={(event) => setDraft({ ...draft, codeFont: event.target.value })} onBlur={() => void update({ codeFont: draft.codeFont })} /></label>
            <label>字号<input aria-label="字号" type="number" min="12" max="28" value={draft.fontSize} onChange={updateNumber('fontSize')} /></label>
            <label>行高<input aria-label="行高" type="number" min="1.2" max="2.2" step="0.1" value={draft.lineHeight} onChange={updateNumber('lineHeight')} /></label>
            <label>默认编辑视图<select aria-label="默认编辑视图" value={draft.defaultEditorMode} onChange={(event) => void update({ defaultEditorMode: event.target.value as AppSettings['defaultEditorMode'] })}><option value="source">Markdown 源码</option><option value="split">源码与预览</option><option value="preview">预览</option></select></label>
            <label>自动保存延迟<input aria-label="自动保存延迟" type="number" min="150" max="2000" step="50" value={draft.autosaveDelayMs} onChange={updateNumber('autosaveDelayMs')} /><span>毫秒</span></label>
          </fieldset>
          <fieldset disabled={busy !== null}>
            <legend>系统</legend>
            <label className="settings-view__shortcut">全局快捷键<input aria-label="全局快捷键" value={draft.shortcut} onChange={(event) => setDraft({ ...draft, shortcut: event.target.value })} /><button type="button" onClick={() => void update({ shortcut: draft.shortcut }, 'shortcut')}>应用快捷键</button></label>
            <label className="settings-view__check"><input aria-label="开机启动" type="checkbox" checked={draft.launchAtStartup} onChange={(event) => void update({ launchAtStartup: event.target.checked })} />开机启动</label>
          </fieldset>
          <fieldset disabled={busy !== null}>
            <legend>本地存储</legend>
            <p>{storage ? `${storage.root} · ${formatBytes(storage.noteBytes + storage.assetBytes + storage.trashBytes)}` : '正在读取存储信息…'}</p>
            <label className="settings-view__shortcut">新的数据位置<input aria-label="新的数据位置" value={destination} onChange={(event) => setDestination(event.target.value)} /><button type="button" disabled={destination.trim().length === 0 || busy === 'move'} onClick={() => void moveStorage()}>移动数据</button></label>
            {storage?.previousRootCleanupReady === true && storage.previousRoot !== null && (
              <div className="settings-cleanup">
                <button
                  type="button"
                  aria-expanded={cleanupExpanded}
                  aria-controls="settings-cleanup-guidance"
                  onClick={() => setCleanupExpanded((expanded) => !expanded)}
                >
                  {cleanupExpanded ? '收起旧数据清理说明' : '查看旧数据清理说明'}
                </button>
                {cleanupExpanded && (
                  <div id="settings-cleanup-guidance" className="settings-cleanup__guidance">
                    <p><strong>应用不会自动删除旧数据。</strong>请先确认笔记和图片附件在重新打开后都完整可用，再自行处理下面的旧目录。</p>
                    <label>旧数据位置<input aria-label="旧数据位置" readOnly value={storage.previousRoot} onFocus={(event) => event.currentTarget.select()} /></label>
                    <p>手动清理时请保留 <code>settings.json</code> 及其他应用配置；如果无法确认，请继续保留整个旧目录。</p>
                  </div>
                )}
              </div>
            )}
          </fieldset>
        </div>
        <footer><div><button type="button" disabled={busy !== null} onClick={() => void reset()}>恢复默认设置</button><span>笔记数据不会被删除。</span></div><button type="button" disabled={busy !== null} onClick={onClose}>完成</button></footer>
      </section>
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
