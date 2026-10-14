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
  inFlight: Set<string>
}

interface CacheEntry {
  generation: number
  value: LoadedImageAsset
}

interface ImageCache { generation: number; bytes: number; entries: Map<string, CacheEntry> }
const cacheByReader = new WeakMap<object, ImageCache>()
const MAX_CACHED_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_CACHED_IMAGES = 128
const pendingByReader = new WeakMap<object, Map<string, PendingBatch>>()
let cacheGeneration = 0

function cacheKey(noteId: NoteId, relativePath: string): string {
  return `${noteId}\u0000${relativePath}`
}

function readerCache(reader: object): ImageCache {
  const existing = cacheByReader.get(reader)
  if (existing !== undefined) {
    if (existing.generation !== cacheGeneration) { existing.entries.clear(); existing.bytes = 0; existing.generation = cacheGeneration }
    return existing
  }
  const created = { generation: cacheGeneration, bytes: 0, entries: new Map<string, CacheEntry>() }
  cacheByReader.set(reader, created)
  return created
}
function cacheImage(cache: ImageCache, key: string, value: LoadedImageAsset, generation: number) {
  if (generation !== cacheGeneration || value.bytes.byteLength > MAX_CACHED_IMAGE_BYTES) return
  const previous = cache.entries.get(key)
  if (previous) { cache.bytes -= previous.value.bytes.byteLength; cache.entries.delete(key) }
  while (cache.entries.size >= MAX_CACHED_IMAGES || cache.bytes + value.bytes.byteLength > MAX_CACHED_IMAGE_BYTES) {
    const oldest = cache.entries.entries().next().value
    if (!oldest) break
    cache.bytes -= oldest[1].value.bytes.byteLength
    cache.entries.delete(oldest[0])
  }
  cache.entries.set(key, { generation, value }); cache.bytes += value.bytes.byteLength
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

const readSlots=new WeakMap<object,{active:number;waiting:Array<()=>void>}>()
async function withReadSlot<T>(reader:object,read:()=>Promise<T>):Promise<T>{
 let slots=readSlots.get(reader)
 if(!slots){slots={active:0,waiting:[]};readSlots.set(reader,slots)}
 if(slots.active>=3)await new Promise<void>(resolve=>slots!.waiting.push(resolve))
 else slots.active++
 try{return await read()}
 finally {const next=slots.waiting.shift();if(next)next();else slots.active--}
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
  const cache=readerCache(reader),generation=cacheGeneration
  const worker=async()=>{
    while(true){
      const chunk=[...batch.requests.keys()].filter(path=>!batch.inFlight.has(path)).slice(0,MAX_IMAGE_BATCH_SIZE)
      if(chunk.length===0)return
      for(const path of chunk)batch.inFlight.add(path)
      try {
        const loaded=await withReadSlot(reader,()=>readImagePaths(reader,batch.noteId,chunk))
        const loadedByPath=new Map(loaded.map(image=>[image.relativePath,image]))
        for(const path of chunk){
          const requests=batch.requests.get(path)??[],image=loadedByPath.get(path)
          if(!image){for(const request of requests)request.reject(new Error('Image asset was not returned'));continue}
          const value={mediaType:image.mediaType,bytes:image.bytes}
          cacheImage(cache,cacheKey(batch.noteId,path),value,generation)
          settleRequests(requests,value)
        }
      }catch(error){for(const path of chunk)for(const request of batch.requests.get(path)??[])request.reject(error)}
      for(const path of chunk){batch.requests.delete(path);batch.inFlight.delete(path)}
      if(batch.requests.size>0)await yieldToBrowser()
    }
  }
  try {do {await Promise.all([worker(),worker(),worker()])} while(batch.requests.size>0)}
  finally {pendingByReader.get(reader)?.delete(batchKey)}
}

export function readImageAsset(reader: ImageReadPort, noteId: NoteId, relativePath: string): Promise<LoadedImageAsset> {
  const key = cacheKey(noteId, relativePath)
  const cache = readerCache(reader)
  const cached = cache.entries.get(key)
  if (cached?.generation === cacheGeneration) {
    cache.entries.delete(key); cache.entries.set(key, cached)
    return Promise.resolve(cached.value)
  }

  let batches = pendingByReader.get(reader)
  if (batches === undefined) {
    batches = new Map()
    pendingByReader.set(reader, batches)
  }
  const batchKey = String(noteId)
  let batch = batches.get(batchKey)
  if (batch === undefined) {
    batch = { noteId, requests: new Map(), scheduled: false, inFlight: new Set() }
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
