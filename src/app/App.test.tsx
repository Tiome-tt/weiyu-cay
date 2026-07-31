import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import { fakeAssetPort, fakeFolderPort, fakeNotePort, fakeSearchPort, fakeSystemPort } from '../test/fakes'

describe('App', () => {
  it('renders the local library shell without authentication', () => {
    render(
      <App
        services={{
          notes: fakeNotePort(),
          folders: fakeFolderPort(),
          system: fakeSystemPort(),
          assets: fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 }),
          search: fakeSearchPort(),
        }}
      />,
    )
    expect(screen.getByRole('application', { name: 'Simple Notes' })).toBeVisible()
    expect(screen.getByRole('navigation', { name: '文件夹' })).toBeVisible()
    expect(screen.queryByText(/sign in|登录/i)).not.toBeInTheDocument()
  })
})
