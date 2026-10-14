import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeSystemPort, note as fakeNote, fakeLinkPort } from '../../test/fakes'
import { useStarredNotes } from './useStarredNotes'

afterEach(cleanup)

describe('note stars', () => {
  it('publishes a star only after persistence succeeds', async () => {
    const note = { ...fakeNote(), excerpt: '' }
    const system = fakeSystemPort()
    const links = fakeLinkPort()
    links.resolve = vi.fn().mockResolvedValue(note)
    const { result } = renderHook(() => useStarredNotes(system, links, [note]))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { await result.current.toggle(note) })
    expect(system.setWindowPreference).toHaveBeenCalledWith('library-starred-notes', [note.id])
    expect(result.current.notes.map((entry) => entry.id)).toEqual([note.id])
    system.setWindowPreference = vi.fn().mockRejectedValue(new Error('disk failure'))
    await act(async () => { await result.current.toggle(note) })
    expect(result.current.notes).toHaveLength(1)
    expect(result.current.error).toBe('无法保存星标，请重试。')
  })
  it('restores formal note stars and rejects invalid persisted IDs and temporary captures', async () => {
    const note = { ...fakeNote(), excerpt: '' }
    const system = fakeSystemPort({ getWindowPreference: vi.fn().mockResolvedValue([note.id, 'invalid']) })
    const links = fakeLinkPort({ resolve: vi.fn().mockResolvedValue(note) })
    const { result } = renderHook(() => useStarredNotes(system, links, []))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.ids).toEqual([note.id])
    expect(result.current.notes).toEqual([note])
    expect(links.resolve).not.toHaveBeenCalledWith('invalid')
    await act(async () => { await result.current.toggle({ ...note, kind: 'temporary' }) })
    expect(system.setWindowPreference).not.toHaveBeenCalled()
  })

})

it('adds multiple stars in a single persisted operation without toggling existing stars off',async()=>{
 const first={...fakeNote(),excerpt:''},second={...fakeNote(),id:'019c0000-0000-7000-8000-000000000222' as typeof first.id,excerpt:''}
 const system=fakeSystemPort({getWindowPreference:vi.fn().mockResolvedValue([first.id])})
 const {result}=renderHook(()=>useStarredNotes(system,undefined,[first,second]))
 await waitFor(()=>expect(result.current.ready).toBe(true))
 await act(async()=>{await result.current.setStars([first,second],true)})
 expect(system.setWindowPreference).toHaveBeenCalledWith('library-starred-notes',[first.id,second.id])
 expect(result.current.ids).toEqual([first.id,second.id])
})
