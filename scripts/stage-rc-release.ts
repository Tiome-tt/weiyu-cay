import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ReleaseAsset } from './validate-release-metadata'

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
  const parse = (version: string) => {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/)
    if (match === null) throw new Error('RC versions must use MAJOR.MINOR.PATCH-rc.N.')
    return match.slice(1).map((value) => value === undefined ? -1 : Number(value))
  }
  const [candidateMajor, candidateMinor, candidatePatch, candidateRc] = parse(candidate)
  const [previousMajor, previousMinor, previousPatch, previousRc] = parse(previous)
  for (const [left, right] of [[candidateMajor, previousMajor], [candidateMinor, previousMinor], [candidatePatch, previousPatch], [candidateRc, previousRc]] as const) {
    if (left !== right) return left > right ? 1 : -1
  }
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
