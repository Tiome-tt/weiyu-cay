import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readme = readFileSync('README.md', 'utf8')
const changelog = readFileSync('CHANGELOG.md', 'utf8')

describe('public release documentation', () => {
  it('keeps the latest-version and project-status sections on the recorded stable release', () => {
    const { version } = latestStableEntry(changelog)
    const latest = readme.split('## 最新版本')[1]?.split('\n## ')[0]
    const status = readme.split('## 项目状态')[1]?.split('\n## ')[0]

    expect(latest).toContain(`当前公开稳定版本为 [Cay v${version}]`)
    expect(status).toContain(`当前公开稳定版本为 v${version}`)
  })

  it('links every recorded installer to that stable release asset', () => {
    const { version, entry } = latestStableEntry(changelog)
    const installers = [...entry.matchAll(/^- (\S+\.(?:exe|msi|dmg)) — SHA256: `([a-fA-F0-9]{64})`\r?$/gm)]
      .map((match) => match[1])

    expect(installers.length).toBeGreaterThanOrEqual(3)
    for (const installer of installers) {
      expect(readme).toContain(`https://github.com/Tiome-tt/weiyu-cay/releases/download/v${version}/${installer}`)
    }
  })

  it('does not promote an unreleased candidate in front of the stable record', () => {
    const result = latestStableEntry('### 2.0.0 · Windows/macOS · 预发布\n候选\n### 1.2.3 · Windows/macOS · 稳定\n已发布\n### 1.2.2 · Windows/macOS · 稳定\n旧版')
    expect(result.version).toBe('1.2.3')
    expect(result.entry).toContain('已发布')
    expect(result.entry).not.toContain('候选')
    expect(result.entry).not.toContain('旧版')
  })
})

function latestStableEntry(text: string): { version: string; entry: string } {
  const heading = /^### (\d+\.\d+\.\d+) · .+ · 稳定\r?$/m.exec(text)
  if (heading === null) throw new Error('CHANGELOG.md has no stable release record.')
  const remainder = text.slice(heading.index + heading[0].length)
  const nextHeading = remainder.search(/^### /m)
  return {
    version: heading[1],
    entry: nextHeading < 0 ? remainder : remainder.slice(0, nextHeading),
  }
}
