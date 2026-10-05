import { useEffect, useMemo, useRef, useState } from 'react'
import { isCanonicalUuidV7 } from '../../domain/ids'
import type { NoteId, NoteSummary } from '../../domain/model'
import type { LinkPort, SystemPort } from '../../domain/ports'

/** Stars are navigation preferences keyed by immutable IDs, independent of folder stars. */
export function useStarredNotes(system: SystemPort, links: LinkPort | undefined, visible: NoteSummary[]) {
  const [ids, setIds] = useState<NoteId[]>([])
  const [resolved, setResolved] = useState<NoteSummary[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let current = true
    void system.getWindowPreference('library-starred-notes').then(async (saved) => {
      const valid = Array.isArray(saved) ? [...new Set(saved.filter((id): id is NoteId => typeof id === 'string' && isCanonicalUuidV7(id)))] : []
      const entries = links ? await Promise.all(valid.map((id) => links.resolve(id).catch(() => null))) : []
      if (!current) return
      setIds(valid)
      setResolved(entries.filter((entry): entry is NoteSummary => entry !== null && entry.kind === 'formal'))
      setReady(true)
    }).catch(() => { if (current) setError('无法读取星标，请重新打开应用。') })
    return () => { current = false; mounted.current = false }
  }, [system, links])
  const visibleKey = visible.map((note) => note.id + ':' + note.revision + ':' + note.title).join('|')
  useEffect(() => {
    if (!ready || !links) return
    let current = true
    void Promise.all(ids.map((id) => links.resolve(id).catch(() => null))).then((entries) => {
      if (current) setResolved(entries.filter((entry): entry is NoteSummary => entry !== null && entry.kind === 'formal'))
    })
    return () => { current = false }
  }, [ids, visibleKey, ready, links])
  const notes = useMemo(() => ids.flatMap((id) => {
    const entry = visible.find((note) => note.id === id) ?? resolved.find((note) => note.id === id)
    return entry?.kind === 'formal' ? [entry] : []
  }), [ids, visible, resolved])
  const toggle = async (note: NoteSummary) => {
    if (!ready || busy.current || note.kind !== 'formal' || !isCanonicalUuidV7(note.id)) return
    busy.current = true
    const next = ids.includes(note.id) ? ids.filter((id) => id !== note.id) : [...ids, note.id]
    try {
      await system.setWindowPreference('library-starred-notes', next)
      if (!mounted.current) return
      setIds(next)
      setResolved((entries) => [...entries.filter((entry) => entry.id !== note.id), note])
      setError(null)
    } catch { if (mounted.current) setError('无法保存星标，请重试。') }
    finally { busy.current = false }
  }
  return { ids, notes, ready, error, toggle }
}
