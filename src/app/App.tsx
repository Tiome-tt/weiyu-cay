import '../styles/tokens.css'
import '../styles/app.css'
import { LibraryLayout, type LibraryLayoutHandle } from '../features/library/LibraryLayout'
import { createAppServices, type AppServices } from './services'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteDocument, NoteId } from '../domain/model'
import type { StartupRecoveryReport, StickySettings, TemporaryWindowState, UpdatePort } from '../domain/ports'
import { isCanonicalUuidV7 } from '../domain/ids'
import { StickyWindow } from '../features/temporary/StickyWindow'
import type { AppSettings } from '../domain/ports'
import { SettingsView } from '../features/settings/SettingsView'
import { useExportLibraryController } from '../features/settings/ExportLibrary'
import { DEFAULT_APP_SETTINGS, DEFAULT_STICKY_SETTINGS, normalizeSettings, normalizeStickySettings, themeStyle } from '../features/settings/theme'
import { StatusNotice, type StatusNoticeState } from '../shared/StatusNotice'

const defaultServices = createAppServices()

export function App({ services = defaultServices }: { services?: AppServices }) {
  const sticky = stickyRoute()
  return sticky === null
    ? <MainApplication services={services} />
    : <StickyApplication services={services} route={sticky} />
}

function MainApplication({ services }: { services: AppServices }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [settingsError, setSettingsError] = useState(false)
  const [recoveryNotice, setRecoveryNotice] = useState<StatusNoticeState>({ status: 'idle' })
  const settingsRevision = useRef(0)
  const libraryRef = useRef<LibraryLayoutHandle>(null)
  const recoveryRequest = useRef(0)
  const recoveryBusy = useRef(false)
  const systemScheme = useSystemColorScheme()
  const chooseExportDestination = useCallback(
    () => services.exportDestinationPicker?.chooseExportDestination() ?? Promise.resolve(null),
    [services.exportDestinationPicker],
  )
  const exportController = useExportLibraryController(services.exporter, chooseExportDestination)
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [closeNotice, setCloseNotice] = useState<StatusNoticeState>({ status: 'idle' })
  const closeBusy = useRef(false)
  const checkForUpdates = useCallback(async () => {
    if (services.updater === undefined || updateState.status === 'checking' || updateState.status === 'installing') return
    setUpdateState({ status: 'checking' })
    try {
      const available = await services.updater.check()
      setUpdateState(available === null ? { status: 'none' } : { status: 'available', update: available })
    } catch {
      setUpdateState({ status: 'check-error' })
    }
  }, [services.updater, updateState.status])
  const installUpdate = useCallback(async () => {
    if (services.updater === undefined || updateState.status !== 'available') return
    setUpdateState({ status: 'installing', update: updateState.update })
    try {
      await services.updater.install()
      setUpdateState({ status: 'installed', update: updateState.update })
    } catch {
      setUpdateState({ status: 'install-error', update: updateState.update })
    }
  }, [services.updater, updateState])
  const restartAfterUpdate = useCallback(async () => {
    if (services.updater === undefined || updateState.status !== 'installed') return
    setUpdateState({ status: 'restarting', update: updateState.update })
    let release: (() => void) | null = null
    try {
      release = await libraryRef.current?.prepareExit() ?? null
      if (release === null) throw new Error('editor flush failed')
      await services.updater.restart()
      release = null
    } catch {
      release?.()
      setUpdateState({ status: 'restart-error', update: updateState.update })
    }
  }, [services.updater, updateState])
  const loadSettings = useCallback(async () => {
    if (services.settings === undefined) return
    const revision = settingsRevision.current
    try {
      const loaded = normalizeSettings(await services.settings.load())
      if (settingsRevision.current === revision) setSettings(loaded)
      setSettingsError(false)
    } catch {
      setSettingsError(true)
    }
  }, [services.settings])
  useEffect(() => {
    let active = true
    if (services.settings === undefined) return
    let unlisten: (() => void) | undefined
    void services.settings.onChanged((changed) => {
      if (!active) return
      settingsRevision.current += 1
      setSettings(normalizeSettings(changed))
      setSettingsError(false)
    }).then((stop) => {
      if (!active) stop()
      else {
        unlisten = stop
        void loadSettings()
      }
    }).catch(() => void loadSettings())
    return () => { active = false; unlisten?.() }
  }, [loadSettings, services.settings])
  useEffect(() => {
    const recovery = services.recovery
    if (recovery === undefined) return
    let active = true
    const isCurrent = (request: number) => active && recoveryRequest.current === request
    const retry = async () => {
      if (recoveryBusy.current) return
      recoveryBusy.current = true
      const request = ++recoveryRequest.current
      setRecoveryNotice({ status: 'error', message: '本地索引恢复未完成，Markdown 内容保持不变。', retry: () => void retry(), retryLabel: '重试启动恢复', busy: true })
      try {
        const report = await recovery.retry()
        if (!isCurrent(request)) return
        await show(report, true, request)
      } catch {
        if (isCurrent(request)) setRecoveryNotice({ status: 'error', message: '本地索引恢复仍未完成，Markdown 内容保持不变。', retry: () => void retry(), retryLabel: '重试启动恢复' })
      } finally {
        if (recoveryRequest.current === request) recoveryBusy.current = false
      }
    }
    const show = async (report: StartupRecoveryReport, refreshLibrary: boolean, request: number) => {
      if (!isCurrent(request)) return
      if (report.failure != null) {
        setRecoveryNotice({ status: 'error', message: '本地索引恢复未完成，Markdown 内容保持不变。', retry: () => void retry(), retryLabel: '重试启动恢复' })
        return
      }
      const actions = report.recovered.length + report.quarantined.length + (report.indexRebuilt ? 1 : 0)
      if (refreshLibrary) await libraryRef.current?.refreshAfterRecovery()
      if (!isCurrent(request)) return
      if (actions === 0) {
        setRecoveryNotice({ status: 'idle' })
        return
      }
      const recovered = report.recovered.length > 0 ? `已恢复 ${report.recovered.length} 篇笔记` : '启动恢复检查已完成'
      setRecoveryNotice({ status: 'success', message: `${recovered}${report.indexRebuilt ? '并重建本地索引' : ''}${report.quarantined.length > 0 ? `；隔离 ${report.quarantined.length} 个不安全候选` : ''}` })
    }
    const load = async () => {
      const request = ++recoveryRequest.current
      try {
        await show(await recovery.load(), false, request)
      } catch {
        if (isCurrent(request)) setRecoveryNotice({ status: 'error', message: '无法读取启动恢复报告。', retry: () => void load(), retryLabel: '重试读取恢复报告' })
      }
    }
    void load()
    return () => {
      active = false
      recoveryRequest.current += 1
      recoveryBusy.current = false
    }
  }, [services.recovery])
  useEffect(() => {
    const lifecycle = services.lifecycle
    if (lifecycle === undefined) return
    let active = true
    let unlisten: (() => void) | undefined
    let registrationToken: number | undefined
    let registrationReleased = false
    const close = async (generation: number) => {
      if (closeBusy.current) return
      closeBusy.current = true
      setCloseNotice({ status: 'status', message: '正在安全保存并退出…' })
      let release: (() => void) | null = null
      try {
        release = await libraryRef.current?.prepareExit() ?? null
        if (release === null) {
          setCloseNotice({ status: 'error', message: '无法退出：请先解决保存错误，然后重试关闭。' })
          await lifecycle.completeClose(generation, false)
          return
        }
        await lifecycle.completeClose(generation, true)
        release = null
      } catch {
        if (active) setCloseNotice({ status: 'error', message: '无法退出：保存确认失败，请重试关闭。' })
        await lifecycle.completeClose(generation, false).catch(() => undefined)
      } finally {
        release?.()
        closeBusy.current = false
      }
    }
    const releaseRegistration = async () => {
      if (registrationToken === undefined || registrationReleased) return
      registrationReleased = true
      await lifecycle.setListenerReady(false, registrationToken).catch(() => undefined)
    }
    const registration = lifecycle.beginCloseListenerRegistration().then(async (token) => {
      registrationToken = token
      if (!active) return
      const stop = await lifecycle.onCloseRequested((request) => void close(request.generation))
      unlisten = stop
      if (!active) return
      try {
        await lifecycle.setListenerReady(true, token)
      } catch {
        // Rust marks the token ready before re-emitting any pending close. A
        // failed emit must keep the installed listener registered for retry.
        if (active) setCloseNotice({ status: 'error', message: '无法监听安全退出请求，请保存后重试。' })
      }
    }).catch(async () => {
      unlisten?.()
      unlisten = undefined
      await releaseRegistration()
      if (active) setCloseNotice({ status: 'error', message: '无法监听安全退出请求，请保存后重试。' })
    })
    return () => {
      active = false
      void registration.finally(async () => {
        await releaseRegistration()
        unlisten?.()
      })
    }
  }, [services.lifecycle])
  return (
    <main role="application" aria-label="Simple Notes" className="app-shell" data-theme={settings.theme} style={themeStyle(settings, systemScheme)}>
      {settingsError && <SettingsLoadError onRetry={loadSettings} />}
      <StatusNotice state={recoveryNotice} className="startup-recovery-notice" />
      <StatusNotice state={closeNotice} className="startup-recovery-notice" />
      {services.updater !== undefined && <UpdateControls state={updateState} onCheck={() => void checkForUpdates()} onInstall={() => void installUpdate()} onRestart={() => void restartAfterUpdate()} />}
      <div className="app-workspace" aria-hidden={restartRequired || undefined} inert={restartRequired}>
        <LibraryLayout ref={libraryRef} notes={services.notes} folders={services.folders} system={services.system} assets={services.assets} search={services.search} links={services.links} temporary={services.temporary} temporaryWindows={services.temporaryWindows} trash={services.trash} defaultEditorMode={settings.defaultEditorMode} autosaveDelayMs={settings.autosaveDelayMs} />
        {services.settings && <button type="button" className="settings-launcher" aria-label="打开设置" disabled={restartRequired} onClick={() => setSettingsOpen(true)}>⚙</button>}
      </div>
      {settingsOpen && services.settings && <SettingsView settings={services.settings} value={settings} onChange={setSettings} onClose={() => { if (!restartRequired) setSettingsOpen(false) }} prepareStorageMove={() => libraryRef.current?.prepareStorageMove() ?? Promise.resolve(null)} onRestartRequired={() => setRestartRequired(true)} exportController={services.exporter !== undefined && services.exportDestinationPicker !== undefined ? exportController : undefined} />}
    </main>
  )
}

type UpdateState =
  | { status: 'idle' | 'checking' | 'none' | 'check-error' }
  | { status: 'available' | 'installing' | 'installed' | 'install-error' | 'restarting' | 'restart-error'; update: Awaited<ReturnType<UpdatePort['check']>> & {} }

function UpdateControls({ state, onCheck, onInstall, onRestart }: { state: UpdateState; onCheck(): void; onInstall(): void; onRestart(): void }) {
  const update = 'update' in state ? state.update : null
  return <section className="update-controls" aria-label="Application updates">
    <button type="button" onClick={onCheck} disabled={state.status === 'checking' || state.status === 'installing' || state.status === 'restarting'}>Check for updates</button>
    {state.status === 'checking' && <p role="status">Checking for updates…</p>}
    {state.status === 'none' && <p role="status">Simple Notes is up to date.</p>}
    {state.status === 'check-error' && <p role="alert">Could not check for updates. Your notes are unchanged.</p>}
    {state.status === 'available' && update !== null && <><p role="status">Version {update.version} is ready to install.</p><button type="button" onClick={onInstall}>Download and install version {update.version}</button></>}
    {state.status === 'installing' && <p role="status">Downloading and verifying update…</p>}
    {state.status === 'install-error' && <p role="alert">Update installation failed. Your notes are unchanged.</p>}
    {state.status === 'installed' && <><p role="status">Update installed. Restart to finish.</p><button type="button" onClick={onRestart}>Restart to finish update</button></>}
    {state.status === 'restarting' && <p role="status">Restarting Simple Notes…</p>}
    {state.status === 'restart-error' && <p role="alert">Update installed, but restart failed. Restart Simple Notes manually.</p>}
  </section>
}

function StickyApplication({ services, route }: { services: AppServices; route: StickyRoute }) {
  const [appearance, setAppearance] = useState<StickySettings>(DEFAULT_STICKY_SETTINGS)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const requestRef = useRef(0)
  const systemScheme = useSystemColorScheme()
  const loadAppearance = useCallback(async () => {
    const request = ++requestRef.current
    setError(false)
    if (services.stickySettings === undefined) {
      if (requestRef.current === request) setError(true)
      return
    }
    try {
      const loaded = normalizeStickySettings(await services.stickySettings.load())
      if (requestRef.current !== request) return
      setAppearance(loaded)
      setReady(true)
    } catch {
      if (requestRef.current === request) setError(true)
    }
  }, [services.stickySettings])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    if (services.stickySettings === undefined) {
      void loadAppearance()
      return () => { active = false; requestRef.current += 1 }
    }
    void services.stickySettings.onChanged((changed) => {
      if (!active) return
      requestRef.current += 1
      setAppearance(normalizeStickySettings(changed))
      setReady(true)
      setError(false)
    }).then((stop) => {
      if (!active) stop()
      else {
        unlisten = stop
        void loadAppearance()
      }
    }).catch(() => void loadAppearance())
    return () => {
      active = false
      requestRef.current += 1
      unlisten?.()
    }
  }, [loadAppearance, services.stickySettings])

  return (
    <div className="app-shell" data-theme={appearance.theme} style={themeStyle(appearance, systemScheme)}>
      {error
        ? <StickyAppearanceLoadError onRetry={loadAppearance} />
        : ready
          ? <StickyWindowEntry services={services} route={route} autosaveDelayMs={appearance.autosaveDelayMs} />
          : <main className="sticky-window"><p role="status">正在加载便签外观…</p></main>}
    </div>
  )
}

interface StickyRoute {
  noteId: NoteId
  state: TemporaryWindowState
}

function stickyRoute(): StickyRoute | null {
  const params = new URLSearchParams(window.location.search)
  const value = params.get('sticky')
  if (value === null || !isCanonicalUuidV7(value)) return null
  const noteId = value as NoteId
  const number = (name: string, fallback: number) => {
    if (!params.has(name)) return fallback
    const parsed = Number(params.get(name))
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    noteId,
    state: {
      noteId,
      visible: true,
      x: number('x', 48),
      y: number('y', 48),
      width: number('width', 360),
      height: number('height', 420),
      alwaysOnTop: params.get('pin') !== '0',
    },
  }
}

function StickyWindowEntry({ services, route, autosaveDelayMs }: { services: AppServices; route: StickyRoute; autosaveDelayMs: number }) {
  const [note, setNote] = useState<NoteDocument | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    if (services.temporary === undefined) {
      setError(true)
      return
    }
    void services.temporary
      .load(route.noteId)
      .then((found) => {
        if (!active) return
        if (found.id !== route.noteId || found.kind !== 'temporary') setError(true)
        else setNote(found)
      })
      .catch(() => active && setError(true))
    return () => {
      active = false
    }
  }, [route.noteId, services.temporary])
  if (error || services.temporary === undefined || services.temporaryWindows === undefined) {
    return <main className="sticky-window"><p role="alert">无法打开这张临时便签。</p></main>
  }
  if (note === null) return <main className="sticky-window"><p role="status">正在打开便签…</p></main>
  return (
    <StickyWindow
      note={note}
      temporary={services.temporary}
      windows={services.temporaryWindows}
      assets={services.assets}
      initialWindowState={route.state}
      autosaveDelayMs={autosaveDelayMs}
    />
  )
}

function SettingsLoadError({ onRetry }: { onRetry(): Promise<void> }) {
  return <p className="settings-load-error" role="alert">无法加载设置，当前编辑内容保持不变。<button type="button" onClick={() => void onRetry()}>重试加载设置</button></p>
}

function StickyAppearanceLoadError({ onRetry }: { onRetry(): Promise<void> }) {
  return <main className="sticky-window"><p role="alert">无法加载便签外观。<button type="button" onClick={() => void onRetry()}>重试加载便签外观</button></p></main>
}

function useSystemColorScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() =>
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const changed = (event: MediaQueryListEvent) => setScheme(event.matches ? 'dark' : 'light')
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  return scheme
}
