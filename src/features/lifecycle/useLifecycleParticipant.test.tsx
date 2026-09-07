import { act, renderHook, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLifecycleParticipant } from './useLifecycleParticipant'

afterEach(cleanup)

function fakePort() {
  let prepare: (request: { generation: number; intent: 'hide' | 'exit' | 'restart' }) => void = () => undefined
  let release: (request: { generation: number }) => void = () => undefined
  let failure: (request: { participant: string | null }) => void = () => undefined
  const acknowledgments: Array<[number, number, boolean]> = []
  const port = {
    beginRegistration: vi.fn(async () => 1),
    setReady: vi.fn(async (ready: boolean, token: number) => { void ready; void token }),
    onPrepare: vi.fn(async (handler: typeof prepare) => { prepare = handler; return () => { prepare = () => undefined } }),
    onRelease: vi.fn(async (handler: typeof release) => { release = handler; return () => { release = () => undefined } }),
    onFailure: vi.fn(async (handler: typeof failure) => { failure = handler; return () => { failure = () => undefined } }),
    acknowledge: vi.fn(async (generation: number, token: number, saved: boolean) => { acknowledgments.push([generation, token, saved]) }),
  }
  return {
    port,
    acknowledgments,
    emitPrepare: (generation: number) => prepare({ generation, intent: 'exit' }),
    emitRelease: (generation: number) => release({ generation }),
    emitFailure: (participant: string | null) => failure({ participant }),
  }
}

describe('lifecycle participant', () => {
  it('signals cancellation without waiting for a pending durable write', async () => {
    const harness = fakePort()
    let signal!: AbortSignal
    const release = vi.fn()
    renderHook(() => useLifecycleParticipant(harness.port, {
      prepare: (value: AbortSignal) => {
        signal = value
        signal.addEventListener('abort', release, { once: true })
        return new Promise<null>(() => undefined)
      },
    }))
    await waitFor(() => expect(harness.port.setReady).toHaveBeenCalledWith(true, 1))
    act(() => harness.emitPrepare(1))
    act(() => harness.emitRelease(1))
    expect(signal.aborted).toBe(true)
    expect(release).toHaveBeenCalledOnce()
    expect(harness.acknowledgments).toEqual([])
  })

  it('withdraws registration when installing a prepare listener fails', async () => {
    const harness = fakePort()
    harness.port.onPrepare.mockRejectedValue(new Error('listener unavailable'))
    renderHook(() => useLifecycleParticipant(harness.port, { prepare: async () => null }))
    await waitFor(() => expect(harness.port.setReady).toHaveBeenCalledWith(false, 1))
    expect(harness.port.setReady).not.toHaveBeenCalledWith(true, 1)
  })

  it('releases a late barrier without acknowledging a cancelled generation', async () => {
    const harness = fakePort()
    let finish!: (value: (() => void) | null) => void
    const release = vi.fn()
    const participant = { prepare: () => new Promise<(() => void) | null>(resolve => { finish = resolve }) }
    renderHook(() => useLifecycleParticipant(harness.port, participant))
    await waitFor(() => expect(harness.port.setReady).toHaveBeenCalledWith(true, 1))
    act(() => harness.emitPrepare(1))
    act(() => harness.emitRelease(1))
    await act(async () => finish(release))
    expect(release).toHaveBeenCalledOnce()
    expect(harness.acknowledgments).toEqual([])
  })

  it('holds successful saves until released and ignores duplicate prepares', async () => {
    const harness = fakePort()
    const release = vi.fn()
    const participant = { prepare: vi.fn(async () => release) }
    renderHook(() => useLifecycleParticipant(harness.port, participant))
    await waitFor(() => expect(harness.port.setReady).toHaveBeenCalledWith(true, 1))
    await act(async () => { harness.emitPrepare(2); harness.emitPrepare(2) })
    expect(harness.acknowledgments).toEqual([[2, 1, true]])
    expect(participant.prepare).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    act(() => { harness.emitRelease(2); harness.emitRelease(2) })
    expect(release).toHaveBeenCalledOnce()
    await act(async () => harness.emitPrepare(2))
    expect(harness.acknowledgments).toEqual([[2, 1, true]])
  })

  it('reports failed saves and accepts a later retry', async () => {
    const harness = fakePort()
    const release = vi.fn()
    const participant = { prepare: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(release) }
    renderHook(() => useLifecycleParticipant(harness.port, participant))
    await waitFor(() => expect(harness.port.setReady).toHaveBeenCalledWith(true, 1))
    await act(async () => harness.emitPrepare(1))
    act(() => harness.emitRelease(1))
    await act(async () => harness.emitPrepare(2))
    expect(harness.acknowledgments).toEqual([[1, 1, false], [2, 1, true]])
  })

  it('releases held barriers on unmount', async () => {
    const harness = fakePort()
    const release = vi.fn()
    const participant = { prepare: async () => release }
    const rendered = renderHook(() => useLifecycleParticipant(harness.port, participant))
    await waitFor(() => expect(harness.port.setReady).toHaveBeenCalledWith(true, 1))
    await act(async () => harness.emitPrepare(1))
    rendered.unmount()
    expect(release).toHaveBeenCalledOnce()
    await waitFor(() => expect(harness.port.setReady).toHaveBeenCalledWith(false, 1))
  })

  it('holds a saved barrier when the acknowledgment response is uncertain', async () => {
    const harness = fakePort()
    harness.port.acknowledge.mockRejectedValue(new Error('disconnected'))
    const release = vi.fn()
    const participant = { prepare: async () => release }
    renderHook(() => useLifecycleParticipant(harness.port, participant))
    await waitFor(() => expect(harness.port.setReady).toHaveBeenCalledWith(true, 1))
    await act(async () => harness.emitPrepare(1))
    expect(release).not.toHaveBeenCalled()
    expect(harness.port.acknowledge).toHaveBeenCalledTimes(1)
    act(() => harness.emitRelease(1))
    expect(release).toHaveBeenCalledOnce()
  })

  it('cancels an indefinitely pending preparation and reports native timeout failure', async () => {
    const harness = fakePort()
    let signal!: AbortSignal
    const onFailure = vi.fn()
    renderHook(() => useLifecycleParticipant(harness.port, {
      prepare: (current) => {
        signal = current
        return new Promise<null>(() => undefined)
      },
    }, undefined, onFailure))
    await waitFor(() => expect(harness.port.setReady).toHaveBeenCalledWith(true, 1))
    act(() => harness.emitPrepare(7))

    act(() => harness.emitFailure('temporary-019c0000-0000-7000-8000-000000000001'))

    expect(signal.aborted).toBe(true)
    expect(onFailure).toHaveBeenCalledWith({
      participant: 'temporary-019c0000-0000-7000-8000-000000000001',
    })
  })
})
