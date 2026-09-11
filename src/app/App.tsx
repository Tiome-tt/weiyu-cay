import '../styles/tokens.css'
import '../styles/app.css'
import '../styles/main-window.css'
import { LibraryLayout, type LibraryLayoutHandle } from '../features/library/LibraryLayout'
import { createAppServices, type AppServices } from './services'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteDocument, NoteId } from '../domain/model'
import type { StartupRecoveryReport, StickySettings, TemporaryWindowState } from '../domain/ports'
import { isCanonicalUuidV7 } from '../domain/ids'
import { StickyWindow } from '../features/temporary/StickyWindow'
import type { AppSettings } from '../domain/ports'
import { SettingsView } from '../features/settings/SettingsView'
import { useExportLibraryController } from '../features/settings/ExportLibrary'
import { DEFAULT_APP_SETTINGS, DEFAULT_STICKY_SETTINGS, normalizeSettings, normalizeStickySettings, themeStyle } from '../features/settings/theme'
import { StatusNotice, type StatusNoticeState } from '../shared/StatusNotice'
import { APP_NAME } from '../shared/brand'
import { AppChrome } from '../shared/AppChrome'
import { GlobalToolbar, type ToolbarSaveState } from '../features/library/GlobalToolbar'
import type { UpdateController, UpdateViewState } from '../features/settings/UpdateSettings'
import { useLifecycleParticipant } from '../features/lifecycle/useLifecycleParticipant'
import { CloseBehaviorDialog, type CloseBehaviorChoice } from '../features/lifecycle/CloseBehaviorDialog'

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
  const [updateState, setUpdateState] = useState<UpdateViewState>({ status: 'idle' })
  const [closeNotice, setCloseNotice] = useState<StatusNoticeState>({ status: 'idle' })
  const [closeChoice, setCloseChoice] = useState<{ trayAvailable: boolean; busy: boolean; error: string | null } | null>(null)
  const [saveState, setSaveState] = useState<ToolbarSaveState>('hidden')
  const [searchDismissSignal, setSearchDismissSignal] = useState(0)
  const dismissSearch = useCallback(() => {
    setSearchDismissSignal((current) => current + 1)
  }, [])
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
    if (services.updater === undefined || (updateState.status !== 'available' && updateState.status !== 'install-error')) return
    setUpdateState({ status: 'installing', update: updateState.update })
    try {
      await services.updater.install()
      setUpdateState({ status: 'installed', update: updateState.update })
    } catch {
      setUpdateState({ status: 'install-error', update: updateState.update })
    }
  }, [services.updater, updateState])
  const restartAfterUpdate = useCallback(async () => {
    if (services.updater === undefined || (updateState.status !== 'installed' && updateState.status !== 'restart-error')) return
    setUpdateState({ status: 'restarting', update: updateState.update })
    try {
      await services.updater.restart()
    } catch {
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
    if (services.lifecycle?.onCloseChoiceRequested === undefined) return
    let active = true
    let unlisten: (() => void) | undefined
    void services.lifecycle.onCloseChoiceRequested((request) => {
      if (active) setCloseChoice({ trayAvailable: request.trayAvailable, busy: false, error: null })
    }).then((stop) => {
      if (!active) stop()
      else unlisten = stop
    }).catch(() => {
      if (active) setCloseNotice({ status: 'error', message: '无法确认窗口关闭方式，窗口保持打开。' })
    })
    return () => { active = false; unlisten?.() }
  }, [services.lifecycle])
  useEffect(() => {
    if (services.navigation === undefined) return
    let active = true
    let unlisten: (() => void) | undefined
    void services.navigation.onRequested((action) => {
      if (!active) return
      dismissSearch()
      if (action === 'settings') {
        if (services.settings !== undefined) setSettingsOpen(true)
      } else {
        libraryRef.current?.openTemporaryInbox()
      }
    }).then((stop) => {
      if (!active) stop()
      else {
        unlisten = stop
        void services.navigation?.setReady?.(true).catch(() => {
          if (active) setCloseNotice({ status: 'error', message: '托盘导航尚未就绪，请在主窗口中重试。' })
        })
      }
    }).catch(() => {
      if (active) setCloseNotice({ status: 'error', message: '无法响应托盘操作，请在主窗口中重试。' })
    })
    return () => {
      active = false
      void services.navigation?.setReady?.(false).catch(() => undefined)
      unlisten?.()
    }
  }, [dismissSearch, services.navigation, services.settings])
  useEffect(() => {
    if (services.navigation?.onFailure === undefined) return
    let active = true
    let unlisten: (() => void) | undefined
    void services.navigation.onFailure((failure) => {
      if (!active) return
      setCloseNotice({
        status: 'error',
        message: failure.action === 'setup'
          ? '系统托盘暂时不可用，主窗口将保持可见。'
          : '无法新建临时便笺，请在主窗口中重试。',
      })
    }).then((stop) => {
      if (!active) stop()
      else unlisten = stop
    }).catch(() => undefined)
    return () => { active = false; unlisten?.() }
  }, [services.navigation])
  const chooseCloseBehavior = useCallback(async (choice: CloseBehaviorChoice, remember: boolean) => {
    if (closeChoice?.busy || services.lifecycle?.resolveCloseChoice === undefined) return
    setCloseChoice((current) => current === null ? null : { ...current, busy: true, error: null })
    try {
      if (remember) {
        if (services.settings === undefined) throw new Error('settings unavailable')
        const persisted = normalizeSettings(await services.settings.update({
          closeToTray: choice === 'hide',
          closeBehaviorConfirmed: true,
        }))
        settingsRevision.current += 1
        setSettings(persisted)
      }
      await services.lifecycle.resolveCloseChoice(choice)
      setCloseChoice(null)
    } catch {
      setCloseChoice((current) => current === null ? null : {
        ...current,
        busy: false,
        error: remember ? '设置未能保存，窗口保持打开。请重试或取消。' : '无法执行关闭操作，窗口保持打开。',
      })
    }
  }, [closeChoice?.busy, services.lifecycle, services.settings])
  useLifecycleParticipant(services.lifecycle, {
    prepare: async (signal) => {
      setCloseNotice({ status: 'status', message: '正在安全保存…' })
      const release = await libraryRef.current?.prepareExit(signal) ?? null
      if (release === null) {
        if (!signal.aborted) setCloseNotice({ status: 'error', message: '无法继续：请先解决保存错误，然后重试。' })
        return null
      }
      setCloseNotice({ status: 'idle' })
      return release
    },
  }, () => setCloseNotice({ status: 'error', message: '无法确认安全保存，请重试。' }), (failure) => {
    const failedSticky = temporaryIdFromLifecycleParticipant(failure.participant)
    if (failedSticky === null || services.temporaryWindows === undefined) {
      setCloseNotice({ status: 'error', message: '未能安全保存全部编辑内容，窗口保持打开，请检查后重试。' })
      return
    }
    setCloseNotice({ status: 'error', message: '一张隐藏便笺未能安全保存，正在重新打开…' })
    void services.temporaryWindows.show(failedSticky).then(() => {
      setCloseNotice({ status: 'error', message: '一张隐藏便笺未能安全保存，已重新打开，请检查后重试。' })
    }).catch(() => {
      setCloseNotice({ status: 'error', message: '一张隐藏便笺未能安全保存，请从临时便笺中打开并检查。' })
    })
  })
  const content = <>
      {settingsError && <SettingsLoadError onRetry={loadSettings} />}
      <StatusNotice state={recoveryNotice} className="startup-recovery-notice" />
      <StatusNotice state={closeNotice} className="startup-recovery-notice" />
      <div className="app-workspace" aria-hidden={restartRequired || closeChoice !== null || undefined} inert={restartRequired || closeChoice !== null}>
        <GlobalToolbar
          search={services.search}
          searchDismissSignal={searchDismissSignal}
          saveState={saveState}
          updateAttention={updateState.status === 'available' ? 'available' : updateState.status === 'installed' || updateState.status === 'restart-error' ? 'restart-required' : 'none'}
          onSelectResult={(noteId) => libraryRef.current?.selectSearchResult(noteId)}
          onOpenSettings={() => {
            if (services.settings !== undefined) {
              dismissSearch()
              setSettingsOpen(true)
            }
          }}
        />
        <LibraryLayout files={services.files} ref={libraryRef} notes={services.notes} folders={services.folders} system={services.system} startupGuide={services.startupGuide} assets={services.assets} search={services.search} links={services.links} temporary={services.temporary} temporaryWindows={services.temporaryWindows} trash={services.trash} defaultEditorMode={settings.defaultEditorMode} autosaveDelayMs={settings.autosaveDelayMs} onSaveStateChange={setSaveState} onCreatePopoverOpen={dismissSearch} />
      </div>
      {settingsOpen && services.settings && <SettingsView settings={services.settings} value={settings} platform={services.windowChrome.platform} onChange={setSettings} onClose={() => { if (!restartRequired) setSettingsOpen(false) }} prepareStorageMove={async () => {
        if (services.lifecycle?.prepareRelocation === undefined || services.lifecycle.cancelRelocation === undefined) return null
        const generation = await services.lifecycle.prepareRelocation()
        let active = true
        return () => {
          if (!active) return
          active = false
          void services.lifecycle?.cancelRelocation?.(generation)
        }
      }} onRestartRequired={() => setRestartRequired(true)} exportController={services.exporter !== undefined && services.exportDestinationPicker !== undefined ? exportController : undefined} updateController={services.updater === undefined ? undefined : { state: updateState, check: checkForUpdates, install: installUpdate, restart: restartAfterUpdate } satisfies UpdateController} />}
      {closeChoice !== null && <CloseBehaviorDialog
        trayAvailable={closeChoice.trayAvailable}
        busy={closeChoice.busy}
        error={closeChoice.error}
        onCancel={() => setCloseChoice(null)}
        onChoose={(choice, remember) => void chooseCloseBehavior(choice, remember)}
      />}
    </>
  return (
    <main role="application" aria-label={APP_NAME} className="app-shell main-window" data-theme={settings.theme} style={themeStyle(settings, systemScheme)}>
      <AppChrome windowChrome={services.windowChrome}>{content}</AppChrome>
    </main>
  )
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
          : <main className="sticky-window"><p role="status">正在加载便笺外观…</p></main>}
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

function temporaryIdFromLifecycleParticipant(participant: string | null): NoteId | null {
  const prefix = 'temporary-'
  if (participant === null || !participant.startsWith(prefix)) return null
  const value = participant.slice(prefix.length)
  return isCanonicalUuidV7(value) ? value as NoteId : null
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
    return <main className="sticky-window"><p role="alert">无法打开这张临时便笺。</p></main>
  }
  if (note === null) return <main className="sticky-window"><p role="status">正在打开便笺…</p></main>
  return (
    <StickyWindow
      note={note}
      temporary={services.temporary}
      windows={services.temporaryWindows}
      assets={services.assets}
      initialWindowState={route.state}
      autosaveDelayMs={autosaveDelayMs}
      lifecycle={services.lifecycle}
    />
  )
}

function SettingsLoadError({ onRetry }: { onRetry(): Promise<void> }) {
  return <p className="settings-load-error" role="alert">无法加载设置，当前编辑内容保持不变。<button type="button" onClick={() => void onRetry()}>重试加载设置</button></p>
}

function StickyAppearanceLoadError({ onRetry }: { onRetry(): Promise<void> }) {
  return <main className="sticky-window"><p role="alert">无法加载便笺外观。<button type="button" onClick={() => void onRetry()}>重试加载便笺外观</button></p></main>
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
