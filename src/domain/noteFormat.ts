import { isCanonicalUuidV7 } from './ids'
import type { NoteId } from './model'

const storedLink = /^\[\[([^\]|]+)\|([^\]|]+)\]\]$/

function isValidLinkTitle(title: string): boolean {
  return Boolean(title.trim()) && !title.includes('|') && !title.includes(']]') && !/[\r\n]/.test(title)
}

export function formatStoredLink(title: string, noteId: string): string {
  const normalizedTitle = title.trim()
  if (!isValidLinkTitle(title)) throw new Error('Invalid link title')
  if (!isCanonicalUuidV7(noteId)) throw new Error('Invalid note id')
  return `[[${normalizedTitle}|${noteId}]]`
}

export function parseStoredLink(value: string): { title: string; noteId: NoteId } {
  const match = storedLink.exec(value)
  if (!match || !isValidLinkTitle(match[1]) || !isCanonicalUuidV7(match[2])) {
    throw new Error('Invalid stored link')
  }
  return { title: match[1], noteId: match[2] as NoteId }
}
