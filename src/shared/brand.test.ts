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

  it('documents the approved names and safe cache cleanup', () => {
    const agents = readFileSync('AGENTS.md', 'utf8')
    const design = readFileSync('docs/superpowers/specs/2026-07-30-simple-notes-design.md', 'utf8')
    const development = readFileSync('docs/development.md', 'utf8')
    expect(agents).toContain('Cay (微屿) is a local-first Markdown note application')
    expect(design).toContain('# Cay (微屿) product and architecture design')
    expect(design).toContain('Cay (微屿) is a small, approachable desktop note application')
    expect(development).toContain('cargo clean --manifest-path src-tauri/Cargo.toml')
    expect(development).toContain('不会删除笔记数据')
  })

  it('keeps the original round-hill island source and platform icon entries aligned', () => {
    const source = readFileSync('src/assets/weiyu-app-icon.svg', 'utf8')
    const tauri = readFileSync('src-tauri/tauri.conf.json', 'utf8')

    expect(source).toContain('data-layer="island"')
    expect(source).toContain('data-layer="sand"')
    expect(source).toContain('data-layer="waves"')
    expect(source).toContain('#2F7866')
    expect(source).toContain('#D59A5E')
    expect(tauri).toContain('icons/icon.ico')
    expect(tauri).toContain('icons/icon.icns')
  })
})
