export type UiLocale='zh-CN'|'en-US'
export function resolveLocale(value:unknown):UiLocale{
 if(value===undefined || value==='zh-CN')return 'zh-CN'
 if(value==='en-US')return 'en-US'
 throw new Error('Unsupported application UI locale')
}
export const UI_LOCALE=resolveLocale(import.meta.env.VITE_CAY_LOCALE)
/** Translate application copy at its source; never translate rendered user content. */
export function text(chinese:string,english:string,locale:UiLocale=UI_LOCALE):string{
 return locale==='en-US'?english:chinese
}
