import { expect, test } from '@playwright/test'

test('creates, links, searches, reopens, and exports a note', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('treeitem', { name: '项目' }).click()
  await page.getByRole('button', { name: '新建笔记' }).click()
  await page.getByRole('textbox', { name: '新笔记标题' }).fill('登录流程草稿')
  await page.getByRole('textbox', { name: '新笔记标题' }).press('Enter')
  const editor = page.getByRole('textbox', { name: 'Markdown source' })
  await editor.fill('# 登录流程\n\n')
  await page.getByRole('combobox', { name: '内部链接目标' }).selectOption({ label: '用户认证' })
  await page.getByRole('button', { name: '插入内部链接' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已保存' })).toBeVisible()

  const title = page.getByRole('textbox', { name: '笔记标题' })
  await title.fill('登录流程')
  await title.press('Enter')
  await expect(page.getByRole('heading', { name: '登录流程' })).toBeVisible()
  const folder = page.getByRole('combobox', { name: '笔记文件夹' })
  await folder.selectOption({ label: '未归档笔记' })
  await expect(page.getByRole('status').filter({ hasText: '笔记已移动' })).toBeVisible()
  await folder.selectOption({ label: '项目' })

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
