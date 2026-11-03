import {expect,it} from 'vitest'
import {createLocalizedMetadata,releaseNames} from './localized-release'
it('uses four unique installer identities and language-specific update payloads',()=>{
 expect(releaseNames('1.1.5','windows','en-US').installer).toBe('weiyu-cay_1.1.5_windows-x64-en-US.exe')
 expect(releaseNames('1.1.5','macos','zh-CN').installer).toBe('weiyu-cay_1.1.5_macos-universal-zh-CN.dmg')
 expect(()=>releaseNames('../bad','macos','en-US')).toThrow()
})
it('preserves English updates and explicitly maps a verified universal archive to both Mac architectures',()=>{
 const names=['windows','macos'].map(platform=>releaseNames('1.1.5',platform as 'windows'|'macos','en-US'))
 const assets=names.map((value,index)=>({name:value.updater,apiUrl:`https://api.github.com/repos/acme/cay/releases/assets/${index+1}`}))
 const signatures=new Map(names.map(value=>[`${value.updater}.sig`,'signed']))
 const metadata=createLocalizedMetadata('1.1.5','en-US',assets,signatures,'acme/cay')
 expect(metadata.platforms['darwin-aarch64']).toEqual(metadata.platforms['darwin-x86_64'])
 expect(metadata.platforms['windows-x86_64'].url).toContain('/assets/1')
 expect(()=>createLocalizedMetadata('1.1.5','zh-CN',assets,signatures,'acme/cay')).toThrow()
})
