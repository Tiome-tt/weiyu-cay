import { isCanonicalUuidV7 } from './ids'
import type { NoteId } from './model'

const escapableLabelCharacters = new Set(['\\', '|', '[', ']'])

function isValidLinkTitle(title: string): boolean {
  return Boolean(title.trim()) && !/[\r\n]/.test(title)
}

export function formatStoredLink(title: string, noteId: string): string {
  const normalizedTitle = title.trim()
  if (!isValidLinkTitle(title)) throw new Error('Invalid link title')
  if (!isCanonicalUuidV7(noteId)) throw new Error('Invalid note id')
  return `[[${escapeInternalLinkLabel(normalizedTitle)}|${noteId}]]`
}

export function parseStoredLink(value: string): { title: string; noteId: NoteId } {
  if (!value.startsWith('[[') || !value.endsWith(']]')) throw new Error('Invalid stored link')
  const content = value.slice(2, -2)
  const separator = findUnescapedSeparator(content)
  if (separator < 0) throw new Error('Invalid stored link')
  const title = unescapeInternalLinkLabel(content.slice(0, separator))
  const noteId = content.slice(separator + 1)
  if (title === null || !isValidLinkTitle(title) || !isCanonicalUuidV7(noteId)) {
    throw new Error('Invalid stored link')
  }
  return { title, noteId: noteId as NoteId }
}

export function escapeInternalLinkLabel(label: string): string {
  let escaped = ''
  for (const character of label) {
    escaped += escapableLabelCharacters.has(character) ? `\\${character}` : character
  }
  return escaped
}

export function unescapeInternalLinkLabel(raw: string): string | null {
  if (raw.length === 0) return null
  let label = ''
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character === '\\') {
      const escaped = raw[index + 1]
      if (escaped === undefined || !escapableLabelCharacters.has(escaped)) return null
      label += escaped
      index += 1
      continue
    }
    if (escapableLabelCharacters.has(character) || character === '\r' || character === '\n') return null
    label += character
  }
  return label.length > 0 ? label : null
}

function findUnescapedSeparator(content: string): number {
  let separator = -1
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (character === '\\') {
      const escaped = content[index + 1]
      if (escaped === undefined || !escapableLabelCharacters.has(escaped)) return -1
      index += 1
      continue
    }
    if (character !== '|') continue
    if (separator >= 0) return -1
    separator = index
  }
  return separator
}
