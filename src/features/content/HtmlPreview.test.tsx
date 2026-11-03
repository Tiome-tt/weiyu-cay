import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { HtmlPreview } from './HtmlPreview'
import { note } from '../../test/fakes'
afterEach(cleanup)
it('loads HTML in a script-only sandbox without app-origin or navigation privileges', async () => {
  const createHtmlPreview = vi.fn().mockResolvedValue('http://cay-html.localhost/random-token')
  render(<HtmlPreview noteId={note('').id} revision={1} createPreview={createHtmlPreview}/>)
  const frame = await screen.findByTitle('HTML 网页预览')
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  expect(frame).toHaveAttribute('src', 'http://cay-html.localhost/random-token')
  expect(frame).not.toHaveAttribute('srcdoc')
})
