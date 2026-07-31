const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const storedLink = /^\[\[([^\]|]+)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]$/i

export function formatStoredLink(title: string, noteId: string): string {
  const normalizedTitle = title.trim()
  if (!normalizedTitle || title.includes(']]') || title.includes('|')) {
    throw new Error('Invalid link title')
  }
  if (!canonicalUuid.test(noteId)) throw new Error('Invalid note id')
  return `[[${normalizedTitle}|${noteId}]]`
}

export function parseStoredLink(value: string): { title: string; noteId: string } {
  const match = storedLink.exec(value)
  if (!match) throw new Error('Invalid stored link')
  return { title: match[1], noteId: match[2] }
}
