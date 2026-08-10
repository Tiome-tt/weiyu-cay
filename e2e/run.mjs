import { spawn } from 'node:child_process'
import { createServer } from 'vite'

const host = '127.0.0.1'
const port = 41737
const server = await createServer({
  mode: 'e2e',
  server: { host, port, strictPort: true },
})

let exitCode = 1
try {
  await server.listen()
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test'],
      {
        cwd: process.cwd(),
        env: { ...process.env, PLAYWRIGHT_EXTERNAL_SERVER: '1' },
        stdio: 'inherit',
      },
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`Playwright exited with signal ${signal}`))
      else resolve(code ?? 1)
    })
  })
} finally {
  await server.close()
}

process.exitCode = exitCode
