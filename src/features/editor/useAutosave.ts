import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteDocument, NoteId } from '../../domain/model'
import type { NotePort } from '../../domain/ports'

export type SaveState =
  | { status: 'idle' | 'dirty' | 'saving' | 'saved' }
  | { status: 'error'; message: string; retry: () => void }

interface AutosaveOptions {
  delayMs?: number
}

interface SaveRequest {
  generation: number
  noteId: NoteId
  promise: Promise<boolean>
}

export const DEFAULT_AUTOSAVE_DELAY_MS = 600

export function useAutosave(
  document: NoteDocument,
  notes: Pick<NotePort, 'saveNote'>,
  { delayMs = DEFAULT_AUTOSAVE_DELAY_MS }: AutosaveOptions = {},
) {
  const [markdown, setMarkdown] = useState(document.markdown)
  const [state, setState] = useState<SaveState>({ status: 'idle' })
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
  const notesRef = useRef(notes)
  const delayRef = useRef(delayMs)
  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  const retryRef = useRef<() => void>(() => undefined)

  notesRef.current = notes
  delayRef.current = delayMs

  const publish = useCallback((nextState: SaveState, generation = generationRef.current) => {
    if (mountedRef.current && generation === generationRef.current) setState(nextState)
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
          persistedMarkdownRef.current = content
          const hasNewerText = editVersionRef.current !== editVersion || markdownRef.current !== content
          publish({ status: hasNewerText ? 'dirty' : 'saved' }, generation)
          return true
        })
        .catch((error: unknown) => {
          if (generation !== generationRef.current || noteId !== activeIdRef.current) return false
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
      setMarkdown(nextMarkdown)

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
    [clearTimer, publish, scheduleSave],
  )

  useEffect(() => {
    if (activeIdRef.current === document.id) return
    clearTimer()
    generationRef.current += 1
    activeIdRef.current = document.id
    durableRef.current = document
    markdownRef.current = document.markdown
    persistedMarkdownRef.current = document.markdown
    editVersionRef.current = 0
    inFlightRef.current = null
    queuedRef.current = false
    setMarkdown(document.markdown)
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

  return { state, markdown, updateMarkdown, flush, retry }
}

function saveErrorMessage(error: unknown): string {
  if (isConflict(error)) {
    return '便签已在其他窗口中发生变化。当前修改已保留，请重试保存。'
  }
  return '无法保存，修改内容已保留在本地。'
}

function isConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'conflict'
}
