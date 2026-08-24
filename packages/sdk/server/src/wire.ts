/**
 * JSON-RPC request-parameter schemas for the SDK runtime methods, validated at
 * the top of `HarnessSdkJsonRpcServer.handleRequest` before any typed handler
 * runs. The stdio peer is out-of-process and untrusted, so this boundary owns
 * the same admission policy the web gateway enforces on its payloads: known
 * fields only, prompt-side content only, and a precise `-32602` failure.
 *
 * @module @buckeyestudio/toh-sdk-jsonrpc-server/wire
 */

import { z } from 'zod'
import type { ContentBlock } from '@buckeyestudio/toh-llm'
import type { InitializeParams, SessionPromptParams } from '@buckeyestudio/toh-sdk-protocol'
import { JsonRpcResponseError } from '@buckeyestudio/toh-sdk-protocol'

/** JSON-RPC 2.0 reserved code for parameters that failed validation. */
const INVALID_PARAMS = -32602

/**
 * Raster media types accepted on the prompt wire — the same closed set the
 * web gateway's prompt schema admits.
 */
const imageMediaTypeSchema = z.union([
  z.literal('image/png'),
  z.literal('image/jpeg'),
  z.literal('image/webp'),
  z.literal('image/gif'),
])

/**
 * Durable image reference carried by core image blocks, mirroring the web
 * gateway's `imageAttachmentRefSchema` and keeping the internal ref's optional
 * `originalDimensions` downscale metadata that stripping would lose. The
 * `attachmentId` brand cast is the single `as unknown as` on the content-block
 * union below.
 */
/* jscpd:ignore-start -- mirrors the host gateway's schema plus the internal
   ref's downscale metadata; a published SDK package cannot import across into
   the BFF host plane, and each surface owns its own wire admission (the
   mirrored-predicate precedent). */
const imageAttachmentRefSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: imageMediaTypeSchema,
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),
  originalDimensions: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).optional(),
})
/* jscpd:ignore-end */

/**
 * Prompt-side content blocks only. Durable core content also carries the
 * harness-produced `tool-call`, `tool-result`, and `reasoning` tags; admitting
 * those from the wire would persist forged history into a session log as if
 * the harness had produced it. Unknown fields are stripped, matching the web
 * gateway's request-schema policy.
 */
const promptContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), attachment: imageAttachmentRefSchema }),
]) as unknown as z.ZodType<ContentBlock>

/**
 * Parameters for the process-wide SDK handshake. The cast records zod's
 * `maxTokens?: number | undefined` widening to the wire type's exact-optional
 * member — the two serialize identically, mirroring the web gateway's casts.
 */
export const initializeParamsSchema = z.object({
  cwd: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  maxTokens: z.number().refine(
    value => Number.isSafeInteger(value) && value > 0,
    { message: 'initialize maxTokens must be a positive safe integer' },
  ).optional(),
}) as unknown as z.ZodType<InitializeParams>

/** Parameters for one user turn on one SDK session. */
export const sessionPromptParamsSchema = z.object({
  sessionId: z.string().min(1),
  contentBlocks: z.array(promptContentBlockSchema),
}) as unknown as z.ZodType<SessionPromptParams>

/** Parameters of `shutdown`; the method takes none. */
export const shutdownParamsSchema = z.object({})

/**
 * Render one issue path as the dotted field reference named in the error.
 * @param path - the zod issue path segments.
 * @returns `(params)` for a top-level failure, else the dotted path.
 */
function formatIssuePath(path: PropertyKey[]): string {
  return path.length === 0 ? '(params)' : path.map(String).join('.')
}

/**
 * Validate one raw params record against its method schema.
 * @param schema - the dispatching method's parameter schema.
 * @param method - the JSON-RPC method name, named in the failure message.
 * @param params - the raw transport-decoded params.
 * @returns the parsed parameters for the typed handler; unknown fields stripped.
 * @throws JsonRpcResponseError with code -32602 when validation fails; the
 *   message names the method and every failing field, and `data.issues`
 *   carries the machine-readable issue list.
 */
export function parseWireParams<T>(schema: z.ZodType<T>, method: string, params: Record<string, unknown> | undefined): T {
  const result = schema.safeParse(params ?? {})
  if (!result.success) {
    throw new JsonRpcResponseError(
      INVALID_PARAMS,
      `invalid params for ${method}: ${result.error.issues.map(issue => `${formatIssuePath(issue.path)}: ${issue.message}`).join('; ')}`,
      { issues: result.error.issues },
    )
  }
  return result.data
}
