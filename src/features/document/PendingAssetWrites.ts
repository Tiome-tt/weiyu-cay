const SAFE_MESSAGE = '图片保存失败，请重试。'

/** Tracks editor-owned asset writes so lifecycle barriers cannot race them. */
export class PendingAssetWrites {
  readonly #pending = new Set<Promise<void>>()
  readonly #failures: Error[] = []

  constructor(private readonly onFailure?: (message: string) => void) {}

  track(work: Promise<unknown>): void {
    const tracked = work.then(
      () => undefined,
      () => {
        this.#failures.push(new Error(SAFE_MESSAGE))
        this.onFailure?.(SAFE_MESSAGE)
      },
    ).finally(() => this.#pending.delete(tracked))
    this.#pending.add(tracked)
  }

  async settle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending])
    const failure = this.#failures.shift()
    if (failure) throw failure
  }
}
