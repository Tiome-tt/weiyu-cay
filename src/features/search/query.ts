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
  const display = input.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (display.length === 0) throw new TagValidationError('empty')
  if (Array.from(display).some((character) => isControl(character))) {
    throw new TagValidationError('control-character')
  }
  if (Array.from(display).length > MAX_TAG_LENGTH) throw new TagValidationError('too-long')
  return { display, normalized: display.toLowerCase() }
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
  const value = input.normalize('NFKC').trim()
  if (Array.from(value).some((character) => isControl(character))) {
    return { kind: 'invalid', reason: 'control-character' }
  }
  if (!value.startsWith('#')) {
    return Array.from(value).length > MAX_SEARCH_QUERY_LENGTH
      ? { kind: 'invalid', reason: 'too-long' }
      : { kind: 'text', value }
  }
  const keyword = value.slice(1).trim().replace(/\s+/gu, ' ')
  if (keyword.trim().length === 0) return { kind: 'invalid', reason: 'empty-tag' }
  if (Array.from(keyword).length > MAX_SEARCH_QUERY_LENGTH) return { kind: 'invalid', reason: 'too-long' }
  return { kind: 'tag', value: keyword.toLowerCase() }
}

function isControl(character: string) {
  const codePoint = character.codePointAt(0)
  return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
}
