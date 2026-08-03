import '../styles/tokens.css'
import '../styles/app.css'
import { LibraryLayout } from '../features/library/LibraryLayout'
import { createAppServices, type AppServices } from './services'
import { useEffect, useState } from 'react'
import type { NoteDocument, NoteId } from '../domain/model'
import type { TemporaryWindowState } from '../domain/ports'
import { isCanonicalUuidV7 } from '../domain/ids'
import { StickyWindow } from '../features/temporary/StickyWindow'

const defaultServices = createAppServices()

export function App({ services = defaultServices }: { services?: AppServices }) {
  const sticky = stickyRoute()
  if (sticky !== null) {
    return <StickyWindowEntry services={services} route={sticky} />
  }
  return (
    <main role="application" aria-label="Simple Notes" className="app-shell">
      <LibraryLayout notes={services.notes} folders={services.folders} system={services.system} assets={services.assets} search={services.search} links={services.links} temporary={services.temporary} trash={services.trash} />
    </main>
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

function StickyWindowEntry({ services, route }: { services: AppServices; route: StickyRoute }) {
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
    />
  )
}
