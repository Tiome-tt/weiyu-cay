import { describe, expect, it } from 'vitest'
import { toTiptapJson } from './schema'

describe('rich document schema safety', () => {
  it('rejects unknown durable attributes and unsafe resource URLs', () => {
    expect(() => toTiptapJson({
      schemaVersion: 1,
      root: { type: 'doc', content: [{ type: 'paragraph', attrs: { script: 'alert(1)' } }] },
    })).toThrow(/script/)
    expect(() => toTiptapJson({
      schemaVersion: 1,
      root: { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.com/tracker.png' } }] },
    })).toThrow(/image/i)
    expect(() => toTiptapJson({
      schemaVersion: 1,
      root: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
    })).toThrow(/link/i)
  })
})
