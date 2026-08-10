import { expect, test } from '@playwright/test'

const targetId = '019c0000-0000-7000-8000-000000000702'

test('creates, links, searches, reopens, and exports a note', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('treeitem', { name: '项目' }).click()
  await page.getByRole('button', { name: '新建笔记' }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown source' })
  await editor.fill(`# 登录流程\n\n[[用户认证|${targetId}]]`)
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible()

  await page.getByRole('button', { name: '预览视图' }).click()
  await page.getByRole('link', { name: '用户认证' }).click()
  await expect(page.getByRole('heading', { name: '用户认证' })).toBeVisible()

  const search = page.getByRole('searchbox', { name: '搜索笔记' })
  await search.fill('登录流程')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.locator('.search-results button').filter({ hasText: '登录流程' }).click()
  await expect(page.getByRole('heading', { name: '登录流程' })).toBeVisible()

  await page.reload()
  await page.getByRole('treeitem', { name: '项目' }).click()
  await page.locator('.note-card').filter({ hasText: '登录流程' }).click()
  await expect(page.getByRole('heading', { name: '登录流程' })).toBeVisible()

  await page.getByRole('button', { name: '打开设置' }).click()
  await page.getByRole('button', { name: 'Export complete library' }).click()
  await expect(page.getByRole('status').filter({ hasText: /Exported .* notes/ })).toBeVisible()
})
