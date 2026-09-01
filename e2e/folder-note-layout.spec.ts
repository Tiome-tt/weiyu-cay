import { expect, test } from '@playwright/test'

test('folder notes flow naturally and only the full tree scrolls', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('treeitem', { name: '项目', exact: true }).click()
  const items = page.locator('.folder-tree__folder-notes .note-list__items').first()
  await expect(items.locator('.note-card').first()).toBeVisible()
  const overflow = await items.evaluate((element) => getComputedStyle(element).overflowY)
  expect(overflow).toBe('visible')
  // Stress the actual folder CSS with enough rows to exceed the old 260/340px caps.
  await items.evaluate((element) => {
    const row = element.firstElementChild!
    for (let index = 0; index < 60; index += 1) element.append(row.cloneNode(true))
  })
  const bounds = await items.evaluate((element) => ({ height: element.clientHeight, lastRowBottom: element.lastElementChild!.getBoundingClientRect().bottom, bottom: element.getBoundingClientRect().bottom, parent: element.closest('.folder-tree__folder-notes')!.clientHeight }))
  expect(bounds.height).toBeGreaterThan(1000)
  expect(bounds.lastRowBottom).toBeLessThanOrEqual(bounds.bottom)
  expect(bounds.parent).toBeGreaterThanOrEqual(bounds.height)
  const tree = page.locator('.folder-tree__list').first()
  expect(await tree.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
})

