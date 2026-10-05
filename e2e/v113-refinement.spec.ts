import { expect, test } from '@playwright/test'

test('keeps settings compact and API actions inline with themed checkbox targets', async ({page}, info) => {
 await page.setViewportSize({width:1180,height:760}); await page.goto('/')
 await page.getByRole('button',{name:'打开设置',exact:true}).click()
 await expect(page.getByText('ms',{exact:true})).toBeVisible()
 await expect(page.getByText('只调整应用界面，不影响笔记正文')).toHaveCount(0)
 await page.getByRole('tab',{name:'系统',exact:true}).click()
 const box=page.getByRole('checkbox',{name:'开机启动'}), tray=page.getByRole('checkbox',{name:'关闭主窗口时隐藏到托盘'})
 const before=await box.isChecked()
 await page.getByText('开机启动',{exact:true}).click();expect(await box.isChecked()).toBe(before)
 await box.check();await tray.check()
 expect(await box.evaluate(e=>getComputedStyle(e).backgroundColor)).toBe(await tray.evaluate(e=>getComputedStyle(e).backgroundColor))
 await page.getByRole('tab',{name:'按键',exact:true}).click()
 await expect(page.getByRole('textbox',{name:'搜索快捷键'})).toHaveValue('Ctrl+F')
 await page.getByRole('tab',{name:'AI',exact:true}).click()
 const key=(await page.getByRole('textbox',{name:'DeepSeek API Key'}).boundingBox())!
 const save=(await page.getByRole('button',{name:'保存',exact:true}).boundingBox())!
 const control=(await page.locator('.settings-view__key-control').boundingBox())!
 expect(Math.abs(save.y+save.height/2-key.y-key.height/2)).toBeLessThan(2)
 expect(save.x+save.width).toBeLessThan(control.x+control.width)
 await expect(page.getByRole('button',{name:'清除 Key'})).toHaveCount(0)
 await page.screenshot({path:info.outputPath('settings-ai.png')})
})

test('centers compact search and shows matched context',async ({page},info)=>{
 await page.setViewportSize({width:1180,height:760});await page.goto('/')
 await page.keyboard.press('Control+f');const dialog=page.getByRole('dialog',{name:'搜索资料库'})
 let box=(await dialog.boundingBox())!
 expect(Math.abs(box.x+box.width/2-590)).toBeLessThan(2)
 expect(Math.abs(box.y+box.height/2-395)).toBeLessThan(2)
 expect(box.height).toBeLessThan(70)
 await page.getByRole('searchbox',{name:'搜索资料库'}).fill('认证')
 await expect(dialog.getByRole('option',{name:/用户认证/})).toBeVisible()
 await expect(dialog.locator('.workspace-search__excerpt').first()).toBeVisible()
 box=(await dialog.boundingBox())!
 expect(Math.abs(box.y+box.height/2-395)).toBeLessThan(2)
 await page.screenshot({path:info.outputPath('search.png')})
})

test('makes tags discoverable and clears validation on dismissal',async ({page},info)=>{
 await page.goto('/');await page.getByRole('treeitem',{name:'项目',exact:true}).click();await page.getByRole('button',{name:'用户认证',exact:true}).click()
 const header=page.locator('.editor-document-heading')
 const add=header.getByRole('button',{name:'添加标签',exact:true});await expect(add).toBeVisible()
 expect(await add.evaluate(e=>getComputedStyle(e).opacity)).toBe('1')
 expect((await header.boundingBox())!.height).toBeLessThan(115)
 await add.click();const confirm=header.getByRole('button',{name:'确认添加标签'})
 await expect(confirm).toBeDisabled()
 const input=header.getByRole('textbox',{name:'添加标签'})
 await input.fill('a'.repeat(81));await confirm.click()
 await expect(page.getByRole('alert')).toContainText('标签过长')
 await input.press('Escape');await expect(header.getByRole('textbox',{name:'添加标签'})).toHaveCount(0)
 await page.screenshot({path:info.outputPath('heading.png')})
})

test('uses matching white menus and highlights options without initial focus rings',async ({page},info)=>{
 await page.goto('/e2e/rich-heading-fixture.html')
 const heading=page.getByRole('button',{name:'段落样式'});await heading.click()
 const current=page.getByRole('menuitemradio',{name:'正文'})
 expect(await current.evaluate(e=>document.activeElement===e)).toBe(false)
 expect(await current.evaluate(e=>getComputedStyle(e).boxShadow)).toBe('none')
 await page.locator('.rich-document__surface').click({position:{x:300,y:200}})
 for(const label of ['字体','字号选项']) {
  const trigger=page.getByRole('button',{name:label,exact:true})
  const before=await trigger.evaluate(e=>getComputedStyle(e).backgroundColor)
  await trigger.hover();expect(await trigger.evaluate(e=>getComputedStyle(e).backgroundColor)).toBe(before)
  await trigger.click();const menu=page.getByRole('menu',{name:label,exact:true})
  const option=menu.getByRole('menuitemradio').last();const normal=await option.evaluate(e=>getComputedStyle(e).backgroundColor)
  await option.hover();expect(await option.evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe(normal)
  await page.screenshot({path:info.outputPath(label+'.png')})
  await option.click();await expect(menu).toHaveCount(0)
 }
})

for (const kind of ['document','text']) {
 test(`keeps ${kind} headings compact with a visible tag entry`,async ({page},info)=>{
  await page.goto('/e2e/rich-heading-fixture.html?pane='+kind)
  await expect(page.getByRole('textbox',{name:'笔记标题'})).toBeVisible()
  await expect(page.getByRole('textbox',{name:kind === 'document' ? '文档正文' : '纯文本正文'})).toBeVisible()
  const add=page.getByRole('button',{name:'添加标签',exact:true})
  await expect(add).toBeVisible();expect(await add.evaluate(e=>getComputedStyle(e).opacity)).toBe('1')
  const header=(await page.locator('.typed-editor__header').boundingBox())!, tags=(await page.locator('.typed-editor__metadata').boundingBox())!
  expect(tags.y+tags.height-header.y).toBeLessThan(115)
  await add.click();await expect(page.getByRole('button',{name:'确认添加标签'})).toBeDisabled()
  await page.getByRole('textbox',{name:'添加标签'}).press('Escape')
  await page.screenshot({path:info.outputPath(kind+'-heading.png')})
 })
}
