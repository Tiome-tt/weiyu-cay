import { describe, expect, it } from 'vitest'
import { prepareStablePromotion } from './prepare-stable-promotion'

describe('prepareStablePromotion', () => {
  it('creates an explicit publish, updater-smoke, and rollback plan above the public baseline', () => {
    expect(prepareStablePromotion({
      candidateVersion: '1.4.0',
      previousVersion: '1.3.2',
      repository: 'acme/simple-notes',
      release: { isDraft: true, isPrerelease: false, tagName: 'v1.4.0' },
      tag: 'v1.4.0',
    })).toEqual({
      candidateTag: 'v1.4.0',
      candidateVersion: '1.4.0',
      endpoint: 'https://github.com/acme/simple-notes/releases/latest/download/latest.json',
      previousTag: 'v1.3.2',
      previousVersion: '1.3.2',
      publishCommand: 'gh release edit v1.4.0 --repo acme/simple-notes --draft=false --latest',
      repository: 'acme/simple-notes',
      rollbackCommands: [
        'gh release edit v1.4.0 --repo acme/simple-notes --draft',
        'gh release edit v1.3.2 --repo acme/simple-notes --latest',
      ],
    })
  })

  it.each([
    ['same version', '1.4.0', '1.4.0'],
    ['older candidate', '1.3.9', '1.4.0'],
    ['prerelease candidate', '1.4.0-rc.1', '1.3.9'],
    ['prerelease baseline', '1.4.0', '1.3.9-rc.1'],
  ])('rejects %s', (_case, candidateVersion, previousVersion) => {
    expect(() => prepareStablePromotion({
      candidateVersion,
      previousVersion,
      repository: 'acme/simple-notes',
      release: { isDraft: true, isPrerelease: false, tagName: `v${candidateVersion}` },
      tag: `v${candidateVersion}`,
    })).toThrow()
  })

  it('rejects a candidate that is already public before the smoke protocol begins', () => {
    expect(() => prepareStablePromotion({
      candidateVersion: '1.4.0',
      previousVersion: '1.3.2',
      repository: 'acme/simple-notes',
      release: { isDraft: false, isPrerelease: false, tagName: 'v1.4.0' },
      tag: 'v1.4.0',
    })).toThrow('must remain a draft')
  })
})
