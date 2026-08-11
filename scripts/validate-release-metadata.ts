import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface ReleaseAsset {
  apiUrl: string
  id: string
  name: string
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
  const architecture = platform === 'windows-x86_64' ? /(?:^|[_-])(x64|x86_64)(?:[_.-]|$)/i : platform === 'darwin-aarch64' ? /(?:^|[_-])aarch64(?:[_.-]|$)/i : /(?:^|[_-])(x64|x86_64)(?:[_.-]|$)/i
  const extension = platform === 'windows-x86_64' ? /\.msi\.zip$/i : /\.app\.tar\.gz$/i
  return architecture.test(name) && extension.test(name)
}

function optionValue(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required.`)
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
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCommand()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release metadata validation failed.')
    process.exitCode = 1
  }
}
