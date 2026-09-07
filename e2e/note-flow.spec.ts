import { expect, test } from '@playwright/test'

test('creates, links, searches, reopens, and exports a note', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('treeitem', { name: '项目' }).click()
  await page.getByRole('button', { name: '新建笔记' }).click()
  await page.getByRole('textbox', { name: '笔记标题' }).fill('登录流程草稿')
  await page.getByRole('button', { name: '创建笔记' }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown source' })
  await editor.fill('# 登录流程\n\n')
  await page.getByRole('button', { name: '添加内容块' }).click()
  await page.getByRole('menuitem', { name: '插入内部链接' }).click()
  await page.getByRole('treeitem', { name: '选择链接：用户认证' }).click()
  await page.getByRole('button', { name: '插入链接' }).click()
  await expect(page.getByTestId('content-pane').getByRole('status', { name: '保存状态' })).toHaveText('已保存')

  const title = page.getByRole('textbox', { name: '笔记标题' })
  await title.fill('登录流程')
  await title.press('Enter')
  await expect(page.getByRole('heading', { name: '登录流程' })).toBeVisible()
  await page.getByRole('button', { name: '阅读视图' }).click()
  await page.getByRole('link', { name: '用户认证' }).click()
  await expect(page.getByRole('heading', { name: '用户认证' })).toBeVisible()

  const search = page.getByRole('searchbox', { name: '搜索笔记' })
  await search.fill('登录流程')
  await page.locator('.search-results button').filter({ hasText: '登录流程' }).click()
  await expect(page.getByRole('heading', { name: '登录流程' })).toBeVisible()

  await page.reload()
  await page.getByRole('treeitem', { name: '项目' }).click()
  await page.locator('.note-card').filter({ hasText: '登录流程' }).click()
  await expect(page.getByRole('heading', { name: '登录流程' })).toBeVisible()

  await page.getByRole('button', { name: '打开设置' }).click()
  await page.getByRole('button', { name: '导出完整资料库' }).click()
  await expect(page.getByRole('status').filter({ hasText: /已导出 .* 篇笔记/ })).toBeVisible()
})
