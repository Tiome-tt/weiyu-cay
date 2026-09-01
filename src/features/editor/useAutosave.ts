import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteDocument, NoteId } from '../../domain/model'
import type { NotePort } from '../../domain/ports'

export type SaveState =
  | { status: 'idle' | 'dirty' | 'saving' | 'saved' }
  | { status: 'error'; message: string; retry: () => void }

interface AutosaveOptions {
  delayMs?: number
  publishDraftState?: boolean
}

interface SaveRequest {
  generation: number
  noteId: NoteId
  promise: Promise<boolean>
}

export const DEFAULT_AUTOSAVE_DELAY_MS = 600

export function useAutosave(
  document: NoteDocument,
  notes: Pick<NotePort, 'saveNote'> & Partial<Pick<NotePort, 'loadNote'>>,
  { delayMs = DEFAULT_AUTOSAVE_DELAY_MS, publishDraftState = true }: AutosaveOptions = {},
) {
  const [markdown, setMarkdown] = useState(document.markdown)
  const [state, setState] = useState<SaveState>({ status: 'idle' })
  const [updatedAt, setUpdatedAt] = useState(document.updatedAt)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const activeIdRef = useRef(document.id)
  const durableRef = useRef(document)
  const markdownRef = useRef(document.markdown)
  const persistedMarkdownRef = useRef(document.markdown)
  const editVersionRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const inFlightRef = useRef<SaveRequest | null>(null)
  const queuedRef = useRef(false)
  const conflictRecoveryVersionRef = useRef<number | null>(null)
  const conflictRecoveryPendingRef = useRef(false)
  const notesRef = useRef(notes)
  const delayRef = useRef(delayMs)
  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  const retryRef = useRef<() => void>(() => undefined)

  notesRef.current = notes
  delayRef.current = delayMs

  const publish = useCallback((nextState: SaveState, generation = generationRef.current) => {
    if (!mountedRef.current || generation !== generationRef.current) return
    setState((current) => {
      if (current.status === nextState.status && nextState.status !== 'error') return current
      return nextState
    })
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const runSave = useCallback(
    async (generation = generationRef.current): Promise<boolean> => {
      clearTimer()
      if (generation !== generationRef.current) return false

      const currentRequest = inFlightRef.current
      if (currentRequest?.generation === generation) {
        queuedRef.current = true
        const succeeded = await currentRequest.promise
        if (!succeeded || generation !== generationRef.current) return false
        if (markdownRef.current !== persistedMarkdownRef.current) return runSave(generation)
        return true
      }
      if (markdownRef.current === persistedMarkdownRef.current) return true

      const noteId = activeIdRef.current
      const durable = durableRef.current
      const content = markdownRef.current
      const editVersion = editVersionRef.current
      queuedRef.current = false
      publish({ status: 'saving' }, generation)

      const request: SaveRequest = {
        generation,
        noteId,
        promise: Promise.resolve(false),
      }
      const promise = Promise.resolve()
        .then(() => notesRef.current.saveNote({ ...durable, markdown: content }))
        .then((authoritative) => {
          if (
            generation !== generationRef.current ||
            noteId !== activeIdRef.current ||
            authoritative.id !== noteId
          ) {
            return false
          }
          durableRef.current = authoritative
          conflictRecoveryVersionRef.current = null
          persistedMarkdownRef.current = content
          setUpdatedAt(authoritative.updatedAt)
          const hasNewerText = editVersionRef.current !== editVersion || markdownRef.current !== content
          publish({ status: hasNewerText ? 'dirty' : 'saved' }, generation)
          return true
        })
        .catch(async (error: unknown) => {
          if (generation !== generationRef.current || noteId !== activeIdRef.current) return false
          if (
            isConflict(error) &&
            conflictRecoveryVersionRef.current !== editVersion &&
            notesRef.current.loadNote !== undefined
          ) {
            conflictRecoveryVersionRef.current = editVersion
            try {
              const authoritative = await notesRef.current.loadNote(noteId)
              if (
                generation === generationRef.current &&
                noteId === activeIdRef.current &&
                authoritative.markdown === persistedMarkdownRef.current
              ) {
                durableRef.current = authoritative
                conflictRecoveryPendingRef.current = true
                return false
              }
              if (
                generation === generationRef.current &&
                noteId === activeIdRef.current &&
                authoritative.markdown === markdownRef.current
              ) {
                durableRef.current = authoritative
                persistedMarkdownRef.current = authoritative.markdown
                setUpdatedAt(authoritative.updatedAt)
                publish({ status: 'saved' }, generation)
                return true
              }
            } catch {
              // Keep the original conflict guidance when the recovery load fails.
            }
          }
          publish(
            {
              status: 'error',
              message: saveErrorMessage(error),
              retry: () => retryRef.current(),
            },
            generation,
          )
          return false
        })
        .finally(() => {
          if (inFlightRef.current === request) inFlightRef.current = null
        })

      request.promise = promise
      inFlightRef.current = request
      const succeeded = await promise

      if (
        !succeeded &&
        conflictRecoveryPendingRef.current &&
        generation === generationRef.current &&
        noteId === activeIdRef.current
      ) {
        conflictRecoveryPendingRef.current = false
        return runSave(generation)
      }

      if (
        succeeded &&
        generation === generationRef.current &&
        noteId === activeIdRef.current &&
        (queuedRef.current || markdownRef.current !== persistedMarkdownRef.current)
      ) {
        queuedRef.current = false
        return runSave(generation)
      }
      return succeeded
    },
    [clearTimer, publish],
  )

  const flush = useCallback(() => runSave(generationRef.current), [runSave])

  const retry = useCallback(() => {
    const generation = generationRef.current
    publish({ status: 'dirty' }, generation)
    void runSave(generation)
  }, [publish, runSave])

  retryRef.current = retry
  flushRef.current = flush

  const scheduleSave = useCallback(() => {
    clearTimer()
    const generation = generationRef.current
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void runSave(generation)
    }, delayRef.current)
  }, [clearTimer, runSave])

  const updateMarkdown = useCallback(
    (nextMarkdown: string) => {
      if (nextMarkdown === markdownRef.current) return
      markdownRef.current = nextMarkdown
      editVersionRef.current += 1
      if (publishDraftState) setMarkdown(nextMarkdown)

      if (nextMarkdown === persistedMarkdownRef.current && inFlightRef.current === null) {
        clearTimer()
        publish({ status: 'saved' })
        return
      }
      if (inFlightRef.current?.generation === generationRef.current) {
        queuedRef.current = true
        return
      }
      publish({ status: 'dirty' })
      scheduleSave()
    },
    [clearTimer, publish, publishDraftState, scheduleSave],
  )

  useEffect(() => {
    if (activeIdRef.current === document.id) {
      const durable = durableRef.current
      if (document.revision >= durable.revision || isLaterTimestamp(document.updatedAt, durable.updatedAt)) {
        const hasLocalEdits = markdownRef.current !== persistedMarkdownRef.current
        durableRef.current = hasLocalEdits ? { ...document, markdown: markdownRef.current } : document
        if (!hasLocalEdits && document.markdown !== markdownRef.current) {
          markdownRef.current = document.markdown
          persistedMarkdownRef.current = document.markdown
          setMarkdown(document.markdown)
          setState({ status: 'idle' })
        }
      }
      setUpdatedAt((current) => isLaterTimestamp(document.updatedAt, current) ? document.updatedAt : current)
      return
    }
    clearTimer()
    generationRef.current += 1
    activeIdRef.current = document.id
    durableRef.current = document
    markdownRef.current = document.markdown
    persistedMarkdownRef.current = document.markdown
    editVersionRef.current = 0
    inFlightRef.current = null
    queuedRef.current = false
    conflictRecoveryVersionRef.current = null
    conflictRecoveryPendingRef.current = false
    setMarkdown(document.markdown)
    setUpdatedAt(document.updatedAt)
    setState({ status: 'idle' })
  }, [clearTimer, document])

  useEffect(() => {
    mountedRef.current = true
    const handleBlur = () => void flushRef.current()
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('blur', handleBlur)
      mountedRef.current = false
      clearTimer()
      void flushRef.current()
    }
  }, [clearTimer])

  return { state, markdown, updatedAt, updateMarkdown, flush, retry }
}

function saveErrorMessage(error: unknown): string {
  if (isConflict(error)) {
    return '便笺已在其他窗口中发生变化。当前修改已保留，请重试保存。'
  }
  return '无法保存，修改内容已保留在本地。'
}

function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'conflict'
}

function isLaterTimestamp(candidate: string, current: string) {
  const candidateTime = Date.parse(candidate)
  const currentTime = Date.parse(current)
  return Number.isFinite(candidateTime) && (!Number.isFinite(currentTime) || candidateTime > currentTime)
}
