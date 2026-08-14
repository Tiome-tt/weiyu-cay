import { describe, expect, it } from 'vitest'
import { createVerifiedReleaseAssetManifest, validateReleaseMetadata, type ReleaseAsset } from './validate-release-metadata'

const repository = 'acme/simple-notes'
const tag = 'v0.1.1-rc.1'
const updaterAssets: ReleaseAsset[] = [
  { id: 'RA_kwDOA1b2xM4AAAAB', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/101`, name: '微屿_0.1.1_x64_en-US.msi.zip' },
  { id: 'RA_kwDOA1b2xM4AAAAC', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/102`, name: '微屿_0.1.1_x64_en-US.msi.zip.sig' },
  { id: 'RA_kwDOA1b2xM4AAAAD', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/201`, name: '微屿_aarch64.app.tar.gz' },
  { id: 'RA_kwDOA1b2xM4AAAAE', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/202`, name: '微屿_aarch64.app.tar.gz.sig' },
  { id: 'RA_kwDOA1b2xM4AAAAF', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/301`, name: '微屿_x64.app.tar.gz' },
  { id: 'RA_kwDOA1b2xM4AAAAG', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/302`, name: '微屿_x64.app.tar.gz.sig' },
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
  ['微屿_0.1.1_x64_en-US.msi.zip', Buffer.from('installer')],
  ['微屿_0.1.1_x64_en-US.msi.zip.sig', Buffer.from('windows-signature\n')],
  ['微屿_aarch64.app.tar.gz', Buffer.from('arm')],
  ['微屿_aarch64.app.tar.gz.sig', Buffer.from('arm-signature\n')],
  ['微屿_x64.app.tar.gz', Buffer.from('intel')],
  ['微屿_x64.app.tar.gz.sig', Buffer.from('intel-signature\n')],
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
    const ambiguousName = '微屿_aarch64-x64.app.tar.gz'
    const assets = updaterAssets.map((asset) => asset.name === '微屿_aarch64.app.tar.gz'
      ? { ...asset, name: ambiguousName }
      : asset.name === '微屿_aarch64.app.tar.gz.sig'
        ? { ...asset, name: `${ambiguousName}.sig` }
        : asset)
    const files = new Map(downloaded)
    files.delete('微屿_aarch64.app.tar.gz')
    files.delete('微屿_aarch64.app.tar.gz.sig')
    files.set(ambiguousName, Buffer.from('arm'))
    files.set(`${ambiguousName}.sig`, Buffer.from('arm-signature\n'))
    const aliased = metadata()
    aliased.platforms['darwin-x86_64'] = { ...aliased.platforms['darwin-aarch64'] }

    expect(() => validateReleaseMetadata({ metadata: aliased, repository, tag, releaseAssets: assets, downloadedAssets: files }))
      .toThrow('does not match the required platform artifact')
  })

  it('rejects distinct macOS assets when both filenames contain arm64 and x64 architecture tokens', () => {
    const ambiguousArmName = '微屿_aarch64-x64-one.app.tar.gz'
    const ambiguousIntelName = '微屿_aarch64-x64-two.app.tar.gz'
    const assets = updaterAssets.map((asset) => {
      if (asset.name === '微屿_aarch64.app.tar.gz') return { ...asset, name: ambiguousArmName }
      if (asset.name === '微屿_aarch64.app.tar.gz.sig') return { ...asset, name: `${ambiguousArmName}.sig` }
      if (asset.name === '微屿_x64.app.tar.gz') return { ...asset, name: ambiguousIntelName }
      if (asset.name === '微屿_x64.app.tar.gz.sig') return { ...asset, name: `${ambiguousIntelName}.sig` }
      return asset
    })
    const files = new Map(downloaded)
    files.delete('微屿_aarch64.app.tar.gz')
    files.delete('微屿_aarch64.app.tar.gz.sig')
    files.delete('微屿_x64.app.tar.gz')
    files.delete('微屿_x64.app.tar.gz.sig')
    files.set(ambiguousArmName, Buffer.from('arm'))
    files.set(`${ambiguousArmName}.sig`, Buffer.from('arm-signature\n'))
    files.set(ambiguousIntelName, Buffer.from('intel'))
    files.set(`${ambiguousIntelName}.sig`, Buffer.from('intel-signature\n'))

    expect(() => validateReleaseMetadata({ metadata: metadata(), repository, tag, releaseAssets: assets, downloadedAssets: files }))
      .toThrow('does not match the required platform artifact')
  })

  it.each([
    ['windows-x86_64', '微屿_darwin_x64_en-US.msi.zip'],
    ['darwin-aarch64', '微屿_windows_aarch64.app.tar.gz'],
    ['darwin-x86_64', '微屿_windows_x64.app.tar.gz'],
    ['windows-x86_64', '微屿_x64-aarch64_en-US.msi.zip'],
    ['windows-x86_64', '微屿_linux_x64_en-US.msi.zip'],
    ['darwin-aarch64', '微屿_linux_arm64.app.tar.gz'],
  ] as const)('rejects a %s asset with contradictory platform or architecture tokens', (platform, invalidName) => {
    const current = metadata().platforms[platform]
    const originalAsset = updaterAssets.find((asset) => asset.apiUrl === current.url)
    if (originalAsset === undefined) throw new Error('test fixture lacks updater asset')
    const assets = updaterAssets.map((asset) => asset.name === originalAsset.name
      ? { ...asset, name: invalidName }
      : asset.name === `${originalAsset.name}.sig`
        ? { ...asset, name: `${invalidName}.sig` }
        : asset)
    const files = new Map(downloaded)
    files.delete(originalAsset.name)
    files.delete(`${originalAsset.name}.sig`)
    files.set(invalidName, downloaded.get(originalAsset.name) ?? Buffer.from('updater'))
    files.set(`${invalidName}.sig`, downloaded.get(`${originalAsset.name}.sig`) ?? Buffer.from(current.signature))

    expect(() => validateReleaseMetadata({ metadata: metadata(), repository, tag, releaseAssets: assets, downloadedAssets: files }))
      .toThrow('does not match the required platform artifact')
  })

  it('binds every downloaded release asset identity to its SHA-256 digest', () => {
    expect(createVerifiedReleaseAssetManifest({ downloadedAssets: downloaded, releaseAssets: updaterAssets, repository, tag })).toEqual({
      repository,
      tag,
      assets: [
        { ...updaterAssets[0], sha256: '9c0d294c05fc1d88d698034609bb81c0c69196327594e4c69d2915c80fd9850c' },
        { ...updaterAssets[1], sha256: '35a33caaa2927b51859b944b9e842c10571e4419fa8df3dbebb45d4ad3b556bc' },
        { ...updaterAssets[2], sha256: 'ddf7ff5ebd9d66ce161466c1c0262430fa04de32b0e420ee3f489e2e2112e386' },
        { ...updaterAssets[3], sha256: '5f668f9607e38c3ccbaeb42220955d1e0e0a626b6030c539fb5c2bb00ea07328' },
        { ...updaterAssets[4], sha256: '96eebba49dbbf422d245f02290f9d4ed0eb02da9daa6bbceefb162800ff42481' },
        { ...updaterAssets[5], sha256: '3c60332c692740d0c0a73cc10357eb4c6313abc2fd75f86211359f64193bf9b3' },
      ],
    })
  })

  it('rejects release bytes changed after the verified identity manifest was created', () => {
    const manifest = createVerifiedReleaseAssetManifest({ downloadedAssets: downloaded, releaseAssets: updaterAssets, repository, tag })
    const changed = new Map(downloaded)
    changed.set(updaterAssets[0].name, Buffer.from('changed-installer'))

    expect(() => validateReleaseMetadata({ metadata: metadata(), repository, tag, releaseAssets: manifest.assets, downloadedAssets: changed }))
      .toThrow('SHA-256 digest does not match')
  })

  it('refuses to create an identity manifest that omits a downloaded release asset', () => {
    const unexpected = new Map(downloaded)
    unexpected.set('unidentified-installer.bin', Buffer.from('unexpected'))

    expect(() => createVerifiedReleaseAssetManifest({ downloadedAssets: unexpected, releaseAssets: updaterAssets, repository, tag }))
      .toThrow('does not have a release asset identity')
  })
})
