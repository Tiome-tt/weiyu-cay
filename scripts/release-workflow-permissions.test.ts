import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('signed release workflow permissions', () => {
  it('materializes a fully English installer overlay without changing checked-in configuration',()=>{
    const workflow=readFileSync('.github/workflows/release.yml','utf8').replace(/\r\n/g,'\n')
    const step=workflow.split('      - name: Materialize release-only updater configuration')[1].split('      - name: Verify updater key pair')[0]
    const script=step.split("<<'NODE'\n")[1].split('\n          NODE')[0].replace(/^          /gm,'')
    const directory=mkdtempSync(join(tmpdir(),'cay-release-overlay-'))
    try {
      execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,RUNNER_TEMP:directory,VITE_CAY_LOCALE:'en-US',TAURI_UPDATER_PUBLIC_KEY:'test-public-key',TAURI_SIGNING_PRIVATE_KEY:'test-private-key',TAURI_SIGNING_PRIVATE_KEY_PASSWORD:'test-password',GITHUB_REPOSITORY:'acme/cay',TAG_NAME:'v1.1.5',RELEASE_CHANNEL:'stable'}})
      const config=JSON.parse(readFileSync(join(directory,'simple-notes-release-config.json'),'utf8'))
      expect(config.productName).toBe('Cay')
      expect(config.plugins.updater.endpoints[0]).toMatch(/\/latest-en\.json$/)
      const hooks=readFileSync(join(directory,'cay-english-hooks.nsh'),'utf8')
      expect(hooks).not.toMatch(/[\u4e00-\u9fff]/)
      expect(hooks).toContain('Browse…')
      expect(hooks).toContain('Leave blank')
    } finally {rmSync(directory,{recursive:true,force:true})}
  })
  it('builds four language-specific installers and checks universal Mac architecture',()=>{
    const workflow=readFileSync('.github/workflows/release.yml','utf8').replace(/\r\n/g,'\n')
    expect(workflow).toContain('VITE_CAY_LOCALE: ${{ matrix.locale }}')
    expect(workflow).toContain('universal-apple-darwin')
    expect(workflow).toContain('lipo -verify_arch arm64 x86_64')
    expect(workflow).toContain('latest-en.json')
    expect(workflow).toContain('scripts/localized-release.ts')
  })
  it('does not cache the default pnpm store when CI installs into a custom temporary store', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toContain('--store-dir')
    expect(workflow).not.toContain('cache: pnpm')
  })

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
