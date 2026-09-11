import { expect, it, vi } from 'vitest'
import { docxToRichDocument, materializeDocumentImages } from './officeConversion'
import type { NoteId } from '../../domain/model'

const convertToHtml = vi.hoisted(() => vi.fn())
vi.mock('mammoth', () => ({ default: { convertToHtml } }))

it('maps common Word blocks and inline marks into the document schema', async () => {
  convertToHtml.mockResolvedValue({
    value: '<h1>会议纪要</h1><p><strong>重点</strong> 内容</p><table><tr><th>列</th><td>值</td></tr></table>',
    messages: [],
  })
  const document = await docxToRichDocument(new Uint8Array([1, 2, 3]))
  expect(document.root.content).toEqual([
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '会议纪要' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '重点', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' 内容' },
      ],
    },
    {
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '列' }] }] },
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '值' }] }] },
        ],
      }],
    },
  ])
  expect(convertToHtml).toHaveBeenCalledWith({ arrayBuffer: expect.any(ArrayBuffer) })
})

it('preserves embedded images and table spans until assets are materialized', async () => {
  convertToHtml.mockResolvedValue({
    value: '<table><thead><tr><th colspan="2">列</th></tr></thead><tbody><tr><td rowspan="2"><img src="data:image/png;base64,AQID" alt="截图"></td><td>值</td></tr><tr><td>第二行</td></tr></tbody></table>',
    messages: [],
  })
  const parsed = await docxToRichDocument(new Uint8Array([1]))
  const table = parsed.root.content?.[0]
  expect(table?.content?.[0]?.content?.[0]?.attrs).toMatchObject({ colspan: 2 })
  expect(table?.content?.[1]?.content?.[0]?.attrs).toMatchObject({ rowspan: 2 })
  expect(table?.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]).toMatchObject({
    type: 'image',
    attrs: { src: 'data:image/png;base64,AQID', alt: '截图' },
  })

  const saveImage = vi.fn().mockResolvedValue({ relativePath: 'assets/截图.png', width: 1, height: 1 })
  const materialized = await materializeDocumentImages(parsed, '019c0000-0000-7000-8000-000000000001' as NoteId, { saveImage })
  expect(saveImage).toHaveBeenCalledWith({ noteId: expect.any(String), mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) })
  expect(JSON.stringify(materialized)).toContain('assets/截图.png')
})

it('rejects Mammoth conversion errors instead of returning partial content', async () => {
  convertToHtml.mockResolvedValue({ value: '<p>partial</p>', messages: [{ type: 'error', message: 'broken relationship' }] })
  await expect(docxToRichDocument(new Uint8Array([1]))).rejects.toThrow('Word 文档转换失败')
})

it('keeps Word table widths and inline CSS emphasis', async () => {
  convertToHtml.mockResolvedValue({
    value: '<table><colgroup><col style="width:120px"><col style="width:240px"></colgroup><tr><td style="text-align:center;background-color:#e1f1e9"><span style="font-weight:700;text-decoration:underline">重点</span></td><td>内容</td></tr></table>',
    messages: [],
  })
  const document = await docxToRichDocument(new Uint8Array([1]))
  const cell = document.root.content?.[0]?.content?.[0]?.content?.[0]
  expect(cell?.attrs).toMatchObject({ colwidth: [120], textAlign: 'center', backgroundColor: 'green' })
  expect(cell?.content?.[0]?.content?.[0]).toMatchObject({ text: '重点', marks: [{ type: 'bold' }, { type: 'underline' }] })
})
