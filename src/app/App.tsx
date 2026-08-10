import '../styles/tokens.css'
import '../styles/app.css'
import { LibraryLayout, type LibraryLayoutHandle } from '../features/library/LibraryLayout'
import { createAppServices, type AppServices } from './services'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteDocument, NoteId } from '../domain/model'
import type { StickySettings, TemporaryWindowState } from '../domain/ports'
import { isCanonicalUuidV7 } from '../domain/ids'
import { StickyWindow } from '../features/temporary/StickyWindow'
import type { AppSettings } from '../domain/ports'
import { SettingsView } from '../features/settings/SettingsView'
import { useExportLibraryController } from '../features/settings/ExportLibrary'
import { DEFAULT_APP_SETTINGS, DEFAULT_STICKY_SETTINGS, normalizeSettings, normalizeStickySettings, themeStyle } from '../features/settings/theme'

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
  const settingsRevision = useRef(0)
  const libraryRef = useRef<LibraryLayoutHandle>(null)
  const systemScheme = useSystemColorScheme()
  const chooseExportDestination = useCallback(
    () => services.exportDestinationPicker?.chooseExportDestination() ?? Promise.resolve(null),
    [services.exportDestinationPicker],
  )
  const exportController = useExportLibraryController(services.exporter, chooseExportDestination)
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
  return (
    <main role="application" aria-label="Simple Notes" className="app-shell" data-theme={settings.theme} style={themeStyle(settings, systemScheme)}>
      {settingsError && <SettingsLoadError onRetry={loadSettings} />}
      <div className="app-workspace" aria-hidden={restartRequired || undefined} inert={restartRequired}>
        <LibraryLayout ref={libraryRef} notes={services.notes} folders={services.folders} system={services.system} assets={services.assets} search={services.search} links={services.links} temporary={services.temporary} trash={services.trash} defaultEditorMode={settings.defaultEditorMode} autosaveDelayMs={settings.autosaveDelayMs} />
        {services.settings && <button type="button" className="settings-launcher" aria-label="打开设置" disabled={restartRequired} onClick={() => setSettingsOpen(true)}>⚙</button>}
      </div>
      {settingsOpen && services.settings && <SettingsView settings={services.settings} value={settings} onChange={setSettings} onClose={() => { if (!restartRequired) setSettingsOpen(false) }} prepareStorageMove={() => libraryRef.current?.prepareStorageMove() ?? Promise.resolve(null)} onRestartRequired={() => setRestartRequired(true)} exportController={services.exporter !== undefined && services.exportDestinationPicker !== undefined ? exportController : undefined} />}
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
