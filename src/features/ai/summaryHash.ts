/** Hash only the note text. This is a local freshness marker, never a server identifier. */
export async function noteContentHash(markdown: string): Promise<string | undefined> {
  if (globalThis.crypto?.subtle === undefined) return undefined
  try {
    const bytes = new TextEncoder().encode(markdown)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}