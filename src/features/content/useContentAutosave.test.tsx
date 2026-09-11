import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { note, fakeNotePort } from '../../test/fakes'
import type { NoteDocument } from '../../domain/model'
import { useContentAutosave } from './useContentAutosave'
afterEach(cleanup)
const original: NoteDocument = { ...note(''), content: { type: 'text', text: '旧内容' } }
it('persists typed snapshots without putting content in Markdown', async () => {
  const saves: NoteDocument[] = []
  const port = fakeNotePort({ saveNote: async d => { saves.push(d); return { ...d, revision: d.revision + 1 } } })
  const hook = renderHook(() => useContentAutosave(original, port, 60000))
  act(() => hook.result.current.update({ type: 'text', text: '新内容' }))
  await act(async () => { expect(await hook.result.current.flush()).toBe(true) })
  expect(saves[0]).toMatchObject({ markdown: '', content: { type: 'text', text: '新内容' } })
  expect(hook.result.current.state.status).toBe('saved')
  expect(hook.result.current.savedRevision).toBe(2)
})
it('serializes a later edit after the current save using the returned revision', async () => {
  let finish!: (document: NoteDocument) => void
  const saves: NoteDocument[] = []
  const saveNote = async (d: NoteDocument) => {
    saves.push(d)
    return saves.length === 1 ? new Promise<NoteDocument>(resolve => { finish = resolve }) : { ...d, revision: d.revision + 1 }
  }
  const hook = renderHook(() => useContentAutosave(original, fakeNotePort({saveNote}), 60000))
  act(() => hook.result.current.update({type:'text',text:'first'}))
  let saving!: Promise<boolean>
  await act(async () => { saving = hook.result.current.flush(); await Promise.resolve() })
  act(() => hook.result.current.update({type:'text',text:'second'}))
  await act(async () => { finish({...saves[0],revision:2}); await saving })
  expect(saves).toHaveLength(2)
  expect(saves[1]).toMatchObject({revision:2,content:{text:'second'}})
})
it('retains failed drafts and retries instead of reporting saved', async () => {
  const saveNote = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(async d => ({...d,revision:2}))
  const hook = renderHook(() => useContentAutosave(original, fakeNotePort({saveNote}),60000))
  act(() => hook.result.current.update({type:'text',text:'unsaved'}))
  await act(async () => { expect(await hook.result.current.flush()).toBe(false) })
  expect(hook.result.current.state.status).toBe('error')
  expect(hook.result.current.content).toEqual({type:'text',text:'unsaved'})
  await act(async () => { expect(await hook.result.current.flush()).toBe(true) })
})

it('explains validation failures so incompatible document data is actionable', async () => {
  const saveNote = vi.fn(async () => { throw { code: 'validation', message: 'The request is invalid.' } })
  const hook = renderHook(() => useContentAutosave(original, fakeNotePort({ saveNote }), 60000))
  act(() => hook.result.current.update({ type: 'text', text: '需要保存' }))
  await act(async () => { expect(await hook.result.current.flush()).toBe(false) })
  const state = hook.result.current.state
  expect(state.status).toBe('error')
  if (state.status === 'error') expect(state.message).toContain('文档内容格式')
})

it('recovers a conflict when the durable document only contains legacy table metadata', async () => {
  const rich = {
    schemaVersion: 1 as const,
    root: {
      type: 'doc',
      content: [{
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [{
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: [null] },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧表格' }] }],
          }],
        }],
      }],
    },
  }
  const source = { ...original, content: { type: 'document' as const, document: rich } }
  const saveNote = vi.fn()
    .mockRejectedValueOnce({ code: 'conflict', message: 'The request conflicts with the current state.' })
    .mockImplementation(async (document: NoteDocument) => ({ ...document, revision: document.revision + 1 }))
  const hook = renderHook(() => useContentAutosave(source, { saveNote, loadNote: async () => source }, 60000))
  const edited = { ...rich, root: { ...rich.root, content: [{
    ...rich.root.content![0],
    content: [{ ...rich.root.content![0].content![0], content: [{
      ...rich.root.content![0].content![0].content![0],
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '新内容' }] }],
    }] }],
  }] } }
  act(() => hook.result.current.update({ type: 'document', document: edited }))
  await act(async () => { expect(await hook.result.current.flush()).toBe(true) })
  expect(saveNote).toHaveBeenCalledTimes(2)
  expect(hook.result.current.state.status).toBe('saved')
})
