import {expect,it,vi} from 'vitest'
import {resolveLocale,text} from './i18n'
it('defaults existing builds to Chinese and accepts only the two supported UI locales',()=>{
 expect(resolveLocale(undefined)).toBe('zh-CN')
 expect(resolveLocale('en-US')).toBe('en-US')
 expect(()=>resolveLocale('fr')).toThrow()
})
it('selects explicit UI translations without modifying either source string',()=>{
 expect(text('设置','Settings','en-US')).toBe('Settings')
 expect(text('设置','Settings','zh-CN')).toBe('设置')
})
it('uses the English brand when the English build flag is present',async()=>{
 vi.stubEnv('VITE_CAY_LOCALE','en-US');vi.resetModules()
 try{
  const brand=await import('./brand')
  expect(brand.APP_NAME).toBe('Cay')
  expect(brand.APP_TAGLINE).toBe('Every thought is an island.')
 }finally{vi.unstubAllEnvs();vi.resetModules()}
})
