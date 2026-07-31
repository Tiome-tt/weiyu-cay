import { describe, expect, it } from 'vitest'
import { formatStoredLink, parseStoredLink } from './noteFormat'

const noteId = '019c0000-0000-7000-8000-000000000002'

describe('stored internal links', () => {
  it('round-trips a Unicode title and immutable id', () => {
    expect(parseStoredLink(formatStoredLink('  用户认证  ', noteId))).toEqual({
      title: '用户认证',
      noteId,
    })
  })

  it.each(['', '   ', 'bad|label', 'bad]]label'])(
    'rejects the invalid link title %j',
    (title) => {
      expect(() => formatStoredLink(title, noteId)).toThrow('Invalid link title')
    },
  )

  it.each([
    'not-a-uuid',
    '019c0000-0000-7000-8000-00000000000z',
    '00000000-0000-0000-0000-0000000000000',
  ])('rejects the invalid UUID %j', (id) => {
    expect(() => formatStoredLink('用户认证', id)).toThrow('Invalid note id')
  })

  it.each([
    `prefix [[用户认证|${noteId}]]`,
    `[[用户认证|${noteId}]] suffix`,
    `[[|${noteId}]]`,
    `[[用户|认证|${noteId}]]`,
    `[[用户认证|not-a-uuid]]`,
    `[[用户认证|${noteId.toUpperCase()}]] trailing`,
  ])('rejects malformed or partial persisted input %j', (value) => {
    expect(() => parseStoredLink(value)).toThrow('Invalid stored link')
  })
})
