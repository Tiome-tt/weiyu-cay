import { test, expect } from '@playwright/test'
import type { Editor } from '@tiptap/core'
test('AUDIT active Markdown cell input becomes durable editor draft without blur', async ({ page }) => {
  await page.goto('/docs/reviews/2026-10-11-table-audit/fixture.html')
  await page.getByRole('textbox', { name: '2 行 1 列', exact: true }).fill('unsaved draft')
  await expect(page.getByTestId('saved-markdown')).toContainText('unsaved draft', { timeout: 1500 })
})
test('AUDIT mouse-selected rich rectangle accepts TSV without nesting', async ({ page }) => {
  await page.goto('/docs/reviews/2026-10-11-table-audit/fixture.html?rich')
  await page.locator('.tiptap td p').first().click()
  const cells = page.locator('.tiptap td'), a = (await cells.nth(0).boundingBox())!, b = (await cells.nth(4).boundingBox())!
  await page.mouse.move(a.x + 60, a.y + a.height / 2); await page.mouse.down()
  await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 12 }); await page.mouse.up()
  console.log('AUDIT rich drag state:', await page.locator('.tiptap').evaluate(element => ({selection: (element as HTMLElement & {editor: Editor}).editor.state.selection.toJSON(), text: window.getSelection()?.toString(), active: document.activeElement?.className})))
  await page.screenshot({ path: 'test-results/table-audit-rich-drag.png' })
  await expect(page.locator('.tiptap .selectedCell')).toHaveCount(4)
  await cells.nth(0).evaluate(element => element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: (() => { const data = new DataTransfer(); data.setData('text/plain', 'x\ty\nz\tw'); return data })() })))
  console.log('AUDIT rich rectangle after TSV:', await page.locator('.tiptap td').allTextContents())
  await expect(page.locator('.tiptap table')).toHaveCount(1, { timeout: 1500 })
  await expect(cells.nth(0)).toHaveText('x', { timeout: 1500 })
  await expect(cells.nth(1)).toHaveText('y', { timeout: 1500 })
  await expect(cells.nth(3)).toHaveText('z', { timeout: 1500 })
  await expect(cells.nth(4)).toHaveText('w', { timeout: 1500 })
})
test('AUDIT rich cell allows selecting a substring with mouse', async ({ page }) => {
  await page.goto('/docs/reviews/2026-10-11-table-audit/fixture.html?rich')
  await page.locator('.tiptap td p').first().click()
  const first = page.locator('.tiptap td p').first(), box = (await first.boundingBox())!
  await page.mouse.move(box.x + 30, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 8 }); await page.mouse.up()
  const selection = await page.evaluate(() => window.getSelection()?.toString())
  console.log('AUDIT rich substring selection:', JSON.stringify(selection), 'selected cells:', await page.locator('.tiptap .selectedCell').count())
  expect(selection?.length).toBeGreaterThan(0)
  expect(selection?.length).toBeLessThan('selectable cell 0-0'.length)
})
test('AUDIT Markdown medium matrix paste latency', async ({ page }) => {
  await page.goto('/docs/reviews/2026-10-11-table-audit/fixture.html')
  const input = page.getByRole('textbox', { name: '2 行 1 列', exact: true })
  const elapsed = await input.evaluate(element => {
    const data = new DataTransfer(); data.setData('text/plain', Array.from({ length: 200 }, (_, r) => Array.from({ length: 20 }, (_, c) => `${r}:${c}`).join('\t')).join('\n'))
    const start = performance.now()
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    return performance.now() - start
  })
  console.log('AUDIT Markdown 200x20 synchronous paste ms:', elapsed)
  await expect(page.getByRole('textbox', { name: '201 行 20 列', exact: true })).toHaveValue('199:19')
})
test('AUDIT actual rich clipboard paste handles CellSelection', async ({ page }) => {
  await page.goto('/docs/reviews/2026-10-11-table-audit/fixture.html?rich')
  await page.locator('.tiptap').evaluate(element => {
    const editor = (element as HTMLElement & {editor: Editor}).editor
    const cells: number[] = []
    editor.state.doc.descendants((node, position) => { if (node.type.name === 'tableCell') cells.push(position) })
    editor.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[4] })
    editor.commands.focus()
  })
  await expect(page.locator('.selectedCell')).toHaveCount(4)
  await page.locator('.tiptap').evaluate(element => element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: (() => { const data = new DataTransfer(); data.setData('text/plain', 'x\ty\nz\tw'); return data })() })))
  const values = await page.locator('.tiptap td').allTextContents()
  console.log('AUDIT rich selected clipboard cells:', values)
  expect([values[0], values[1], values[3], values[4]]).toEqual(['x','y','z','w'])
})
