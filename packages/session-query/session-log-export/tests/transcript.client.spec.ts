import { describe, expect, it } from 'vitest'
import type {
  AssistantBlock, CommandNode, CompactionSummaryNode, ConversationNode,
  ModelRetryNode, SteeringMessageNode, ToolCallBlock, ToolResultNode,
  TurnErrorNode, UnknownSurfaceNode,
} from '@buckeyestudio/toh-client-runtime/client'
import { serializeSessionTranscript } from '../src/client/transcript.ts'

const EXPORTED_AT = new Date('2026-08-23T14:02:11.000Z')

function user(text: string): ConversationNode {
  return { kind: 'user', seq: 0, time: 1, content: [{ type: 'text', text }], source: null }
}

function steering(text: string): SteeringMessageNode {
  return {
    kind: 'steering', messageId: 'msg-steer' as never, seq: 2, time: 3,
    content: [{ type: 'text', text }], source: null,
  }
}

function assistant(turn: number, blocks: AssistantBlock[]): ConversationNode {
  return { kind: 'assistant', seq: 1, time: 2, turn, step: 1, blocks }
}

function toolResult(overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result', seq: 5, time: 6, callId: 'call-1',
    call: { name: 'read_file', argsRaw: '{}' }, callTime: 5,
    content: [{ type: 'text', text: 'file contents' }], isError: false,
    callView: null, resultView: null, subCalls: [],
    ...overrides,
  }
}

describe('serializeSessionTranscript', () => {
  it('renders the document header with identity, timestamp, and rendered entry count', () => {
    const document = serializeSessionTranscript({
      sessionId: 'session-export-transcript' as never,
      nodes: [user('hello'), assistant(1, [{ kind: 'text', text: 'hi there' }])],
      exportedAt: EXPORTED_AT,
    })
    expect(document).toBe([
      '# Session transcript',
      '',
      '- Session: session-export-transcript',
      '- Exported: 2026-08-23T14:02:11.000Z',
      '- Entries: 2',
      '',
      '## User',
      '',
      'hello',
      '',
      '## Assistant (turn 1)',
      '',
      'hi there',
    ].join('\n'))
  })

  it('groups assistant turns, fences tool calls and results, and names subcalls', () => {
    const subCalls: ToolCallBlock[] = [
      { callId: 's1', name: 'grep_search', argsRaw: '{}', turn: 1, step: 2, time: 6, callView: null, subCalls: [] },
      toolResult({ callId: 's2', call: null }),
    ]
    const document = serializeSessionTranscript({
      sessionId: 'session-tools' as never,
      exportedAt: EXPORTED_AT,
      nodes: [
        user('find it'),
        assistant(3, [
          { kind: 'reasoning', text: 'secret plan' },
          { kind: 'tool-call', callId: 'c1', name: 'read_file', argsRaw: '{"path":"a.txt"}' },
        ]),
        toolResult({ subCalls }),
        assistant(4, [{ kind: 'text', text: 'done' }]),
      ],
    })

    expect(document).not.toContain('secret plan')
    expect(document).toContain('- Entries: 4')
    expect(document).toContain([
      '### Tool call: read_file',
      '',
      '```json',
      '{"path":"a.txt"}',
      '```',
    ].join('\n'))
    expect(document).toContain([
      '### Tool result: read_file',
      '',
      'Subcalls: grep_search, s2',
      '',
      '```text',
      'file contents',
      '```',
    ].join('\n'))
    expect(document).toContain('## Assistant (turn 3)')
    expect(document).toContain('## Assistant (turn 4)')
  })

  it('marks failed tool results and falls back to the pairing id without a call head', () => {
    const document = serializeSessionTranscript({
      sessionId: 'session-failed-tool' as never,
      exportedAt: EXPORTED_AT,
      nodes: [toolResult({ call: null, isError: true, content: [{ type: 'text', text: 'boom' }] })],
    })
    expect(document).toContain(['### Tool result: call-1 (error)', '', '```text', 'boom', '```'].join('\n'))
  })

  it('escapes transcript prose against heading, quote, rule, and fence injection', () => {
    const hostile = [
      '# injected heading',
      '###### deep forged heading',
      '> injected quote',
      '---',
      '```js',
      'code',
      '```',
      'plain trailing',
    ].join('\n')
    const document = serializeSessionTranscript({
      sessionId: 'session-hostile' as never,
      exportedAt: EXPORTED_AT,
      nodes: [user(hostile)],
    })
    expect(document).toContain([
      '## User',
      '',
      '\\# injected heading',
      '\\###### deep forged heading',
      '\\> injected quote',
      '\\---',
      '\\`\\`\\`js',
      'code',
      '\\`\\`\\`',
      'plain trailing',
    ].join('\n'))
  })

  it('escapes structure preceded by up to three leading spaces without losing the indent', () => {
    const hostile = [
      '  ## forged section',
      '   > forged quote',
      '   ---',
      '   ```js',
      '   code kept',
    ].join('\n')
    const document = serializeSessionTranscript({
      sessionId: 'session-indented' as never,
      exportedAt: EXPORTED_AT,
      nodes: [user(hostile)],
    })
    expect(document).toContain([
      '## User',
      '',
      '  \\## forged section',
      '   \\> forged quote',
      '   \\---',
      '   \\`\\`\\`js',
      '   code kept',
    ].join('\n'))
  })

  it('lengthens a fence past any line-start backtick run inside verbatim tool output', () => {
    const document = serializeSessionTranscript({
      sessionId: 'session-fence-war' as never,
      exportedAt: EXPORTED_AT,
      nodes: [
        assistant(1, [{ kind: 'tool-call', callId: 'c1', name: 'shell_run', argsRaw: 'echo hi\n```json\n{}' }]),
        toolResult({ content: [{ type: 'text', text: 'nested\n````\nfence' }] }),
      ],
    })
    expect(document).toContain('````json\necho hi\n```json\n{}\n````')
    expect(document).toContain('`````text\nnested\n````\nfence\n`````')
  })

  it('bounds tool excerpts with an explicit truncation marker', () => {
    const long = 'x'.repeat(1500)
    const document = serializeSessionTranscript({
      sessionId: 'session-excerpt' as never,
      exportedAt: EXPORTED_AT,
      nodes: [
        assistant(1, [{ kind: 'tool-call', callId: 'c1', name: 'big_tool', argsRaw: long }]),
        toolResult({ content: [{ type: 'text', text: `y${long}` }] }),
      ],
    })
    expect(document).toContain(`${'x'.repeat(600)}\n… [truncated 900 characters]`)
    expect(document).toContain(`y${'x'.repeat(599)}\n… [truncated 901 characters]`)
  })

  it('labels steering rows and renders command rows with their settlement', () => {
    const command: CommandNode = {
      kind: 'command', seq: 7, time: 8, commandId: 'cmd-1' as never,
      name: 'export', args: 'md', outcome: { kind: 'success' },
    }
    const failing: CommandNode = {
      kind: 'command', seq: 9, time: 10, commandId: 'cmd-2' as never,
      name: null, args: null, outcome: { kind: 'error', text: '# bad path\nsecond line' },
    }
    const pending: CommandNode = {
      kind: 'command', seq: 11, time: 12, commandId: 'cmd-3' as never,
      name: 'goal', args: '', outcome: null,
    }
    const document = serializeSessionTranscript({
      sessionId: 'session-commands' as never,
      exportedAt: EXPORTED_AT,
      nodes: [steering('mid-turn help'), command, failing, pending],
    })
    expect(document).toContain('## Steering')
    expect(document).toContain(['## Command /export', '', '```text', 'md', '```', '', 'Outcome: success'].join('\n'))
    expect(document).toContain('Outcome: error — \\# bad path second line')
    expect(document).toContain('## Command /unknown')
    expect(document).toContain('Outcome: pending')
  })

  it('renders lifecycle notes and skips context machinery', () => {
    const retry: ModelRetryNode = {
      kind: 'model-retry', seq: 12, time: 13, retryId: 'r1' as never,
      turn: 1, step: 1, provider: 'deepseek', mode: 'normal', policyKey: 'k',
      retry: 2, maxRetries: 5, delayMs: 4000, failure: { message: 'boom', code: 'X' },
      retryState: 'scheduled',
    }
    const turnError: TurnErrorNode = { kind: 'turn-error', seq: 14, time: 15, turn: 1, step: 1, message: 'provider down' }
    const compaction: CompactionSummaryNode = {
      kind: 'compaction', seq: 16, time: 17, summary: 'earlier work',
      summaryEventSeq: 15, shadowedItemCount: 42, shadowedTokenCount: 900,
    }
    const unknown: UnknownSurfaceNode = { kind: 'unknown', seq: 18, time: 19, type: 'plugin/whisper', data: null }
    const context = {
      kind: 'context', seq: 20, time: 21, content: [{ type: 'text', text: 'harness noise' }],
      source: null, provenance: { role: 'inject', label: 'plan-mode' }, form: null,
    } as unknown as ConversationNode
    const document = serializeSessionTranscript({
      sessionId: 'session-notes' as never,
      exportedAt: EXPORTED_AT,
      nodes: [retry, turnError, compaction, unknown, context],
    })
    expect(document).toContain('> Model retry scheduled (attempt 2 of 5).')
    expect(document).toContain('> Turn failed: provider down')
    expect(document).toContain('> Compaction checkpoint (42 items summarized):\n>\n> earlier work')
    expect(document).toContain('> Unsupported entry: plugin/whisper.')
    expect(document).not.toContain('harness noise')
    expect(document).toContain('- Entries: 4')
  })

  it('renders image-only messages as attachment placeholders', () => {
    const document = serializeSessionTranscript({
      sessionId: 'session-images' as never,
      exportedAt: EXPORTED_AT,
      nodes: [
        {
          kind: 'user', seq: 0, time: 1,
          content: [{ type: 'image', attachment: { id: 'att-1' } as never }],
          source: null,
        },
      ],
    })
    expect(document).toContain('## User')
    expect(document).toContain('[image attachment]')
  })

  it('produces a header-only document for an empty conversation window', () => {
    const document = serializeSessionTranscript({
      sessionId: 'session-blank' as never,
      exportedAt: EXPORTED_AT,
      nodes: [],
    })
    expect(document).toBe([
      '# Session transcript',
      '',
      '- Session: session-blank',
      '- Exported: 2026-08-23T14:02:11.000Z',
      '- Entries: 0',
    ].join('\n'))
  })
})
