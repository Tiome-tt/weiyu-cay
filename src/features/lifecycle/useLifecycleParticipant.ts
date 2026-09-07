import { useEffect, useRef } from 'react'
import type { LifecycleFailure, LifecycleParticipantPort, LifecycleRequest, SaveParticipant } from '../../domain/ports'

export function useLifecycleParticipant(
  port: LifecycleParticipantPort | undefined,
  participant: SaveParticipant,
  onError?: (error: unknown) => void,
  onFailure?: (failure: LifecycleFailure) => void,
): void {
  const participantRef = useRef(participant)
  const errorRef = useRef(onError)
  const failureRef = useRef(onFailure)
  participantRef.current = participant
  errorRef.current = onError
  failureRef.current = onFailure

  useEffect(() => {
    if (port === undefined) return
    let disposed = false
    let token: number | undefined
    let readinessAttempted = false
    let cancelledThrough = 0
    let newestGeneration = 0
    const started = new Set<number>()
    const held = new Map<number, () => void>()
    const preparing = new Map<number, AbortController>()
    const unlisteners: Array<() => void> = []
    const release = (generation: number) => {
      const finish = held.get(generation)
      held.delete(generation)
      finish?.()
    }
    const cancel = (generation: number) => {
      cancelledThrough = Math.max(cancelledThrough, generation)
      for (const [pending, controller] of preparing) {
        if (pending <= cancelledThrough) {
          controller.abort()
          preparing.delete(pending)
        }
      }
      for (const pending of held.keys()) {
        if (pending <= cancelledThrough) release(pending)
      }
      for (const pending of started) {
        if (pending <= cancelledThrough) started.delete(pending)
      }
    }
    const prepare = async (request: LifecycleRequest) => {
      const generation = request.generation
      if (disposed || token === undefined || !Number.isSafeInteger(generation) ||
          generation <= cancelledThrough || generation < newestGeneration || started.has(generation)) return
      newestGeneration = generation
      started.add(generation)
      const controller = new AbortController()
      preparing.set(generation, controller)
      let finish: (() => void) | null
      try {
        finish = await participantRef.current.prepare(controller.signal)
      } catch (error) {
        if (!disposed && generation > cancelledThrough) {
          errorRef.current?.(error)
          await port.acknowledge(generation, token, false).catch(() => undefined)
        }
        return
      }
      if (disposed || generation <= cancelledThrough) {
        finish?.()
        return
      }
      if (finish !== null) held.set(generation, finish)
      try {
        await port.acknowledge(generation, token, finish !== null)
      } catch (error) {
        // Native may already have accepted the successful acknowledgment.
        // Only an authoritative release can make this editor writable again.
        if (!disposed) errorRef.current?.(error)
      }
    }
    const registration = (async () => {
      token = await port.beginRegistration()
      if (disposed) return
      if (port.onFailure !== undefined) {
        unlisteners.push(await port.onFailure((failure) => {
          cancel(newestGeneration)
          failureRef.current?.(failure)
        }))
      }
      if (disposed) return
      unlisteners.push(await port.onRelease(({ generation }) => cancel(generation)))
      if (disposed) return
      unlisteners.push(await port.onPrepare((request) => { void prepare(request) }))
      if (disposed) return
      // A readiness response can fail after Rust marked it ready; keep listeners
      // installed so a subsequent request or release remains deliverable.
      readinessAttempted = true
      await port.setReady(true, token)
    })().catch(async error => {
      if (!readinessAttempted) {
        if (token !== undefined) await port.setReady(false, token).catch(() => undefined)
        for (const unlisten of unlisteners.splice(0)) unlisten()
      }
      if (!disposed) errorRef.current?.(error)
    })
    return () => {
      disposed = true
      for (const controller of preparing.values()) controller.abort()
      preparing.clear()
      for (const generation of held.keys()) release(generation)
      void registration.finally(async () => {
        if (token !== undefined) await port.setReady(false, token).catch(() => undefined)
        for (const unlisten of unlisteners) unlisten()
      })
    }
  }, [port])
}
