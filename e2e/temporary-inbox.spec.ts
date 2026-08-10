import { expect, test } from '@playwright/test'

test('multi-selects temporary captures, deletes, undoes, and converts them', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('treeitem', { name: '临时收集箱' }).click()
  await expect(page.getByRole('checkbox')).toHaveCount(2)
  await page.getByRole('button', { name: '全选' }).click()
  await page.getByRole('button', { name: '删除所选' }).click()
  await expect(page.getByText('临时收集箱为空。')).toBeVisible()
  await page.getByRole('button', { name: '撤销删除' }).click()
  await expect(page.getByRole('checkbox')).toHaveCount(2)

  await page.getByRole('button', { name: '全选' }).click()
  await page.getByRole('button', { name: '转为笔记' }).click()
  await expect(page.getByRole('dialog', { name: '转为笔记' })).toBeVisible()
  await page.getByRole('button', { name: '确认转换' }).click()
  await expect(page.getByText('临时收集箱为空。')).toBeVisible()
})
