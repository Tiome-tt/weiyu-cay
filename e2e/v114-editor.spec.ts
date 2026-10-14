import { test, expect } from '@playwright/test'

test('keeps search at one quarter of the workspace height', async ({ page }) => {
  await page.goto('/e2e/v114-editor-fixture.html?mode=search')
  const box = await page.getByRole('dialog', { name: '搜索资料库' }).boundingBox()
  expect(box?.y).toBeCloseTo(30 + (720 - 30) / 4, 0)
  await page.setViewportSize({ width: 800, height: 420 })
  await page.getByRole('searchbox', { name: '搜索资料库' }).fill('文件夹')
  await expect(page.getByRole('option')).toHaveCount(30)
  const shortBox = (await page.getByRole('dialog', { name: '搜索资料库' }).boundingBox())!
  expect(shortBox.y).toBeCloseTo(30 + (420 - 30) / 4, 0)
  expect(shortBox.y + shortBox.height).toBeLessThanOrEqual(420)
})

test('AI panel covers the collapsed document toolbar', async ({ page }) => {
  await page.goto('/e2e/v114-editor-fixture.html?mode=ai')
  const toggle = page.locator('.rich-document__toolbar-toggle')
  await toggle.click()
  await page.locator('.rich-document').evaluate(element => { element.parentElement!.style.paddingTop = '0' })
  await page.getByRole('button', { name: '打开 AI 总结' }).click()
  await expect(page.locator('.ai-summary-widget')).toHaveClass(/--open/)
  expect(await toggle.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.ai-summary-widget') !== null
  })).toBe(true)
})

test('drags from cell text, pastes a matrix, and reveals keyboard destinations', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto('/e2e/v114-editor-fixture.html')
  const first = page.getByRole('textbox', { name: '2 行 1 列', exact: true })
  const last = page.getByRole('textbox', { name: '3 行 2 列', exact: true })
  const a = (await first.boundingBox())!, b = (await last.boundingBox())!
  await page.mouse.move(a.x + 15, a.y + 12)
  await page.mouse.down()
  await page.mouse.move(b.x + 15, b.y + 12, { steps: 10 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: '合并单元格' })).toBeEnabled()
  await first.evaluate(element => element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: (() => { const data = new DataTransfer(); data.setData('text/plain', 'x\ty\nz\tw'); return data })() })))
  await expect(first).toHaveValue('x')
  await expect(last).toHaveValue('w')
  await first.click()
  for (let i = 0; i < 11; i++) await page.keyboard.press('Tab')
  const target = page.getByRole('textbox', { name: '2 行 12 列', exact: true })
  await expect(target).toBeFocused()
  const box = (await target.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(800)
  for (let i = 0; i < 20; i++) await page.keyboard.press('Enter')
  const lower = page.getByRole('textbox', { name: '22 行 12 列', exact: true })
  await expect(lower).toBeFocused()
  const lowerBox = (await lower.boundingBox())!
  expect(lowerBox.y).toBeGreaterThanOrEqual(0)
  expect(lowerBox.y + lowerBox.height).toBeLessThanOrEqual(600)
})
