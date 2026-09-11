import { describe, expect, it } from 'vitest'
import type { RichDocument } from '../../domain/content'
import {
  documentOutline,
  documentPlainText,
  fromTiptapJson,
  parseTsv,
  toTiptapJson,
} from './schema'

const richDocument: RichDocument = {
  schemaVersion: 1,
  root: {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2, textAlign: 'center' },
        content: [{ type: 'text', text: '项目概览', marks: [{ type: 'highlight', attrs: { color: 'yellow' } }] }],
      },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '参见 ' },
          { type: 'internalLink', attrs: { noteId: '019c0000-0000-7000-8000-000000000002', label: '认证流程' } },
        ],
      },
      {
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              attrs: { colspan: 2, rowspan: 1, colwidth: [180, 220], backgroundColor: 'green', textAlign: 'right' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '进度' }] }],
            },
          ],
        }],
      },
      { type: 'rawMarkdown', attrs: { source: ':::unknown\n保留原文\n:::' } },
    ],
  },
}

describe('rich document schema adapter', () => {
  it('round trips supported structure without adding editor-only attributes', () => {
    expect(fromTiptapJson(toTiptapJson(richDocument))).toEqual(richDocument)
  })

  it('rejects unsupported nodes instead of silently dropping content', () => {
    expect(() => toTiptapJson({
      schemaVersion: 1,
      root: { type: 'doc', content: [{ type: 'video', attrs: { src: 'lost.mp4' } }] },
    })).toThrow(/video/)
  })

  it('drops invalid legacy table width hints while retaining cell content', () => {
    const migrated = fromTiptapJson(toTiptapJson({
      schemaVersion: 1,
      root: {
        type: 'doc',
        content: [{
          type: 'table',
          content: [{
            type: 'tableRow',
            content: [{
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: [null] },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '保留内容' }] }],
            }],
          }],
        }],
      },
    } as RichDocument))
    const cell = migrated.root.content?.[0]?.content?.[0]?.content?.[0]
    expect(cell?.attrs?.colwidth).toBeUndefined()
    expect(cell?.content?.[0]?.content?.[0]?.text).toBe('保留内容')
  })

  it('drops scalar, fractional, and mismatched width hints accepted by older editors', () => {
    const migrated = fromTiptapJson(toTiptapJson({
      schemaVersion: 1,
      root: {
        type: 'doc',
        content: [{
          type: 'table',
          content: [{
            type: 'tableRow',
            content: [
              { type: 'tableCell', attrs: { colspan: 1, colwidth: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '一' }] }] },
              { type: 'tableCell', attrs: { colspan: 1, colwidth: [120.5] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '二' }] }] },
              { type: 'tableCell', attrs: { colspan: 2, colwidth: [120] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '三' }] }] },
            ],
          }],
        }],
      },
    } as RichDocument))
    const cells = migrated.root.content?.[0]?.content?.[0]?.content ?? []
    expect(cells).toHaveLength(3)
    expect(cells.every((cell) => cell.attrs?.colwidth === undefined)).toBe(true)
  })

  it('projects readable text, internal-link labels, and heading positions', () => {
    expect(documentPlainText(richDocument)).toContain('参见 认证流程')
    expect(documentPlainText(richDocument)).toContain('保留原文')
    expect(documentOutline(richDocument)).toEqual([{ level: 2, text: '项目概览', index: 0 }])
  })
})

describe('TSV parsing', () => {
  it('preserves Chinese text, quoted tabs, and trailing empty cells', () => {
    expect(parseTsv('姓名\t说明\t\n小屿\t"含\t制表符"\t')).toEqual([
      ['姓名', '说明', ''],
      ['小屿', '含\t制表符', ''],
    ])
  })
})
