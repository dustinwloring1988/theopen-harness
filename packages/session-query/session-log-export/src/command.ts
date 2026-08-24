/** `/export` grammar shared by the Host command registration and the browser acknowledgment. */

/** Which artifact one successful `/export` asks this browser to download. */
export type ExportVariant = 'zip' | 'markdown'

/** Success text acknowledging a raw-ZIP request; also the durable command row's copy. */
export const EXPORT_ZIP_RESULT_TEXT = 'Session log download requested.'

/** Success text acknowledging a Markdown-transcript request; also the durable command row's copy. */
export const EXPORT_MARKDOWN_RESULT_TEXT = 'Markdown transcript download requested.'

/** One parsed `/export` invocation: the requested artifact or the rejection copy. */
export type ExportRequest =
  | { readonly kind: 'zip' }
  | { readonly kind: 'markdown' }
  | { readonly kind: 'error'; readonly text: string }

/**
 * Parse one `/export` invocation's raw input.
 * @param rawInput - verbatim input after the command name.
 * @returns the requested variant, or the rejection text for unsupported input.
 */
export function parseExportInput(rawInput: string): ExportRequest {
  const input = rawInput.trim()
  if (input === '') return { kind: 'zip' }
  if (input === 'md') return { kind: 'markdown' }
  return {
    kind: 'error',
    text: 'The Web /export command accepts no path; use "/export md" for a Markdown transcript.',
  }
}

/**
 * Read the artifact variant acknowledged by one successful `/export` result.
 * The handler owns both success texts, so this comparison is package-internal coupling.
 * @param resultText - the settled result's text.
 * @returns the artifact the submitting browser should download.
 */
export function exportVariantOf(resultText: string | undefined): ExportVariant {
  return resultText === EXPORT_MARKDOWN_RESULT_TEXT ? 'markdown' : 'zip'
}
