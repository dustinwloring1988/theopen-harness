#!/usr/bin/env node

import { Context } from '@buckeyestudio/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@buckeyestudio/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@buckeyestudio/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
