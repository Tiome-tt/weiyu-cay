import { describe, expect, it } from 'vitest'
import { validateReleaseMetadata, type ReleaseAsset } from './validate-release-metadata'

const repository = 'acme/simple-notes'
const tag = 'v0.1.1-rc.1'
const updaterAssets: ReleaseAsset[] = [
  { id: 101, name: 'Simple Notes_0.1.1_x64_en-US.msi.zip' },
  { id: 102, name: 'Simple Notes_0.1.1_x64_en-US.msi.zip.sig' },
  { id: 201, name: 'Simple Notes_aarch64.app.tar.gz' },
  { id: 202, name: 'Simple Notes_aarch64.app.tar.gz.sig' },
  { id: 301, name: 'Simple Notes_x64.app.tar.gz' },
  { id: 302, name: 'Simple Notes_x64.app.tar.gz.sig' },
]

function metadata(repositoryName = repository) {
  return {
    platforms: {
      'windows-x86_64': { url: `https://api.github.com/repos/${repositoryName}/releases/assets/101`, signature: 'windows-signature' },
      'darwin-aarch64': { url: `https://api.github.com/repos/${repositoryName}/releases/assets/201`, signature: 'arm-signature' },
      'darwin-x86_64': { url: `https://api.github.com/repos/${repositoryName}/releases/assets/301`, signature: 'intel-signature' },
    },
  }
}

const downloaded = new Map([
  ['Simple Notes_0.1.1_x64_en-US.msi.zip', Buffer.from('installer')],
  ['Simple Notes_0.1.1_x64_en-US.msi.zip.sig', Buffer.from('windows-signature\n')],
  ['Simple Notes_aarch64.app.tar.gz', Buffer.from('arm')],
  ['Simple Notes_aarch64.app.tar.gz.sig', Buffer.from('arm-signature\n')],
  ['Simple Notes_x64.app.tar.gz', Buffer.from('intel')],
  ['Simple Notes_x64.app.tar.gz.sig', Buffer.from('intel-signature\n')],
])

describe('validateReleaseMetadata', () => {
  it('accepts the pinned Tauri action API asset URLs only when tag assets and signatures agree', () => {
    expect(() => validateReleaseMetadata({ metadata: metadata(), repository, tag, releaseAssets: updaterAssets, downloadedAssets: downloaded })).not.toThrow()
  })

  it('rejects an API asset URL for another repository even when its filename exists locally', () => {
    expect(() => validateReleaseMetadata({ metadata: metadata('acme/other'), repository, tag, releaseAssets: updaterAssets, downloadedAssets: downloaded }))
      .toThrow('does not identify this release asset')
  })

  it('rejects a missing release asset id instead of accepting an arbitrary GitHub API URL', () => {
    const invalid = metadata()
    invalid.platforms['windows-x86_64'].url = `https://api.github.com/repos/${repository}/releases/assets/999`

    expect(() => validateReleaseMetadata({ metadata: invalid, repository, tag, releaseAssets: updaterAssets, downloadedAssets: downloaded }))
      .toThrow('does not identify this release asset')
  })
})
