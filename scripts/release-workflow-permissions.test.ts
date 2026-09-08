import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('signed release workflow permissions', () => {
  it('passes verified draft-release metadata to stable promotion without widening its token', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8')
    const checksumsStart = workflow.indexOf('\n  checksums:')
    const stableStart = workflow.indexOf('\n  prepare-stable-promotion:')
    const checksums = workflow.slice(checksumsStart, stableStart)
    const stable = workflow.slice(stableStart)

    expect(checksums).toContain('candidate-release:')
    expect(stable).toContain('CANDIDATE_RELEASE:')
    expect(stable).not.toContain('gh release view "$TAG_NAME"')
    expect(stable).toContain('contents: read')
  })
})