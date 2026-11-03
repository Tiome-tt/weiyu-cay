/** en-US means the complete application UI; relabelling a Chinese bundle is invalid. */
export const installerMatrix=[
 {platform:'windows',target:'x86_64-pc-windows-msvc',locale:'zh-CN',suffix:'windows-x64-zh-CN.exe'},
 {platform:'windows',target:'x86_64-pc-windows-msvc',locale:'en-US',suffix:'windows-x64-en-US.exe'},
 {platform:'macos',target:'universal-apple-darwin',locale:'zh-CN',suffix:'macos-universal-zh-CN.dmg'},
 {platform:'macos',target:'universal-apple-darwin',locale:'en-US',suffix:'macos-universal-en-US.dmg'},
] as const

export function validateInstallers(assets:readonly string[],version:string):void{
 if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))throw new Error('Invalid release version')
 const expected=installerMatrix.map(item=>`weiyu-cay_${version}_${item.suffix}`)
 const installers=assets.filter(name=>/\.(exe|msi|dmg)$/i.test(name))
 if(installers.length!==4 || new Set(installers).size!==4 || expected.some(name=>!installers.includes(name)))throw new Error('Release requires the four localized Windows/macOS installers')
}
