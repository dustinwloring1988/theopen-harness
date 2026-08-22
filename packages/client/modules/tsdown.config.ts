import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@buckeyestudio/toh-client-modules',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
