import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteContent } from '../../domain/content'
import type { NoteDocument } from '../../domain/model'
import type { NotePort } from '../../domain/ports'
import type { SaveState } from '../editor/useAutosave'
import { fromTiptapJson, toTiptapJson } from '../document/schema'
interface Session {
  durable: NoteDocument
  draft: NoteContent
  persisted: string
  running: Promise<boolean> | null
  timer: ReturnType<typeof setTimeout> | null
}
function comparableContent(content: NoteContent | undefined): NoteContent | undefined {
  if (content?.type !== 'document') return content
  try {
    return { type: 'document', document: fromTiptapJson(toTiptapJson(content.document)) }
  } catch {
    return content
  }
}
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.keys(value).sort().map((name) => [name, stableValue((value as Record<string, unknown>)[name])]))
}
const key = (content: NoteContent | undefined) => JSON.stringify(stableValue(comparableContent(content)))
function saveFailureMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'validation') return '无法保存：文档内容格式未通过校验，当前修改仍保留在编辑器中。请重试；旧表格数据可能需要重新插入。'
  if (code === 'conflict') return '无法保存：笔记已在其他窗口中发生修改，当前修改仍保留在编辑器中。请先关闭其他编辑窗口后重试。'
  return '无法保存，当前修改仍保留在编辑器中。请重试；若内容冲突，请先备份当前修改。'
}
function session(document: NoteDocument): Session {
  if (!document.content) throw new Error('Typed editor requires typed content')
  const draft = structuredClone(comparableContent(document.content)!)
  return { durable: { ...document, content: draft }, draft, persisted: key(draft), running: null, timer: null }
}
export function useContentAutosave(document: NoteDocument, notes: Pick<NotePort, 'saveNote' | 'loadNote'>, delayMs = 600) {
  const current = useRef<Session | null>(null)
  if (current.current === null) current.current = session(document)
  const [content, setContent] = useState(current.current.draft)
  const [state, setState] = useState<SaveState>({status:'idle'})
  const [updatedAt, setUpdatedAt] = useState(document.updatedAt)
  const [savedRevision, setSavedRevision] = useState(document.revision)
  const alive = useRef(true)
  const port = useRef(notes)
  port.current = notes
  const retry = useRef<() => void>(() => undefined)
  const publish = useCallback((s: Session, next: SaveState) => {
    if (alive.current && current.current === s) setState(next)
  }, [])
  const run = useCallback(async (s: Session): Promise<boolean> => {
    if (s.timer !== null) { clearTimeout(s.timer); s.timer = null }
    if (s.running) return s.running
    const work = async () => {
      let rebased = false
      while (key(s.draft) !== s.persisted) {
        const snapshot = structuredClone(s.draft)
        const snapshotKey = key(snapshot)
        publish(s,{status:'saving'})
        try {
          const saved = await port.current.saveNote({...s.durable,markdown:'',content:snapshot})
          if (saved.id !== s.durable.id || saved.revision <= s.durable.revision || key(saved.content) !== snapshotKey) {
            throw new Error('Unexpected save acknowledgement')
          }
          s.durable = saved
          s.persisted = snapshotKey
          rebased = false
          if (alive.current && current.current === s) {
            setUpdatedAt(saved.updatedAt)
            setSavedRevision(saved.revision)
          }
        } catch (error: unknown) {
          if (!rebased && typeof error === 'object' && error !== null && 'code' in error && error.code === 'conflict') {
            rebased = true
            try {
              const latest = await port.current.loadNote(s.durable.id)
              if (latest.id === s.durable.id && key(latest.content) === s.persisted) { s.durable = latest; continue }
              if (latest.id === s.durable.id && key(latest.content) === snapshotKey) {
                s.durable = latest; s.persisted = snapshotKey; setSavedRevision(latest.revision); continue
              }
            } catch { /* Keep draft and explicit retry on read failure. */ }
          }
          publish(s,{status:'error',message:saveFailureMessage(error),retry:() => retry.current()})
          return false
        }
      }
      publish(s,{status:'saved'})
      return true
    }
    // Defer work so even a synchronously resolved port cannot race running assignment.
    s.running = Promise.resolve().then(work).finally(() => { s.running = null })
    return s.running
  }, [publish])
  const flush = useCallback(() => run(current.current!), [run])
  const reloadLatest = useCallback(async (): Promise<NoteDocument | null> => {
    const s = current.current
    if (!s) return null
    try {
      const latest = await port.current.loadNote(s.durable.id)
      if (latest.id !== s.durable.id) return null
      if (s.timer !== null) { clearTimeout(s.timer); s.timer = null }
      const next = session(latest)
      current.current = next
      setContent(next.draft)
      setUpdatedAt(latest.updatedAt)
      setSavedRevision(latest.revision)
      setState({ status: 'saved' })
      return latest
    } catch {
      return null
    }
  }, [])
  retry.current = () => { void flush() }
  const update = useCallback((next: NoteContent) => {
    const s = current.current!
    if (next.type !== s.draft.type) throw new Error('Editing cannot change content type')
    if (key(next) === key(s.draft)) return
    s.draft = structuredClone(next)
    setContent(s.draft)
    if (s.timer !== null) clearTimeout(s.timer)
    if (s.running) { publish(s,{status:'dirty'}); return }
    if (key(s.draft) === s.persisted) { publish(s,{status:'saved'}); return }
    publish(s,{status:'dirty'})
    s.timer = setTimeout(() => { s.timer = null; void run(s) }, delayMs)
  }, [delayMs,publish,run])
  useEffect(() => {
    const s = current.current!
    if (document.id !== s.durable.id) {
      void run(s)
      const next = session(document)
      current.current = next
      setContent(next.draft); setUpdatedAt(document.updatedAt); setSavedRevision(document.revision); setState({status:'idle'})
      return
    }
    if (document.revision <= s.durable.revision) return
    if (key(s.draft) === s.persisted && !s.running) {
      s.draft = structuredClone(document.content!)
      s.persisted = key(document.content)
      s.durable = document
      setContent(s.draft); setUpdatedAt(document.updatedAt)
    } else if (key(document.content) === s.persisted) {
      s.durable = document
      setSavedRevision(document.revision)
    }
  }, [document,run])
  useEffect(() => {
    alive.current = true
    const blur = () => { void run(current.current!) }
    window.addEventListener('blur',blur)
    return () => { alive.current = false; window.removeEventListener('blur',blur); void run(current.current!) }
  }, [run])
  return {content,state,updatedAt,savedRevision,update,flush,reloadLatest}
}
