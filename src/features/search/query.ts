export const MAX_TAG_LENGTH = 80
export const MAX_SEARCH_QUERY_LENGTH = 256

import type { SearchQuery } from '../../domain/ports'

export type { SearchQuery } from '../../domain/ports'

export class TagValidationError extends Error {
  constructor(readonly reason: 'empty' | 'control-character' | 'too-long') {
    super(reason)
    this.name = 'TagValidationError'
  }
}

export function normalizeTag(input: string): { display: string; normalized: string } {
  const display = normalizeDisplay(input)
  if (display.length === 0) throw new TagValidationError('empty')
  if (Array.from(display).length > MAX_TAG_LENGTH) throw new TagValidationError('too-long')
  return { display, normalized: applicationCaseFold(display) }
}

export function mergeTags(current: string[], additions: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const candidate of [...current, ...additions]) {
    const tag = normalizeTag(candidate)
    if (seen.has(tag.normalized)) continue
    seen.add(tag.normalized)
    result.push(tag.display)
  }
  return result
}

export function parseSearchQuery(input: string): SearchQuery {
  if (!input.normalize('NFKC').trimStart().startsWith('#')) {
    const text = normalizeTextQuery(input)
    if (text.kind === 'invalid') return text
    return { kind: 'text', value: text.value }
  }
  let value: string
  try {
    value = normalizeDisplay(input)
  } catch (error: unknown) {
    if (!(error instanceof TagValidationError)) throw error
    return { kind: 'invalid', reason: 'control-character' }
  }
  const keyword = normalizeDisplay(value.slice(1))
  if (keyword.trim().length === 0) return { kind: 'invalid', reason: 'empty-tag' }
  if (Array.from(keyword).length > MAX_SEARCH_QUERY_LENGTH) return { kind: 'invalid', reason: 'too-long' }
  return { kind: 'tag', value: applicationCaseFold(keyword) }
}

function normalizeTextQuery(input: string):
  | { kind: 'text'; value: string }
  | { kind: 'invalid'; reason: 'control-character' | 'too-long' } {
  const value = input.normalize('NFKC').trim()
  if (Array.from(value).some(isControl)) return { kind: 'invalid', reason: 'control-character' }
  if (Array.from(value).length > MAX_SEARCH_QUERY_LENGTH) return { kind: 'invalid', reason: 'too-long' }
  return { kind: 'text', value }
}

function normalizeDisplay(input: string) {
  const result: string[] = []
  let pendingSpace = false
  for (const character of input.normalize('NFKC')) {
    if (isApplicationWhitespace(character)) {
      pendingSpace = result.length > 0
      continue
    }
    if (isControl(character)) throw new TagValidationError('control-character')
    if (pendingSpace) result.push(' ')
    pendingSpace = false
    result.push(character)
  }
  return result.join('')
}

function applicationCaseFold(input: string) {
  return input
    .replace(/[ßẞ]/gu, 'SS')
    .toUpperCase()
    .toLowerCase()
    .replace(/ς/gu, 'σ')
    .normalize('NFKC')
}

function isApplicationWhitespace(character: string) {
  const codePoint = character.codePointAt(0)
  return codePoint !== undefined && (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  )
}

function isControl(character: string) {
  const codePoint = character.codePointAt(0)
  return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
}
