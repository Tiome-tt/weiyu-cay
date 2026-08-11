import { describe, expect, it } from 'vitest'
import { validateReleaseMetadata, type ReleaseAsset } from './validate-release-metadata'

const repository = 'acme/simple-notes'
const tag = 'v0.1.1-rc.1'
const updaterAssets: ReleaseAsset[] = [
  { id: 'RA_kwDOA1b2xM4AAAAB', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/101`, name: 'Simple Notes_0.1.1_x64_en-US.msi.zip' },
  { id: 'RA_kwDOA1b2xM4AAAAC', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/102`, name: 'Simple Notes_0.1.1_x64_en-US.msi.zip.sig' },
  { id: 'RA_kwDOA1b2xM4AAAAD', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/201`, name: 'Simple Notes_aarch64.app.tar.gz' },
  { id: 'RA_kwDOA1b2xM4AAAAE', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/202`, name: 'Simple Notes_aarch64.app.tar.gz.sig' },
  { id: 'RA_kwDOA1b2xM4AAAAF', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/301`, name: 'Simple Notes_x64.app.tar.gz' },
  { id: 'RA_kwDOA1b2xM4AAAAG', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/302`, name: 'Simple Notes_x64.app.tar.gz.sig' },
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
  it('accepts the real gh release view asset shape only when API URLs, names, and signatures agree', () => {
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

  it('rejects an asset inventory API URL that does not match the metadata numeric REST id', () => {
    const assets = updaterAssets.map((asset) => asset.name.includes('msi.zip') && !asset.name.endsWith('.sig')
      ? { ...asset, apiUrl: `https://api.github.com/repos/${repository}/releases/assets/999` }
      : asset)

    expect(() => validateReleaseMetadata({ metadata: metadata(), repository, tag, releaseAssets: assets, downloadedAssets: downloaded }))
      .toThrow('does not identify this release asset')
  })

  it('rejects platform aliases instead of treating one updater asset as all three targets', () => {
    const aliased = metadata()
    aliased.platforms['darwin-aarch64'] = { ...aliased.platforms['windows-x86_64'] }
    aliased.platforms['darwin-x86_64'] = { ...aliased.platforms['windows-x86_64'] }

    expect(() => validateReleaseMetadata({ metadata: aliased, repository, tag, releaseAssets: updaterAssets, downloadedAssets: downloaded }))
      .toThrow('does not match the required platform artifact')
  })

  it('rejects two macOS platform keys that reuse an ambiguously named updater and signature asset', () => {
    const ambiguousName = 'Simple Notes_aarch64-x64.app.tar.gz'
    const assets = updaterAssets.map((asset) => asset.name === 'Simple Notes_aarch64.app.tar.gz'
      ? { ...asset, name: ambiguousName }
      : asset.name === 'Simple Notes_aarch64.app.tar.gz.sig'
        ? { ...asset, name: `${ambiguousName}.sig` }
        : asset)
    const files = new Map(downloaded)
    files.delete('Simple Notes_aarch64.app.tar.gz')
    files.delete('Simple Notes_aarch64.app.tar.gz.sig')
    files.set(ambiguousName, Buffer.from('arm'))
    files.set(`${ambiguousName}.sig`, Buffer.from('arm-signature\n'))
    const aliased = metadata()
    aliased.platforms['darwin-x86_64'] = { ...aliased.platforms['darwin-aarch64'] }

    expect(() => validateReleaseMetadata({ metadata: aliased, repository, tag, releaseAssets: assets, downloadedAssets: files }))
      .toThrow("reuses another platform's updater asset or signature")
  })
})
