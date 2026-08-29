import { describe, expect, it } from 'vitest'
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import {
  analyzeLiveMarkdown,
  classifyDocumentLine,
  isLiveNodeActive,
  visibleDocumentLineNumbers,
  type LiveMarkdownNode,
} from './documentMarkdown'

describe('document Markdown line classification', () => {
  it.each([
    ['# 一级标题', false, { kind: 'heading', level: 1, nextInFence: false, hiddenPrefixLength: 2 }],
    ['### 三级标题', false, { kind: 'heading', level: 3, nextInFence: false, hiddenPrefixLength: 4 }],
    ['> 引用', false, { kind: 'quote', level: null, nextInFence: false, hiddenPrefixLength: 2 }],
    ['- [ ] 待办', false, { kind: 'task', level: null, nextInFence: false, hiddenPrefixLength: 6 }],
    ['* 普通列表', false, { kind: 'list', level: null, nextInFence: false, hiddenPrefixLength: 2 }],
    ['12. 有序列表', false, { kind: 'list', level: null, nextInFence: false, hiddenPrefixLength: 4 }],
    ['---', false, { kind: 'divider', level: null, nextInFence: false, hiddenPrefixLength: 0 }],
    ['普通段落', false, { kind: 'paragraph', level: null, nextInFence: false, hiddenPrefixLength: 0 }],
  ] as const)('classifies %s without changing the source', (text, inFence, expected) => {
    expect(classifyDocumentLine(text, inFence)).toEqual(expected)
  })

  it('tracks fenced code so Markdown-looking content stays code', () => {
    expect(classifyDocumentLine('```ts', false)).toEqual({
      kind: 'code-fence', level: null, nextInFence: true, hiddenPrefixLength: 0,
    })
    expect(classifyDocumentLine('# not a heading', true)).toEqual({
      kind: 'code', level: null, nextInFence: true, hiddenPrefixLength: 0,
    })
    expect(classifyDocumentLine('```', true)).toEqual({
      kind: 'code-fence', level: null, nextInFence: false, hiddenPrefixLength: 0,
    })
  })
})

describe('live Markdown syntax model', () => {
  function analyze(source: string, from = 0, to = source.length) {
    const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] })
    return analyzeLiveMarkdown(state, [{ from, to }])
  }

  it.each([
    ['**bold**', { kind: 'strong', from: 0, to: 8, contentFrom: 2, contentTo: 6 }],
    ['*em*', { kind: 'emphasis', from: 0, to: 4, contentFrom: 1, contentTo: 3 }],
    ['~~gone~~', { kind: 'strikethrough', from: 0, to: 8, contentFrom: 2, contentTo: 6 }],
    ['`code`', { kind: 'inline-code', from: 0, to: 6, contentFrom: 1, contentTo: 5 }],
  ] as const)('maps %s to its literal content range', (source, expected) => {
    expect(analyze(source)).toContainEqual(expect.objectContaining(expected))
  })

  it('maps a standard link without treating its destination as visible content', () => {
    expect(analyze('[site](https://x.test)')).toContainEqual(expect.objectContaining({
      kind: 'link',
      from: 0,
      to: 22,
      contentFrom: 1,
      contentTo: 5,
      metadata: { href: 'https://x.test' },
    }))
  })

  it('maps complete block widgets and leaves unsafe or malformed blocks alone', () => {
    expect(analyze('- [ ] task')).toContainEqual(expect.objectContaining({
      kind: 'task-marker', from: 2, to: 5, blockFrom: 0, blockTo: 10,
    }))
    expect(analyze('---')).toContainEqual(expect.objectContaining({
      kind: 'divider', from: 0, to: 3, blockFrom: 0, blockTo: 3,
    }))
    expect(analyze('```ts\nx\n```')).toContainEqual(expect.objectContaining({
      kind: 'fenced-code', from: 0, to: 11, contentFrom: 6, contentTo: 7,
      metadata: { language: 'ts' },
    }))
    expect(analyze('![Alt](assets/x.png)')).toContainEqual(expect.objectContaining({
      kind: 'image', from: 0, to: 20, contentFrom: 2, contentTo: 5,
      metadata: { alt: 'Alt', relativePath: 'assets/x.png' },
    }))
    expect(analyze('| A | B |\n| - | - |\n| 1 | 2 |')).toContainEqual(expect.objectContaining({
      kind: 'table', from: 0, to: 29, blockFrom: 0, blockTo: 29,
    }))
    expect(analyze('<img src="assets/x.png">')).toEqual([])
    expect(analyze('| A | B |\n| not a separator |')).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'table' }),
    ]))
  })

  it('recognizes a table immediately following a paragraph so document mode can hide its Markdown source', () => {
    const source = [
      '1',
      '| 列 1 | 列 2 | 列 3 |',
      '| --- | --- | --- |',
      '| 内容 1-1 | 内容 1-2 | 内容 1-3 |',
      '<!-- cay-table: {"merges":[]} -->',
    ].join('\n')

    expect(analyze(source)).toContainEqual(expect.objectContaining({
      kind: 'table',
      from: source.indexOf('| 列 1'),
    }))
  })

  it('does not report syntax wholly outside the requested viewport', () => {
    const source = '# A\n\n**b**'
    expect(analyze(source, 5, 10)).toEqual([
      expect.objectContaining({ kind: 'strong', from: 5, to: 10 }),
    ])
  })

  it('activates a node only when the selection touches its source range', () => {
    const node = {
      kind: 'strong', from: 3, to: 11, contentFrom: 5, contentTo: 9, blockFrom: 3, blockTo: 11,
    } as LiveMarkdownNode
    expect(isLiveNodeActive(node, EditorSelection.range(6, 6))).toBe(true)
    expect(isLiveNodeActive(node, EditorSelection.range(0, 2))).toBe(false)
  })

  it('keeps table widgets rendered while the source selection is inside the table', () => {
    const node = {
      kind: 'table', from: 10, to: 40, contentFrom: 10, contentTo: 40, blockFrom: 10, blockTo: 40,
    } as LiveMarkdownNode
    expect(isLiveNodeActive(node, EditorSelection.range(20, 20))).toBe(false)
  })

  it('limits line decoration work to the viewport plus the active line', () => {
    const source = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n')
    const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] })
    const visible = state.doc.line(50)

    expect(visibleDocumentLineNumbers(state, [{ from: visible.from, to: visible.to }], 1)).toEqual([1, 50])
  })
})
