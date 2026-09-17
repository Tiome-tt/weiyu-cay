export interface DisposablePdfDocument {
  cleanup(): Promise<unknown>
}

export class PdfDocumentCache<T extends DisposablePdfDocument> {
  private readonly entries = new Map<string, T>()

  constructor(private readonly limit: number) {}

  get(key: string): T | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: T): void {
    const previous = this.entries.get(key)
    if (previous === value) return
    if (previous !== undefined) void this.dispose(previous)
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > Math.max(1, this.limit)) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      const evicted = this.entries.get(oldest)
      this.entries.delete(oldest)
      if (evicted !== undefined) void this.dispose(evicted)
    }
  }

  delete(key: string): void {
    const value = this.entries.get(key)
    if (value === undefined) return
    this.entries.delete(key)
    void this.dispose(value)
  }

  clear(): void {
    for (const value of this.entries.values()) void this.dispose(value)
    this.entries.clear()
  }

  private async dispose(value: T): Promise<void> {
    try {
      await value.cleanup()
    } catch {
      // Cache eviction must not surface as a viewer error.
    }
  }
}
