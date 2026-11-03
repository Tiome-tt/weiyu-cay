import {copyFileSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {validateInstallers} from './release-installers.ts'

type Platform='windows'|'macos'
type Locale='zh-CN'|'en-US'
export function releaseNames(version:string,platform:Platform,locale:Locale){
 if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)||!['windows','macos'].includes(platform)||!['zh-CN','en-US'].includes(locale))throw new Error('Invalid localized release identity')
 const stem=`weiyu-cay_${version}_${platform==='windows'?'windows-x64':'macos-universal'}-${locale}`
 return {installer:stem+(platform==='windows'?'.exe':'.dmg'),updater:stem+(platform==='windows'?'.exe':'.app.tar.gz')}
}
export function createLocalizedMetadata(version:string,locale:Locale,assets:readonly {name:string;apiUrl:string}[],signatures:ReadonlyMap<string,string>,repository:string){
 if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw new Error('Invalid release repository')
 const platforms:Record<string,{url:string;signature:string}>={}
 for(const platform of ['windows','macos'] as const){
  const name=releaseNames(version,platform,locale).updater,asset=assets.find(item=>item.name===name),signature=signatures.get(name+'.sig')?.trim()
  if(!asset || !signature || !asset.apiUrl.startsWith(`https://api.github.com/repos/${repository}/releases/assets/`))throw new Error(`Missing signed ${locale} ${platform} payload`)
  const keys=platform==='windows'?['windows-x86_64']:['darwin-aarch64','darwin-x86_64']
  for(const key of keys)platforms[key]={url:asset.apiUrl,signature}
 }
 return {version,notes:locale==='en-US'?'Cay update':'微屿更新',platforms}
}
function argument(name:string){const value=process.argv[process.argv.indexOf(name)+1];if(!process.argv.includes(name)||!value||value.startsWith('--'))throw new Error(`${name} is required`);return value}
function files(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(root,entry.name)):[join(root,entry.name)])}
function main(){
 const mode=argument('--mode'),version=argument('--version'),output=resolve(argument('--output'));mkdirSync(output,{recursive:true})
 if(mode==='package'){
  const platform=argument('--platform') as Platform,locale=argument('--locale') as Locale,names=releaseNames(version,platform,locale),candidates=files(resolve(argument('--root')))
  const copy=(extension:string,name:string)=>{const found=candidates.filter(file=>file.endsWith(extension));if(found.length!==1)throw new Error(`Expected exactly one ${extension} bundle`);copyFileSync(found[0],join(output,name));return found[0]}
  copy(platform==='windows'?'.exe':'.dmg',names.installer)
  const updater=candidates.filter(file=>file.endsWith(platform==='windows'?'.exe':'.app.tar.gz'))
  if(updater.length!==1)throw new Error('Expected one updater payload')
  if(names.updater!==names.installer)copyFileSync(updater[0],join(output,names.updater))
  copyFileSync(updater[0]+'.sig',join(output,names.updater+'.sig'))
 }else if(mode==='metadata'){
  const raw=JSON.parse(readFileSync(argument('--assets'),'utf8')) as {assets:Array<{name:string;apiUrl:string}>}
  validateInstallers(raw.assets.map(asset=>asset.name),version)
  const signatures=new Map(readdirSync(output).filter(name=>name.endsWith('.sig')).map(name=>[name,readFileSync(join(output,name),'utf8')]))
  for(const locale of ['zh-CN','en-US'] as const)writeFileSync(join(output,locale==='zh-CN'?'latest.json':'latest-en.json'),JSON.stringify(createLocalizedMetadata(version,locale,raw.assets,signatures,argument('--repository')),null,2)+'\n')
 }else throw new Error('Invalid release mode')
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main()
