import type { NoteId } from '../../domain/model'
import type { ImageReadPort } from '../../domain/ports'

export interface LoadedImageAsset {
  mediaType: string
  bytes: Uint8Array
}

type BatchImageReadPort = ImageReadPort

interface PendingRequest {
  relativePath: string
  resolve(value: LoadedImageAsset): void
  reject(reason: unknown): void
}

interface PendingBatch {
  noteId: NoteId
  requests: Map<string, PendingRequest[]>
  scheduled: boolean
}

interface CacheEntry {
  generation: number
  value: LoadedImageAsset
}

const cacheByReader = new WeakMap<object, Map<string, CacheEntry>>()
const pendingByReader = new WeakMap<object, Map<string, PendingBatch>>()
let cacheGeneration = 0

function cacheKey(noteId: NoteId, relativePath: string): string {
  return `${noteId}\u0000${relativePath}`
}

function readerCache(reader: object): Map<string, CacheEntry> {
  const existing = cacheByReader.get(reader)
  if (existing !== undefined) return existing
  const created = new Map<string, CacheEntry>()
  cacheByReader.set(reader, created)
  return created
}

function settleRequests(requests: PendingRequest[], value: LoadedImageAsset): void {
  for (const request of requests) request.resolve(value)
}

const MAX_IMAGE_BATCH_SIZE = 2
const INITIAL_IMAGE_LOAD_DELAY_MS = 16

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 0)
  })
}

async function readImagePaths(
  reader: BatchImageReadPort,
  noteId: NoteId,
  paths: string[],
): Promise<ReadonlyArray<{ relativePath: string; mediaType: string; bytes: Uint8Array }>> {
  const readIndividually = () => Promise.all(paths.map(async (relativePath) => ({
    relativePath,
    ...await reader.readImage({ noteId, relativePath }),
  })))
  if (reader.readImages === undefined) return readIndividually()
  try {
    return await reader.readImages({ noteId, relativePaths: paths })
  } catch {
    // Keep compatible with an older native binary while the frontend is updated.
    return readIndividually()
  }
}

async function flushBatch(reader: BatchImageReadPort, batch: PendingBatch, batchKey: string): Promise<void> {
  const cache = readerCache(reader)
  try {
    while (batch.requests.size > 0) {
      const chunk = [...batch.requests.keys()].slice(0, MAX_IMAGE_BATCH_SIZE)
      try {
        const loaded = await readImagePaths(reader, batch.noteId, chunk)
        const loadedByPath = new Map(loaded.map((image) => [image.relativePath, image]))
        for (const relativePath of chunk) {
          const requests = batch.requests.get(relativePath) ?? []
          const image = loadedByPath.get(relativePath)
          if (image === undefined) {
            for (const request of requests) request.reject(new Error(`Image asset was not returned: ${relativePath}`))
            continue
          }
          const value = { mediaType: image.mediaType, bytes: image.bytes }
          cache.set(cacheKey(batch.noteId, relativePath), { generation: cacheGeneration, value })
          settleRequests(requests, value)
        }
      } catch (error) {
        for (const relativePath of chunk) {
          for (const request of batch.requests.get(relativePath) ?? []) request.reject(error)
        }
      }
      for (const path of chunk) batch.requests.delete(path)
      if (batch.requests.size > 0) await yieldToBrowser()
    }
  } finally {
    pendingByReader.get(reader)?.delete(batchKey)
  }
}

export function readImageAsset(reader: ImageReadPort, noteId: NoteId, relativePath: string): Promise<LoadedImageAsset> {
  const key = cacheKey(noteId, relativePath)
  const cache = readerCache(reader)
  const cached = cache.get(key)
  if (cached?.generation === cacheGeneration) return Promise.resolve(cached.value)

  let batches = pendingByReader.get(reader)
  if (batches === undefined) {
    batches = new Map()
    pendingByReader.set(reader, batches)
  }
  const batchKey = String(noteId)
  let batch = batches.get(batchKey)
  if (batch === undefined) {
    batch = { noteId, requests: new Map(), scheduled: false }
    batches.set(batchKey, batch)
  }
  const existing = batch.requests.get(relativePath)
  const promise = new Promise<LoadedImageAsset>((resolve, reject) => {
    const requests = existing ?? []
    requests.push({ relativePath, resolve, reject })
    batch!.requests.set(relativePath, requests)
  })
  if (!batch.scheduled) {
    batch.scheduled = true
    setTimeout(() => { void flushBatch(reader, batch!, batchKey) }, INITIAL_IMAGE_LOAD_DELAY_MS)
  }
  return promise
}

const IMAGE_LOAD_SETTLE_DELAY_MS = 24
const IMAGE_LOAD_WAIT_TIMEOUT_MS = 1_500

/** Wait only for image reads already started by the editor; do not reload completed images. */
export async function waitForImageAssets(reader: ImageReadPort, noteId: NoteId): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, IMAGE_LOAD_SETTLE_DELAY_MS))
  const deadline = Date.now() + IMAGE_LOAD_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const pending = pendingByReader.get(reader)?.get(String(noteId))
    if (pending === undefined) return
    const remaining = Math.max(8, Math.min(48, deadline - Date.now()))
    await new Promise<void>((resolve) => window.setTimeout(resolve, remaining))
  }
}

export function clearImageAssetCache(): void {
  cacheGeneration += 1
}
