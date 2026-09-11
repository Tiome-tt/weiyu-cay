import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RichDocumentEditor } from './RichDocumentEditor'

beforeAll(() => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.tiptap') })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 10, 10) })
})
afterEach(cleanup)

describe('RichDocumentEditor attachment references', () => {
  it('navigates to the referenced library entry without opening an arbitrary path', async () => {
    const onNavigateEntry = vi.fn()
    render(<RichDocumentEditor
      value={{
        schemaVersion: 1,
        root: { type: 'doc', content: [{ type: 'attachment', attrs: {
          entryId: '019c0000-0000-7000-8000-000000000003',
          label: '设计稿',
          fileName: 'design.docx',
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        } }] },
      }}
      onChange={vi.fn()}
      onNavigateEntry={onNavigateEntry}
    />)
    await userEvent.setup().click(screen.getByRole('link', { name: /设计稿/ }))
    expect(onNavigateEntry).toHaveBeenCalledWith('019c0000-0000-7000-8000-000000000003')
  })
})
