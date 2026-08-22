/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@buckeyestudio/toh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@buckeyestudio/toh-prototype' },
    })).toEqual([
      '@buckeyestudio/toh-prototype: experimental package name must start with "@buckeyestudio/toh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@buckeyestudio/toh-experimental-prototype: experimental package must set "private": true',
      '@buckeyestudio/toh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@buckeyestudio/toh-consumer',
          [section]: { '@buckeyestudio/toh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@buckeyestudio/toh-consumer: ${section}.@buckeyestudio/toh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@buckeyestudio/toh-test-only',
        devDependencies: { '@buckeyestudio/toh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@buckeyestudio/toh-experimental-consumer',
        dependencies: { '@buckeyestudio/toh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@buckeyestudio/toh-python-runtime',
        dependencies: { '@buckeyestudio/toh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@buckeyestudio/toh-python-runtime: dependencies.@buckeyestudio/toh-experimental-prototype must not reference an experimental package',
    ])
  })
})
