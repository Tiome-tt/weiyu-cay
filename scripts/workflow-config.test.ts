import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8')
}

describe('continuous integration workflow', () => {
  it('runs every required JavaScript and Rust gate on Windows and macOS', () => {
    const workflow = readRepositoryFile('.github/workflows/ci.yml')

    expect(workflow).toContain('windows-latest')
    expect(workflow).toContain('macos-latest')
    for (const command of [
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'cargo fmt --manifest-path src-tauri/Cargo.toml -- --check',
      'cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings',
      'cargo test --manifest-path src-tauri/Cargo.toml',
      'pnpm tauri build',
    ]) {
      expect(workflow).toContain(command)
    }
  })
})

describe('release workflow', () => {
  it('accepts only verified signed semantic-version tags with matching app versions', () => {
    const workflow = readRepositoryFile('.github/workflows/release.yml')

    expect(workflow).toMatch(/push:\s*\n\s+tags:/)
    expect(workflow).not.toContain('workflow_dispatch')
    expect(workflow).toContain('verification.verified')
    expect(workflow).toContain('refs/tags/v')
    expect(workflow).toContain('package.json')
    expect(workflow).toContain('src-tauri/tauri.conf.json')
    expect(workflow).toContain('src-tauri/Cargo.toml')
  })

  it('pins every external action and publishes signed updater metadata and checksums', () => {
    const workflow = readRepositoryFile('.github/workflows/release.yml')
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1])

    expect(actionReferences.length).toBeGreaterThan(0)
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    }
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY')
    expect(workflow).toContain('APPLE_CERTIFICATE')
    expect(workflow).toContain('WINDOWS_CERTIFICATE')
    expect(workflow).toContain('latest.json')
    expect(workflow).toContain('.sig')
    expect(workflow).toContain('SHA256SUMS')
    expect(workflow).toContain('platforms')
    expect(workflow).toContain('signature')
  })

  it('materializes a real updater configuration only for the release build', () => {
    const workflow = readRepositoryFile('.github/workflows/release.yml')
    const tauriConfig = JSON.parse(readRepositoryFile('src-tauri/tauri.conf.json')) as {
      bundle?: { createUpdaterArtifacts?: boolean }
      plugins?: { updater?: { endpoints?: string[]; pubkey?: string } }
    }

    expect(tauriConfig.bundle?.createUpdaterArtifacts).not.toBe(true)
    expect(tauriConfig.plugins?.updater).toBeUndefined()
    expect(workflow).toContain('TAURI_UPDATER_PUBLIC_KEY')
    expect(workflow).toContain('simple-notes-release-config.json')
    expect(workflow).toContain('process.env.RUNNER_TEMP')
    expect(workflow).toContain('--config ${{ runner.temp }}/simple-notes-release-config.json')
    expect(workflow).toContain('createUpdaterArtifacts: true')
    expect(workflow).toContain('github.com/${repository}/releases/latest/download/latest.json')
    expect(workflow).not.toContain('writeFileSync(path')
    expect(workflow).not.toContain('TAURI_CONFIG: ${{ env.TAURI_CONFIG }}')
    expect(workflow).not.toContain('REPLACE_WITH_')
  })
})
