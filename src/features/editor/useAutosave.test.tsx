import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteDocument, NoteId } from '../../domain/model'
import { commandError } from '../../domain/errors'
import { fakeNotePort, note } from '../../test/fakes'
import { useAutosave } from './useAutosave'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function saved(document: NoteDocument, revision: number): NoteDocument {
  return {
    ...document,
    revision,
    updatedAt: `2026-07-31T08:00:0${revision}Z`,
  }
}

describe('useAutosave', () => {
  it('debounces dirty content and does not save unchanged content', async () => {
    vi.useFakeTimers()
    const saveNote = vi.fn(async (document: NoteDocument) => saved(document, 2))
    const autosave = renderHook(() =>
      useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 40 }),
    )

    await act(async () => vi.advanceTimersByTimeAsync(80))
    expect(saveNote).not.toHaveBeenCalled()
    act(() => autosave.result.current.updateMarkdown('new'))
    expect(autosave.result.current.state.status).toBe('dirty')
    await act(async () => vi.advanceTimersByTimeAsync(39))
    expect(saveNote).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))

    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'new', revision: 1 }))
    expect(autosave.result.current.state.status).toBe('saved')
  })

  it('does not republish the same dirty status for every character', () => {
    const autosave = renderHook(() => useAutosave(note('old'), fakeNotePort(), { delayMs: 400 }))

    act(() => autosave.result.current.updateMarkdown('a'))
    const dirtyState = autosave.result.current.state
    act(() => autosave.result.current.updateMarkdown('ab'))

    expect(autosave.result.current.state).toBe(dirtyState)
  })

  it('publishes the authoritative updated time after a durable save', async () => {
    const saveNote = vi.fn(async (document: NoteDocument) => ({
      ...document,
      revision: 2,
      updatedAt: '2026-08-24T08:10:00Z',
    }))
    const autosave = renderHook(() =>
      useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 400 }),
    )

    expect(autosave.result.current.updatedAt).toBe('2026-07-30T15:30:00+08:00')
    act(() => autosave.result.current.updateMarkdown('new'))
    await act(async () => autosave.result.current.flush())

    expect(autosave.result.current.updatedAt).toBe('2026-08-24T08:10:00Z')
  })

  it('adopts newer metadata for the same open note without resetting its body', async () => {
    const saveNote = vi.fn(async (document: NoteDocument) => ({
      ...document,
      revision: 3,
      updatedAt: '2026-08-24T08:12:00Z',
    }))
    const port = fakeNotePort({ saveNote })
    const autosave = renderHook(
      ({ document }) => useAutosave(document, port, { delayMs: 400 }),
      { initialProps: { document: note('body') } },
    )

    autosave.rerender({
      document: { ...note('body'), title: '新标题', updatedAt: '2026-08-24T08:10:00Z' },
    })

    expect(autosave.result.current.updatedAt).toBe('2026-08-24T08:10:00Z')
    expect(autosave.result.current.markdown).toBe('body')
    act(() => autosave.result.current.updateMarkdown('body updated'))
    await act(async () => autosave.result.current.flush())
    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({
      title: '新标题',
      updatedAt: '2026-08-24T08:10:00Z',
      markdown: 'body updated',
    }))
  })

  it('flushes a dirty note when the editor loses focus', async () => {
    const saveNote = vi.fn(async (document: NoteDocument) => saved(document, 2))
    const autosave = renderHook(() =>
      useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 400 }),
    )
    act(() => autosave.result.current.updateMarkdown('new'))

    act(() => window.dispatchEvent(new Event('blur')))

    await waitFor(() =>
      expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'new' })),
    )
  })

  it('flushes a dirty note during orderly unmount', async () => {
    const saveNote = vi.fn(async (document: NoteDocument) => saved(document, 2))
    const autosave = renderHook(() =>
      useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 400 }),
    )
    act(() => autosave.result.current.updateMarkdown('before close'))

    autosave.unmount()

    await waitFor(() =>
      expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'before close' })),
    )
  })

  it('never reports saved until the durable save resolves', async () => {
    vi.useFakeTimers()
    const request = deferred<NoteDocument>()
    const saveNote = vi.fn(() => request.promise)
    const autosave = renderHook(() =>
      useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 10 }),
    )
    act(() => autosave.result.current.updateMarkdown('new'))
    await act(async () => vi.advanceTimersByTimeAsync(10))

    expect(autosave.result.current.state.status).toBe('saving')
    await act(async () => request.resolve(saved(note('new'), 2)))
    expect(autosave.result.current.state.status).toBe('saved')
  })

  it('retains failed Markdown and retries the latest content', async () => {
    const saveNote = vi
      .fn<(document: NoteDocument) => Promise<NoteDocument>>()
      .mockRejectedValueOnce(commandError('io'))
      .mockImplementationOnce(async (document) => saved(document, 2))
    const autosave = renderHook(() =>
      useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 400 }),
    )
    act(() => autosave.result.current.updateMarkdown('failed draft'))
    await act(async () => autosave.result.current.flush())

    expect(autosave.result.current.markdown).toBe('failed draft')
    const errorState = autosave.result.current.state
    expect(errorState.status).toBe('error')
    if (errorState.status !== 'error') throw new Error('expected error state')
    act(() => errorState.retry())

    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2))
    expect(saveNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ markdown: 'failed draft', revision: 1 }),
    )
    await waitFor(() => expect(autosave.result.current.state.status).toBe('saved'))
  })

  it('keeps local text and gives conflict-specific retry or reload guidance', async () => {
    const saveNote = vi.fn().mockRejectedValue(commandError('conflict'))
    const autosave = renderHook(() =>
      useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 400 }),
    )
    act(() => autosave.result.current.updateMarkdown('local text'))

    await act(async () => autosave.result.current.flush())

    expect(autosave.result.current.markdown).toBe('local text')
    expect(autosave.result.current.state).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/其他窗口|重新加载|重试/),
      retry: expect.any(Function),
    })
  })

  it('reloads a newer matching revision and retries the local draft automatically', async () => {
    const initial = note('old')
    const loadNote = vi.fn().mockResolvedValue(saved(initial, 2))
    const saveNote = vi
      .fn<(document: NoteDocument) => Promise<NoteDocument>>()
      .mockRejectedValueOnce(commandError('conflict'))
      .mockImplementationOnce(async (document) => saved(document, 3))
    const autosave = renderHook(() =>
      useAutosave(initial, fakeNotePort({ saveNote, loadNote }), { delayMs: 400 }),
    )

    act(() => autosave.result.current.updateMarkdown('local draft'))
    await act(async () => autosave.result.current.flush())

    expect(loadNote).toHaveBeenCalledWith(initial.id)
    expect(saveNote).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: 'local draft', revision: 2 }))
    await waitFor(() => expect(autosave.result.current.state.status).toBe('saved'))
  })

  it('accepts a conflict recovery when the durable Markdown already equals the local draft', async () => {
    const initial = note('old')
    const authoritative = saved(note('local draft'), 2)
    const saveNote = vi.fn().mockRejectedValue(commandError('conflict'))
    const loadNote = vi.fn().mockResolvedValue(authoritative)
    const autosave = renderHook(() =>
      useAutosave(initial, fakeNotePort({ saveNote, loadNote }), { delayMs: 400 }),
    )

    act(() => autosave.result.current.updateMarkdown('local draft'))
    await act(async () => autosave.result.current.flush())

    await waitFor(() => expect(autosave.result.current.state.status).toBe('saved'))
    expect(saveNote).toHaveBeenCalledOnce()
    expect(loadNote).toHaveBeenCalledWith(initial.id)
  })

  it('serializes in-flight edits onto the returned authoritative revision', async () => {
    vi.useFakeTimers()
    const first = deferred<NoteDocument>()
    const second = deferred<NoteDocument>()
    const saveNote = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const autosave = renderHook(() =>
      useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 10 }),
    )
    act(() => autosave.result.current.updateMarkdown('first edit'))
    await act(async () => vi.advanceTimersByTimeAsync(10))
    act(() => autosave.result.current.updateMarkdown('latest edit'))

    await act(async () => first.resolve(saved(note('first edit'), 2)))

    expect(autosave.result.current.markdown).toBe('latest edit')
    expect(saveNote).toHaveBeenCalledTimes(2)
    expect(saveNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ markdown: 'latest edit', revision: 2 }),
    )
    await act(async () => second.resolve(saved(note('latest edit'), 3)))
    expect(autosave.result.current.state.status).toBe('saved')
  })

  it('uses each successful authoritative revision for the next save', async () => {
    const saveNote = vi
      .fn<(document: NoteDocument) => Promise<NoteDocument>>()
      .mockImplementationOnce(async (document) => saved(document, 4))
      .mockImplementationOnce(async (document) => saved(document, 5))
    const autosave = renderHook(() =>
      useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 400 }),
    )
    act(() => autosave.result.current.updateMarkdown('first'))
    await act(async () => autosave.result.current.flush())
    act(() => autosave.result.current.updateMarkdown('second'))
    await act(async () => autosave.result.current.flush())

    expect(saveNote.mock.calls[0][0]).toMatchObject({ markdown: 'first', revision: 1 })
    expect(saveNote.mock.calls[1][0]).toMatchObject({ markdown: 'second', revision: 4 })
  })

  it('keeps the authoritative revision when draft publication is disabled and the parent rerenders', async () => {
    const saveNote = vi
      .fn<(document: NoteDocument) => Promise<NoteDocument>>()
      .mockImplementationOnce(async (document) => saved(document, 2))
      .mockImplementationOnce(async (document) => saved(document, 3))
    const initial = note('old')
    const autosave = renderHook(
      ({ document }) => useAutosave(document, fakeNotePort({ saveNote }), { delayMs: 400, publishDraftState: false }),
      { initialProps: { document: initial } },
    )

    act(() => autosave.result.current.updateMarkdown('first'))
    await act(async () => autosave.result.current.flush())
    autosave.rerender({ document: initial })
    act(() => autosave.result.current.updateMarkdown('second'))
    await act(async () => autosave.result.current.flush())

    expect(saveNote.mock.calls[0][0]).toMatchObject({ markdown: 'first', revision: 1 })
    expect(saveNote.mock.calls[1][0]).toMatchObject({ markdown: 'second', revision: 2 })
  })

  it('ignores an old note response after the selected document changes', async () => {
    const request = deferred<NoteDocument>()
    const saveNote = vi.fn(() => request.promise)
    const port = fakeNotePort({ saveNote })
    const noteA = note('A')
    const noteB = {
      ...note('B'),
      id: '019c0000-0000-7000-8000-000000000099' as NoteId,
      title: 'B',
      revision: 7,
    }
    const autosave = renderHook(
      ({ document }) => useAutosave(document, port, { delayMs: 400 }),
      { initialProps: { document: noteA } },
    )
    act(() => autosave.result.current.updateMarkdown('A dirty'))
    act(() => void autosave.result.current.flush())

    autosave.rerender({ document: noteB })
    await act(async () => request.resolve(saved(noteA, 2)))

    expect(autosave.result.current.markdown).toBe('B')
    expect(autosave.result.current.state.status).toBe('idle')
    expect(saveNote).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: noteB.id, markdown: 'A dirty' }),
    )
  })

  it('keeps dirty, saving, and saved state observable after Strict Mode effect replay', async () => {
    const request = deferred<NoteDocument>()
    const saveNote = vi.fn(() => request.promise)
    const autosave = renderHook(
      () => useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 400 }),
      { reactStrictMode: true },
    )

    act(() => autosave.result.current.updateMarkdown('strict draft'))
    expect(autosave.result.current.state.status).toBe('dirty')
    act(() => void autosave.result.current.flush())
    expect(autosave.result.current.state.status).toBe('saving')
    await act(async () => request.resolve(saved(note('strict draft'), 2)))

    expect(autosave.result.current.state.status).toBe('saved')
  })

  it('keeps Strict Mode save errors and retry observable', async () => {
    const saveNote = vi
      .fn<(document: NoteDocument) => Promise<NoteDocument>>()
      .mockRejectedValueOnce(commandError('io'))
      .mockImplementationOnce(async (document) => saved(document, 2))
    const autosave = renderHook(
      () => useAutosave(note('old'), fakeNotePort({ saveNote }), { delayMs: 400 }),
      { reactStrictMode: true },
    )
    act(() => autosave.result.current.updateMarkdown('strict retry'))

    await act(async () => autosave.result.current.flush())

    const errorState = autosave.result.current.state
    expect(errorState.status).toBe('error')
    if (errorState.status !== 'error') throw new Error('expected error state')
    act(() => errorState.retry())
    await waitFor(() => expect(autosave.result.current.state.status).toBe('saved'))
    expect(saveNote).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: 'strict retry' }))
  })

})
