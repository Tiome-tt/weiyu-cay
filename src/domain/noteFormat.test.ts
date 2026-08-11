import { describe, expect, it } from 'vitest'
import linkContract from '../shared/internal-link-contract.json'
import { formatStoredLink, parseStoredLink } from './noteFormat'

const noteId = '019c0000-0000-7000-8000-000000000002'
const invalidNoteIds = [
  '019c0000-0000-4000-8000-000000000002',
  '019c0000-0000-1000-8000-000000000002',
  '019c0000-0000-7000-7000-000000000002',
  '019C0000-0000-7000-8000-000000000002',
]

describe('stored internal links', () => {
  it('matches the shared TypeScript/Rust escaping contract', () => {
    for (const vector of linkContract.valid) {
      expect(formatStoredLink(vector.title, linkContract.noteId)).toBe(vector.stored)
      expect(parseStoredLink(vector.stored)).toEqual({
        title: vector.title,
        noteId: linkContract.noteId,
      })
    }
    for (const invalid of linkContract.invalid) {
      expect(() => parseStoredLink(invalid)).toThrow('Invalid stored link')
    }
  })

  it('round-trips a Unicode title and immutable id', () => {
    expect(parseStoredLink(formatStoredLink('  用户认证  ', noteId))).toEqual({
      title: '用户认证',
      noteId,
    })
  })

  it.each(['', '   '])(
    'rejects the invalid link title %j',
    (title) => {
      expect(() => formatStoredLink(title, noteId)).toThrow('Invalid link title')
    },
  )

  it.each([
    'not-a-uuid',
    '019c0000-0000-7000-8000-00000000000z',
    '00000000-0000-0000-0000-0000000000000',
    ...invalidNoteIds,
  ])('rejects the invalid UUID %j', (id) => {
    expect(() => formatStoredLink('用户认证', id)).toThrow('Invalid note id')
  })

  it.each(['   ', '\t', 'line one\nline two', 'line one\r\nline two'])(
    'rejects the invalid title %j while parsing',
    (title) => {
      expect(() => parseStoredLink(`[[${title}|${noteId}]]`)).toThrow('Invalid stored link')
    },
  )

  it.each(['line one\nline two', 'line one\r\nline two'])(
    'rejects the multiline title %j while formatting',
    (title) => {
      expect(() => formatStoredLink(title, noteId)).toThrow('Invalid link title')
    },
  )

  it.each([
    `prefix [[用户认证|${noteId}]]`,
    `[[用户认证|${noteId}]] suffix`,
    `[[|${noteId}]]`,
    `[[用户|认证|${noteId}]]`,
    `[[用户认证|not-a-uuid]]`,
    ...invalidNoteIds.map((id) => `[[用户认证|${id}]]`),
  ])('rejects malformed or partial persisted input %j', (value) => {
    expect(() => parseStoredLink(value)).toThrow('Invalid stored link')
  })
})
