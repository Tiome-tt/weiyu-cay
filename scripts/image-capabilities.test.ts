import {readFileSync} from 'node:fs'
import {expect,it} from 'vitest'
it('allows image reads in main and sticky windows and registers scoped commands',()=>{
 for(const name of ['default','temporary']) {
 const capability=JSON.parse(readFileSync(`src-tauri/capabilities/${name}.json`,'utf8')) as {permissions:string[]}
 expect(capability.permissions).toContain('allow-read-image-asset')
 expect(capability.permissions).toContain('allow-read-image-assets')
 }
 const build=readFileSync('src-tauri/build.rs','utf8')
 expect(build).toContain('"read_image_asset"')
 expect(build).toContain('"read_image_assets"')
})
