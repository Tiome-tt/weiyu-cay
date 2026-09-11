import { describe, expect, it } from 'vitest'
import { markdownToRichDocument } from './markdownConversion'

describe('Markdown managed-image conversion', () => {
  it('converts an existing ImagePort asset to a block image node', () => {
    const source = '![截图](assets/screenshot-019c0000-0000-7000-8000-000000000009.png)'
    expect(markdownToRichDocument(source).root.content).toEqual([{
      type: 'image',
      attrs: {
        alt: '截图',
        src: 'assets/screenshot-019c0000-0000-7000-8000-000000000009.png',
      },
    }])
  })

  it('preserves a non-managed image reference as raw Markdown', () => {
    const source = '![远程图](https://example.com/tracker.png)'
    expect(markdownToRichDocument(source).root.content).toEqual([{
      type: 'rawMarkdown', attrs: { source },
    }])
  })
})
