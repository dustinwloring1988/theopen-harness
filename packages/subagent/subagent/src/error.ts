/**
 * Typed failures shared by subagent service and provider operations.
 *
 * @module @buckeyestudio/toh-subagent
 */

import { HarnessError } from '@buckeyestudio/toh-llm'

/** Typed failure for the subagent seam. */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}
