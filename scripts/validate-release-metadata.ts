import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface ReleaseAsset {
  apiUrl: string
  id: string
  name: string
}

export interface VerifiedReleaseAsset extends ReleaseAsset {
  sha256: string
}

export interface VerifiedReleaseAssetManifest {
  assets: VerifiedReleaseAsset[]
  repository: string
  tag: string
}

interface UpdaterPlatform {
  signature: string
  url: string
}

interface ReleaseMetadata {
  platforms?: Record<string, UpdaterPlatform>
}

export interface ValidateReleaseMetadataOptions {
  downloadedAssets: ReadonlyMap<string, Uint8Array>
  metadata: ReleaseMetadata
  releaseAssets: readonly ReleaseAsset[]
  repository: string
  tag: string
}

const REQUIRED_PLATFORMS = ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'] as const

/** Verifies the API asset identity emitted by the pinned Tauri action before trusting latest.json. */
export function validateReleaseMetadata(options: ValidateReleaseMetadataOptions): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.tag)) {
    throw new Error('Release repository or tag is invalid.')
  }
  const platforms = options.metadata.platforms
  if (platforms === undefined || platforms === null || typeof platforms !== 'object') {
    throw new Error('latest.json platforms is missing.')
  }
  const releaseAssets = new Map(options.releaseAssets.map((asset) => [assetApiUrl(asset, options.repository), asset]))
  validateVerifiedAssetDigests(options.releaseAssets, options.downloadedAssets)
  const updaterNames = new Set<string>()
  const signatureNames = new Set<string>()
  for (const platformName of REQUIRED_PLATFORMS) {
    const platform = platforms[platformName]
    if (platform === undefined || typeof platform.url !== 'string' || typeof platform.signature !== 'string' || !platform.signature.trim()) {
      throw new Error(`latest.json lacks signed ${platformName} metadata.`)
    }
    const platformApiUrl = apiAssetUrl(platform.url, options.repository)
    const asset = releaseAssets.get(platformApiUrl)
    if (asset === undefined) throw new Error(`${platformName} URL does not identify this release asset.`)
    if (!isPlatformAsset(platformName, asset.name)) {
      throw new Error(`${platformName} URL does not match the required platform artifact.`)
    }
    const updater = options.downloadedAssets.get(asset.name)
    const signature = options.downloadedAssets.get(`${asset.name}.sig`)
    if (updater === undefined || signature === undefined) throw new Error(`${platformName} updater asset or .sig is absent.`)
    const signatureAsset = options.releaseAssets.find((candidate) => candidate.name === `${asset.name}.sig`)
    if (signatureAsset === undefined || !releaseAssets.has(assetApiUrl(signatureAsset, options.repository))) {
      throw new Error(`${platformName} updater signature is not a release asset.`)
    }
    if (updaterNames.has(asset.name) || signatureNames.has(signatureAsset.name)) {
      throw new Error(`${platformName} reuses another platform's updater asset or signature.`)
    }
    updaterNames.add(asset.name)
    signatureNames.add(signatureAsset.name)
    if (Buffer.from(signature).toString('utf8').trim() !== platform.signature.trim()) {
      throw new Error(`${platformName} metadata signature does not match its uploaded .sig.`)
    }
  }
  for (const assetName of options.downloadedAssets.keys()) {
    if (assetName.endsWith('.sig') && !options.downloadedAssets.has(assetName.slice(0, -4))) {
      throw new Error(`Orphan updater signature: ${assetName}`)
    }
  }
}

/** Captures the immutable release-asset identities and bytes handed from validation to staging. */
export function createVerifiedReleaseAssetManifest(options: Pick<ValidateReleaseMetadataOptions, 'downloadedAssets' | 'releaseAssets' | 'repository' | 'tag'>): VerifiedReleaseAssetManifest {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository) || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.tag)) {
    throw new Error('Release repository or tag is invalid.')
  }
  const releaseAssets = options.releaseAssets.filter((asset) => asset.name !== 'SHA256SUMS')
  const names = new Set<string>()
  const apiUrls = new Set<string>()
  const verifiedAssets = releaseAssets.map((asset) => {
    if (!asset.id.trim() || !asset.name || /[\\/]/.test(asset.name)) throw new Error('Release asset identity is invalid.')
    const apiUrl = assetApiUrl(asset, options.repository)
    if (names.has(asset.name) || apiUrls.has(apiUrl)) throw new Error('Release asset identities must be unique.')
    names.add(asset.name)
    apiUrls.add(apiUrl)
    const bytes = options.downloadedAssets.get(asset.name)
    if (bytes === undefined) throw new Error(`${asset.name} release asset bytes are absent.`)
    return { ...asset, apiUrl, sha256: sha256(bytes) }
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'))
  for (const name of options.downloadedAssets.keys()) {
    if (name !== 'SHA256SUMS' && !names.has(name)) throw new Error(`${name} does not have a release asset identity.`)
  }
  return { repository: options.repository, tag: options.tag, assets: verifiedAssets }
}

function validateVerifiedAssetDigests(assets: readonly ReleaseAsset[], downloadedAssets: ReadonlyMap<string, Uint8Array>): void {
  const digests = assets.map((asset) => (asset as Partial<VerifiedReleaseAsset>).sha256)
  if (!digests.some((digest) => digest !== undefined)) return
  for (const [index, asset] of assets.entries()) {
    const digest = digests[index]
    if (digest === undefined || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${asset.name} SHA-256 identity is invalid.`)
    const bytes = downloadedAssets.get(asset.name)
    if (bytes === undefined || sha256(bytes) !== digest) throw new Error(`${asset.name} SHA-256 digest does not match its verified identity.`)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assetApiUrl(asset: ReleaseAsset, repository: string): string {
  return apiAssetUrl(asset.apiUrl, repository)
}

function apiAssetUrl(value: string, repository: string): string {
  const url = new URL(value)
  const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/)
  if (url.origin !== 'https://api.github.com' || match === null || `${match[1]}/${match[2]}` !== repository) {
    throw new Error('Updater URL does not identify this release asset.')
  }
  return url.href
}

function isPlatformAsset(platform: typeof REQUIRED_PLATFORMS[number], name: string): boolean {
  const x64 = /(?:^|[_-])(?:x64|x86_64)(?:[_.-]|$)/i
  const arm64 = /(?:^|[_-])(?:arm64|aarch64)(?:[_.-]|$)/i
  const architecture = platform === 'darwin-aarch64' ? arm64 : x64
  const oppositeArchitecture = platform === 'darwin-aarch64' ? x64 : arm64
  const extension = platform === 'windows-x86_64' ? /\.msi\.zip$/i : /\.app\.tar\.gz$/i
  const wrongPlatform = platform === 'windows-x86_64'
    ? /(?:^|[_.-])(?:apple|darwin|linux|macos|osx)(?:[_.-]|$)/i
    : /(?:^|[_.-])(?:exe|linux|msi|nsis|win32|win64|windows)(?:[_.-]|$)/i
  return architecture.test(name) && !oppositeArchitecture.test(name) && extension.test(name) && !wrongPlatform.test(name)
}

function optionValue(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required.`)
  return value
}

function optionalOptionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`)
  return value
}

function runCommand(): void {
  const directory = resolve(optionValue('--directory'))
  const assets = JSON.parse(readFileSync(optionValue('--release-assets'), 'utf8')) as { assets?: ReleaseAsset[] }
  if (!Array.isArray(assets.assets)) throw new Error('Release asset manifest is invalid.')
  const downloadedAssets = new Map(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))]))
  const metadata = JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8')) as ReleaseMetadata
  validateReleaseMetadata({
    metadata,
    downloadedAssets,
    releaseAssets: assets.assets,
    repository: optionValue('--repository'),
    tag: optionValue('--tag'),
  })
  const identityOutput = optionalOptionValue('--identity-output')
  if (identityOutput !== undefined) {
    const manifest = createVerifiedReleaseAssetManifest({
      downloadedAssets,
      releaseAssets: assets.assets,
      repository: optionValue('--repository'),
      tag: optionValue('--tag'),
    })
    writeFileSync(identityOutput, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCommand()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release metadata validation failed.')
    process.exitCode = 1
  }
}
