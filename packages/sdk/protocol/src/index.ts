/**
 * Shared wire protocol for the TheOpen Harness SDK runtime: the
 * newline-delimited JSON-RPC stdio transport plus the named request, result,
 * and notification types both wire ends speak. The runtime server plugin
 * (`@buckeyestudio/toh-sdk-jsonrpc-server`) serves this protocol; SDK clients
 * (`@buckeyestudio/toh-sdk-client`, the Python SDK) drive it.
 *
 * @module @buckeyestudio/toh-sdk-protocol
 */

export { DEFAULT_MAX_FRAME_BYTES, JsonRpcLineTransport, JsonRpcResponseError } from './transport.ts'
export type { JsonRpcLineTransportOptions, JsonRpcTransportPeer } from './transport.ts'
export type {
  HarnessSdkNotificationMap,
  HarnessSdkRequestMap,
  InitializeParams,
  InitializeResult,
  SdkRunStatus,
  SessionEventNotification,
  SessionStatusNotification,
  SessionPromptParams,
  SessionPromptResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './types.ts'
