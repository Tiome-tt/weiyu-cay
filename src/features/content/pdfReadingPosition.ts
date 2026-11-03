import type { NoteId } from '../../domain/model'
import type { PdfReadingPosition, WindowPreferencePort } from '../../domain/ports'

export const PDF_SCALE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const

export function normalizePdfReadingPosition(value: unknown): PdfReadingPosition {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const offset = (input: unknown) => typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : 0
  return {
    page: typeof record.page === 'number' && Number.isSafeInteger(record.page) && record.page > 0 ? record.page : 1,
    scale: PDF_SCALE_STEPS.find(scale => scale === record.scale) ?? 1,
    scrollTop: offset(record.scrollTop),
    scrollLeft: offset(record.scrollLeft),
  }
}

class PdfReadingPositionStore {
  private readonly cache = new Map<NoteId, PdfReadingPosition>()
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly preferences: WindowPreferencePort) {}

  async load(id: NoteId): Promise<PdfReadingPosition> {
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached
    const value = await this.preferences.getWindowPreference(`pdf-reading:${id}`)
    // A slow startup read must never replace a position saved during that read.
    const position = this.cache.get(id) ?? normalizePdfReadingPosition(value)
    this.remember(id, position)
    return position
  }

  save(id: NoteId, position: PdfReadingPosition): Promise<void> {
    const snapshot = { ...position }
    this.remember(id, snapshot)
    const write = this.writes.catch(() => undefined).then(async () => {
      // Coalesce scroll events queued behind a disk write, preserving the latest.
      if (this.cache.get(id) !== snapshot) return
      await this.preferences.setWindowPreference(`pdf-reading:${id}`, snapshot)
    })
    this.writes = write
    return write
  }

  flush(): Promise<void> { return this.writes }

  private remember(id: NoteId, position: PdfReadingPosition): void {
    this.cache.delete(id)
    this.cache.set(id, position)
    if (this.cache.size > 128) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
  }
}

const stores = new WeakMap<WindowPreferencePort, PdfReadingPositionStore>()
export function pdfReadingPositionStore(preferences: WindowPreferencePort): PdfReadingPositionStore {
  let store = stores.get(preferences)
  if (store === undefined) {
    store = new PdfReadingPositionStore(preferences)
    stores.set(preferences, store)
  }
  return store
}
