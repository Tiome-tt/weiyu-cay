import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateSearchFixture } from './generate-search-fixture'

const temporaryRoots: string[] = []

function temporaryFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'simple-notes-search-fixture-test-'))
  temporaryRoots.push(root)
  return root
}

function readFixture(root: string): Map<string, string> {
  const contents = new Map<string, string>()
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else contents.set(relative(root, path), readFileSync(path, 'utf8'))
    }
  }
  visit(root)
  return contents
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('generateSearchFixture', () => {
  it('writes byte-identical durable Markdown fixture trees for the same seed', () => {
    const firstRoot = temporaryFixtureRoot()
    const secondRoot = temporaryFixtureRoot()

    const first = generateSearchFixture({ count: 12, outputRoot: firstRoot, seed: 20260730 })
    const second = generateSearchFixture({ count: 12, outputRoot: secondRoot, seed: 20260730 })

    expect(first.noteCount).toBe(12)
    expect(second.noteCount).toBe(12)
    expect(readFixture(firstRoot)).toEqual(readFixture(secondRoot))
  })

  it('changes generated note bytes when the seed changes', () => {
    const firstRoot = temporaryFixtureRoot()
    const secondRoot = temporaryFixtureRoot()

    generateSearchFixture({ count: 2, outputRoot: firstRoot, seed: 1 })
    generateSearchFixture({ count: 2, outputRoot: secondRoot, seed: 2 })

    expect(readFixture(firstRoot)).not.toEqual(readFixture(secondRoot))
  })

  it('writes exactly the requested number of frontmatter-bearing Markdown notes', () => {
    const root = temporaryFixtureRoot()

    const result = generateSearchFixture({ count: 3, outputRoot: root, seed: 42 })
    const entries = [...readFixture(root).entries()]
    const notes = entries.filter(([path]) => path.replace(/\\/g, '/').endsWith('/note.md'))

    expect(result.noteCount).toBe(3)
    expect(notes).toHaveLength(3)
    for (const [, markdown] of notes) {
      expect(markdown).toMatch(/^---\nid: [0-9a-f-]{36}\ntitle: .+\nfolderId: [0-9a-f-]{36}\ntags:\n(?:  - .+\n)+createdAt: 2026-07-30T15:30:00\.000Z\nupdatedAt: 2026-07-30T15:30:00\.000Z\n---\n\n/m)
      expect(markdown).toContain('[[')
    }
  })
})
