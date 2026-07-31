import { describe, expect, it } from 'vitest'
import { mergeTags, normalizeTag, parseSearchQuery, TagValidationError } from './query'

describe('tag normalization', () => {
  it.each([
    ['  TypeScript\t rules  ', { display: 'TypeScript rules', normalized: 'typescript rules' }],
    ['Ｆｕｌｌｗｉｄｔｈ', { display: 'Fullwidth', normalized: 'fullwidth' }],
    [' 后端 ', { display: '后端', normalized: '后端' }],
  ])('normalizes %s consistently', (input, expected) => {
    expect(normalizeTag(input)).toEqual(expected)
  })

  it('preserves order and the first display spelling when merging duplicates', () => {
    expect(mergeTags(['TypeScript', ' 后端 '], [' typescript ', '后端', 'Desktop'])).toEqual([
      'TypeScript',
      '后端',
      'Desktop',
    ])
  })

  it.each(['', '   ', 'bad\u0000tag', `${'a'.repeat(80)}b`])('rejects invalid tag %j', (input) => {
    expect(() => normalizeTag(input)).toThrow(TagValidationError)
  })

  it('accepts the 80-character tag boundary', () => {
    expect(normalizeTag('a'.repeat(80)).display).toHaveLength(80)
  })
})

describe('search query parsing', () => {
  it.each([
    [' #后端 ', { kind: 'tag', value: '后端' }],
    ['# TypeScript ', { kind: 'tag', value: 'typescript' }],
    ['登录 #flow', { kind: 'text', value: '登录 #flow' }],
    ['  登录 flow  ', { kind: 'text', value: '登录 flow' }],
  ] as const)('parses %s', (input, expected) => {
    expect(parseSearchQuery(input)).toEqual(expected)
  })

  it.each(['#', '#   '])('returns typed guidance for bare tag query %j', (input) => {
    expect(parseSearchQuery(input)).toEqual({ kind: 'invalid', reason: 'empty-tag' })
  })

  it('rejects control characters and overlong search input without producing a query', () => {
    expect(parseSearchQuery('#bad\u0007')).toEqual({ kind: 'invalid', reason: 'control-character' })
    expect(parseSearchQuery(`#${'a'.repeat(257)}`)).toEqual({ kind: 'invalid', reason: 'too-long' })
  })

  it('accepts a 256-character tag keyword boundary', () => {
    const value = 'a'.repeat(256)
    expect(parseSearchQuery(`#${value}`)).toEqual({ kind: 'tag', value })
  })

  it.each([
    ['Straße', 'Straße', 'strasse'],
    ['STRASSE', 'STRASSE', 'strasse'],
    ['ΟΣ', 'ΟΣ', 'οσ'],
    ['ος', 'ος', 'οσ'],
    ['Ａ\u0085 B\uFEFF中 文', 'A B 中 文', 'a b 中 文'],
  ])('uses the shared application case fold for %s', (input, display, normalized) => {
    expect(normalizeTag(input)).toEqual({ display, normalized })
  })

  it('merges sharp-s and Greek final-sigma case variants by the shared fold', () => {
    expect(mergeTags(['Straße', 'ΟΣ'], ['STRASSE', 'ος'])).toEqual(['Straße', 'ΟΣ'])
  })

  it('rejects an actual C1 control character that is not explicit whitespace', () => {
    expect(() => normalizeTag(`bad${String.fromCharCode(0x9f)}tag`)).toThrow(TagValidationError)
    expect(parseSearchQuery(`#bad${String.fromCharCode(0x9f)}`)).toEqual({ kind: 'invalid', reason: 'control-character' })
  })
})
