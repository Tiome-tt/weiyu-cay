// The renderer tsconfig deliberately excludes Node ambient types; Vitest still
// executes this contract test in Node.
// @ts-expect-error TS2307 -- no renderer dependency on Node types is intended.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_ENGLISH_NAME, APP_NAME, APP_TAGLINE } from './brand'

describe('brand contract', () => {
  it('uses the approved Chinese-first identity', () => {
    expect(APP_NAME).toBe('微屿')
    expect(APP_ENGLISH_NAME).toBe('Cay')
    expect(APP_TAGLINE).toBe('每个念头，都是一座小岛。')
  })

  it('uses the Chinese name in the HTML title', () => {
    expect(readFileSync('index.html', 'utf8')).toContain('<title>微屿</title>')
  })
})
