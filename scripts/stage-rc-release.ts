import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ReleaseAsset } from './validate-release-metadata'

interface SemverModule {
  gt(left: string, right: string): boolean
  valid(version: string): string | null
}

const semver = createRequire(import.meta.url)('semver') as SemverModule

interface PlatformMetadata {
  signature: string
  url: string
}

interface RcMetadata {
  version: string
  platforms: Record<string, PlatformMetadata>
}

export function stageRcMetadata(options: { endpoint: string, metadata: RcMetadata, previousVersion: string, releaseAssets: readonly ReleaseAsset[] }): RcMetadata {
  const endpoint = options.endpoint.replace(/\/$/, '')
  if (!/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(endpoint)) throw new Error('RC staging endpoint is invalid.')
  if (compareVersions(options.metadata.version, options.previousVersion) <= 0) {
    throw new Error('RC candidate version must be greater than the staged RC version.')
  }
  const assets = new Map(options.releaseAssets.map((asset) => [asset.apiUrl, asset.name]))
  return {
    ...options.metadata,
    platforms: Object.fromEntries(Object.entries(options.metadata.platforms).map(([platform, metadata]) => {
      const name = assets.get(metadata.url)
      if (name === undefined) throw new Error(`${platform} does not reference a draft release asset.`)
      return [platform, { ...metadata, url: `${endpoint}/assets/${encodeURIComponent(name)}` }]
    })),
  }
}

function compareVersions(candidate: string, previous: string): number {
  if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(candidate) || semver.valid(candidate) !== candidate) {
    throw new Error('RC candidate version must use MAJOR.MINOR.PATCH-rc.N.')
  }
  if (semver.valid(previous) !== previous) throw new Error('Staged baseline must be a valid semantic version.')
  if (semver.gt(candidate, previous)) return 1
  if (semver.gt(previous, candidate)) return -1
  return 0
}

function option(name: string): string {
  const value = process.argv[process.argv.indexOf(name) + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required.`)
  return value
}

function main(): void {
  const metadata = JSON.parse(readFileSync(option('--metadata'), 'utf8')) as RcMetadata
  const releaseAssets = (JSON.parse(readFileSync(option('--release-assets'), 'utf8')) as { assets?: ReleaseAsset[] }).assets
  if (!Array.isArray(releaseAssets)) throw new Error('Release asset manifest is invalid.')
  const previous = JSON.parse(readFileSync(option('--previous'), 'utf8')) as { version?: string }
  if (typeof previous.version !== 'string') throw new Error('A staged RC baseline manifest is required.')
  writeFileSync(option('--output'), `${JSON.stringify(stageRcMetadata({ metadata, releaseAssets, endpoint: option('--endpoint'), previousVersion: previous.version }))}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
