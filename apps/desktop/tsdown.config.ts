import { defineConfig } from 'tsdown'

/**
 * The desktop app ships two entries: the Electron main process plus the
 * Node-only backend module it composes. The root tsdown builds only
 * `lib/types/{index,invariant,startup}.js`, so this override names them; the
 * `electron` runtime stays external because the Electron binary itself is the
 * host process.
 */
export default defineConfig({
  entry: ['lib/types/main.js', 'lib/types/backend.js'],
  // Self-contained entries: the published `files` list carries only the two
  // named outputs, so shared-chunk splitting would emit unlisted artifacts.
  splitting: false,
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: ['electron'],
})
