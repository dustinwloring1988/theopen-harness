/** Web Session-log download command over the host endpoint owned by ApiProxy. */

import type { Context } from '@buckeyestudio/cordis'
// The /types subpath keeps this Host half's import graph free of the bare
// specifier's built declarations, which carry the host session-service
// Context merge; this package is the one split-face plugin registering a
// command, and that merge would shadow the browser half's client-runtime
// `sessions` typing in this package's single program.
import type { CommandResult } from '@buckeyestudio/toh-commands/types'
import {
  EXPORT_MARKDOWN_RESULT_TEXT, EXPORT_ZIP_RESULT_TEXT, parseExportInput,
} from './command.ts'

export const name = 'session-log-download'
export const inject = ['commands']

/** Narrow face of the human-command registry consumed by this plugin. */
interface ExportCommandRegistry {
  register(definition: {
    name: string
    description: string
    handler: (invocation: { readonly rawInput: string }) => CommandResult | Promise<CommandResult>
  }): () => void
}

const REQUESTED: CommandResult = {
  kind: 'success',
  text: EXPORT_ZIP_RESULT_TEXT,
}

const MARKDOWN_REQUESTED: CommandResult = {
  kind: 'success',
  text: EXPORT_MARKDOWN_RESULT_TEXT,
}

/**
 * Register the Web-only `/export` command that the browser download plugin observes.
 * @param ctx - Host context carrying the human-command registry.
 */
export function apply(ctx: Context): void {
  const commands = (ctx as Context & { commands: ExportCommandRegistry }).commands
  ctx.effect(() => commands.register({
    name: 'export',
    description: 'Download this Session log as a ZIP archive, or "md" for Markdown',
    handler: invocation => Promise.resolve(resultOf(invocation.rawInput)),
  }), 'session-log-download: command')
}

/**
 * Normalize one parsed `/export` invocation into the durable result.
 * @param rawInput - verbatim input after the command name.
 * @returns the acknowledged artifact request or rejection.
 */
function resultOf(rawInput: string): CommandResult {
  const parsed = parseExportInput(rawInput)
  switch (parsed.kind) {
    case 'zip': return REQUESTED
    case 'markdown': return MARKDOWN_REQUESTED
    case 'error': return parsed
  }
}
