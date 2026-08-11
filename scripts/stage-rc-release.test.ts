import { describe, expect, it } from 'vitest'
import { stageRcMetadata } from './stage-rc-release'

const endpoint = 'https://updates.example.test/rc'
const repository = 'acme/simple-notes'
const assets = [
  { id: 'RA_windows', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/101`, name: 'Simple Notes_0.1.2-rc.2_x64_en-US.msi.zip' },
  { id: 'RA_arm', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/201`, name: 'Simple Notes_aarch64.app.tar.gz' },
  { id: 'RA_intel', apiUrl: `https://api.github.com/repos/${repository}/releases/assets/301`, name: 'Simple Notes_x64.app.tar.gz' },
]

const metadata = {
  version: '0.1.2-rc.2',
  platforms: {
    'windows-x86_64': { url: assets[0].apiUrl, signature: 'windows' },
    'darwin-aarch64': { url: assets[1].apiUrl, signature: 'arm' },
    'darwin-x86_64': { url: assets[2].apiUrl, signature: 'intel' },
  },
}

describe('stageRcMetadata', () => {
  it('writes a stable channel manifest whose candidate is newer than the installed RC', () => {
    expect(stageRcMetadata({ metadata, releaseAssets: assets, endpoint, previousVersion: '0.1.2-rc.1' })).toEqual({
      ...metadata,
      platforms: {
        'windows-x86_64': { url: `${endpoint}/assets/Simple%20Notes_0.1.2-rc.2_x64_en-US.msi.zip`, signature: 'windows' },
        'darwin-aarch64': { url: `${endpoint}/assets/Simple%20Notes_aarch64.app.tar.gz`, signature: 'arm' },
        'darwin-x86_64': { url: `${endpoint}/assets/Simple%20Notes_x64.app.tar.gz`, signature: 'intel' },
      },
    })
  })

  it('rejects a same-version RC manifest instead of staging a false update', () => {
    expect(() => stageRcMetadata({ metadata, releaseAssets: assets, endpoint, previousVersion: '0.1.2-rc.2' }))
      .toThrow('must be greater than the staged RC version')
  })
})
