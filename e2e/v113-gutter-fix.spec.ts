import {test,expect} from '@playwright/test'

test('rich plus remains clickable across the gutter and matches markdown alignment',async({page},info)=>{
 await page.goto('/e2e/rich-heading-fixture.html?pane=document')
 const block=page.getByRole('textbox',{name:'文档正文'}).locator('h4')
 await block.hover()
 const plus=page.locator('.rich-document__block-controls button'),number=page.locator('.rich-document__block-number')
 const box=(await plus.boundingBox())!,row=(await number.boundingBox())!,text=(await block.boundingBox())!
 expect(Math.abs(row.y+row.height/2-box.y-box.height/2)).toBeLessThan(1)
 const resting=await plus.evaluate(el=>getComputedStyle(el).backgroundColor)
 expect(resting).toBe('rgba(0, 0, 0, 0)')
 await page.mouse.move(text.x+8,box.y+box.height/2)
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:25})
 await expect(plus).toBeVisible()
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2)
 await expect(page.getByRole('menu',{name:'插入内容'})).toBeVisible()
 await page.screenshot({path:info.outputPath('rich-plus.png')})
 await page.goto('/e2e/rich-heading-fixture.html?pane=markdown')
 await page.locator('.cm-line').last().hover()
 const mdPlus=page.locator('.markdown-block-handle'),mdNumber=page.locator('.markdown-line-number')
 const mdBox=(await mdPlus.boundingBox())!,mdRow=(await mdNumber.boundingBox())!
 expect(Math.abs(mdRow.y+mdRow.height/2-mdBox.y-mdBox.height/2)).toBeLessThan(1)
 expect(await mdPlus.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(resting)
 await mdPlus.click();await expect(page.getByRole('menu',{name:'Markdown 快捷插入'})).toBeVisible()
 await page.screenshot({path:info.outputPath('markdown-plus.png')})
})

test('poetry is readable without enlarging the titlebar',async({page},info)=>{
 await page.goto('/')
 await expect(page.locator('.daily-lyric')).toBeVisible()
 expect(await page.locator('.daily-lyric').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12)
 expect((await page.locator('.window-titlebar').boundingBox())!.height).toBe(30)
 await page.setViewportSize({width:800,height:700})
 expect((await page.locator('.window-titlebar').boundingBox())!.height).toBe(30)
 await page.screenshot({path:info.outputPath('titlebar-poetry.png')})
})
