import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(
  '@buckeyestudio/toh-client-web',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
