import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const require = createRequire(import.meta.url)
const root = dirname(require.resolve('pdfjs-dist/package.json'))
for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
  const destination = new URL(`../public/pdfjs/${name}/`, import.meta.url)
  await mkdir(destination, { recursive: true })
  await cp(join(root, name), destination, { recursive: true })
}
