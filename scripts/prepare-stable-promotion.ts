import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface SemverModule {
  gt(left: string, right: string): boolean
  prerelease(version: string): readonly (string | number)[] | null
  valid(version: string): string | null
}

const semver = createRequire(import.meta.url)('semver') as SemverModule

interface CandidateRelease {
  isDraft: boolean
  isPrerelease: boolean
  tagName: string
}

export interface StablePromotionPlan {
  candidateTag: string
  candidateVersion: string
  endpoint: string
  previousTag: string
  previousVersion: string
  publishCommand: string
  repository: string
  rollbackCommands: [string, string]
}

export function prepareStablePromotion(options: {
  candidateVersion: string
  previousVersion: string
  release: CandidateRelease
  repository: string
  tag: string
}): StablePromotionPlan {
  const { candidateVersion, previousVersion, release, repository, tag } = options
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Stable release repository is invalid.')
  }
  for (const [label, version] of [['candidate', candidateVersion], ['baseline', previousVersion]] as const) {
    if (semver.valid(version) !== version || semver.prerelease(version) !== null) {
      throw new Error(`Stable ${label} must be a non-prerelease semantic version.`)
    }
  }
  if (tag !== `v${candidateVersion}` || release.tagName !== tag) {
    throw new Error('Stable candidate tag does not match its updater version.')
  }
  if (!release.isDraft) throw new Error('Stable candidate must remain a draft before promotion.')
  if (release.isPrerelease) throw new Error('Stable candidate cannot be a prerelease.')
  if (!semver.gt(candidateVersion, previousVersion)) {
    throw new Error('Stable candidate version must be greater than the public stable baseline.')
  }
  const previousTag = `v${previousVersion}`
  return {
    candidateTag: tag,
    candidateVersion,
    endpoint: `https://github.com/${repository}/releases/latest/download/latest.json`,
    previousTag,
    previousVersion,
    publishCommand: `gh release edit ${tag} --repo ${repository} --draft=false --latest`,
    repository,
    rollbackCommands: [
      `gh release edit ${tag} --repo ${repository} --draft`,
      `gh release edit ${previousTag} --repo ${repository} --latest`,
    ],
  }
}

function option(name: string): string {
  const value = process.argv[process.argv.indexOf(name) + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required.`)
  return value
}

function main(): void {
  const candidate = JSON.parse(readFileSync(option('--candidate'), 'utf8')) as { version?: unknown }
  const previous = JSON.parse(readFileSync(option('--previous'), 'utf8')) as { version?: unknown }
  const release = JSON.parse(readFileSync(option('--release'), 'utf8')) as CandidateRelease
  if (typeof candidate.version !== 'string' || typeof previous.version !== 'string') {
    throw new Error('Stable updater manifests must contain versions.')
  }
  const plan = prepareStablePromotion({
    candidateVersion: candidate.version,
    previousVersion: previous.version,
    release,
    repository: option('--repository'),
    tag: option('--tag'),
  })
  writeFileSync(option('--output'), `${JSON.stringify(plan, null, 2)}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Stable promotion validation failed.')
    process.exitCode = 1
  }
}
