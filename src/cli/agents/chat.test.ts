import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_CREATE_ACTIVATE_RUNTIME_CAPABILITY } from '../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { RuntimeClient } from '../runtime/client'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/connection/types'
import { CHAT_HANDLERS } from './chat'

const FIXED_RETRY_SESSION_ID = '11111111-1111-4111-8111-111111111111'
const FIXED_RETRY_OP_ID = `1700000000000-${'a'.repeat(32)}`
const EXPECTED_RESUME_FINGERPRINT =
  'cc9826ad6b8088df83c3b07647068edb39a0beed99e988036d08784b4aa212ad'

function chatClient(isRemote: boolean): { client: RuntimeClient; call: ReturnType<typeof vi.fn> } {
  const client = new RuntimeClient('/tmp/orca-chat-test', 60_000, null, null)
  vi.spyOn(client, 'isRemote', 'get').mockReturnValue(isRemote)
  const call = vi.fn().mockResolvedValue({
    id: 'req-rename',
    ok: true,
    result: { name: 'Release notes', applied: true },
    _meta: { runtimeId: 'runtime-1' }
  })
  vi.spyOn(client, 'call').mockImplementation(call)
  return { client, call }
}

function rename(client: RuntimeClient): Promise<void> {
  return CHAT_HANDLERS['chat rename']({
    flags: new Map([['name', 'Release notes']]),
    client,
    cwd: '/tmp/worktree',
    json: true
  })
}

type ResumeClientOptions = {
  isRemote?: boolean
  capabilities?: readonly string[]
  worktreeShowRecord?: {
    id: string
    repoId?: string
    path?: string
    branch?: string
    identity?: { key: string }
  }
  worktreeShowError?: Error
  createResult?: unknown
  createError?: Error
}

function readEnvelopeSessionId(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'envelope' in value &&
    typeof value.envelope === 'object' &&
    value.envelope !== null &&
    'sessionId' in value.envelope &&
    typeof value.envelope.sessionId === 'string'
  ) {
    return value.envelope.sessionId
  }
  throw new Error(`Unexpected agentSession.create payload: ${JSON.stringify(value)}`)
}

function resumeClient(options: ResumeClientOptions = {}) {
  const client = new RuntimeClient('/tmp/orca-chat-test', 60_000, null, null)
  vi.spyOn(client, 'isRemote', 'get').mockReturnValue(options.isRemote ?? false)
  const capabilities = options.capabilities ?? [
    STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
    AGENT_SESSION_CREATE_ACTIVATE_RUNTIME_CAPABILITY
  ]
  const call = vi.fn().mockImplementation(async (method: string, params?: unknown) => {
    const ok = <T>(result: T) => ({
      id: `req-${method}`,
      ok: true as const,
      result,
      _meta: { runtimeId: 'runtime-1' }
    })
    switch (method) {
      case 'worktree.list':
        return ok({
          worktrees: [
            {
              id: 'repo-1::/tmp/worktree',
              repoId: 'repo-1',
              path: '/tmp/worktree',
              branch: 'main'
            }
          ]
        })
      case 'folderWorkspace.list':
        return ok({ folderWorkspaces: [] })
      case 'worktree.show': {
        if (options.worktreeShowError) {
          throw options.worktreeShowError
        }
        const selector =
          typeof params === 'object' &&
          params !== null &&
          'worktree' in params &&
          typeof params.worktree === 'string'
            ? params.worktree
            : undefined
        const record = options.worktreeShowRecord ?? {
          id: selector === 'folder:f-1' ? 'folder:f-1' : 'repo-1::/tmp/worktree',
          repoId: 'repo-1',
          path: '/tmp/worktree',
          branch: 'main'
        }
        return ok({ worktree: record })
      }
      case 'status.get':
        return ok({
          runtimeId: 'runtime-1',
          rendererGraphEpoch: 1,
          graphStatus: 'ready',
          authoritativeWindowId: 1,
          liveTabCount: 0,
          liveLeafCount: 0,
          capabilities
        })
      case 'agentSession.create': {
        if (options.createError) {
          throw options.createError
        }
        const sessionId = readEnvelopeSessionId(params)
        return ok(
          options.createResult ?? {
            ok: true,
            replayed: false,
            fence: 1,
            cursor: { seq: 1 },
            value: {
              sessionId,
              fence: 1,
              page: { items: [], oldestCursor: null, newestCursor: null, hasOlder: false },
              unconfirmedClientMessageIds: [],
              tabId: `chat:${sessionId}`
            }
          }
        )
      }
      default:
        throw new Error(`Unexpected RPC method in test: ${method}`)
    }
  })
  vi.spyOn(client, 'call').mockImplementation(call)
  return { client, call }
}

function runResume(
  client: RuntimeClient,
  entries: [string, string | boolean][] = [
    ['agent', 'antigravity'],
    ['session', 'antigravity-conv-1']
  ],
  json = true
): Promise<void> {
  return CHAT_HANDLERS['chat resume']({
    flags: new Map(entries),
    client,
    cwd: '/tmp/worktree',
    json
  })
}

describe('chat rename CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('never sends this machine’s chat id to a paired host', async () => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'chat-7')
    const { client, call } = chatClient(true)

    await expect(rename(client)).rejects.toThrow('Missing required --session: on a paired host')
    expect(call).not.toHaveBeenCalled()
  })
})

describe('chat resume CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('keeps payloadFingerprint invariant across background default and --focus', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const retryToken = `${FIXED_RETRY_SESSION_ID}:${FIXED_RETRY_OP_ID}`

    const { client: bgClient, call: bgCall } = resumeClient()
    await runResume(bgClient, [
      ['agent', 'antigravity'],
      ['session', 'antigravity-conv-1'],
      ['retry-resume', retryToken]
    ])
    expect(
      bgCall.mock.calls.find(([method]) => method === 'agentSession.create')?.[1]
    ).toMatchObject({
      envelope: {
        sessionId: FIXED_RETRY_SESSION_ID,
        clientOperationId: FIXED_RETRY_OP_ID,
        payloadFingerprint: EXPECTED_RESUME_FINGERPRINT
      },
      worktree: 'id:repo-1::/tmp/worktree',
      agent: 'antigravity',
      resumeFrom: { providerSessionId: 'antigravity-conv-1' },
      activate: false
    })

    const { client: fgClient, call: fgCall } = resumeClient()
    await runResume(fgClient, [
      ['agent', 'antigravity'],
      ['session', 'antigravity-conv-1'],
      ['retry-resume', retryToken],
      ['focus', true]
    ])
    expect(
      fgCall.mock.calls.find(([method]) => method === 'agentSession.create')?.[1]
    ).toMatchObject({
      envelope: { payloadFingerprint: EXPECTED_RESUME_FINGERPRINT },
      activate: true
    })
  })

  it('formats JSON with sessionId/address/tabId and text output concisely', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const retryToken = `${FIXED_RETRY_SESSION_ID}:${FIXED_RETRY_OP_ID}`

    await runResume(resumeClient().client, [
      ['agent', 'antigravity'],
      ['session', 'antigravity-conv-1'],
      ['retry-resume', retryToken]
    ])
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result).toEqual({
      sessionId: FIXED_RETRY_SESSION_ID,
      address: `orca_session_id:${FIXED_RETRY_SESSION_ID}`,
      agent: 'antigravity',
      providerSessionId: 'antigravity-conv-1',
      worktreeId: 'repo-1::/tmp/worktree',
      tabId: `chat:${FIXED_RETRY_SESSION_ID}`
    })

    await runResume(
      resumeClient().client,
      [
        ['agent', 'antigravity'],
        ['session', 'antigravity-conv-1'],
        ['retry-resume', retryToken]
      ],
      false
    )
    const textOutput = String(logSpy.mock.calls[1]?.[0])
    expect(textOutput).toContain('agent: antigravity')
    expect(textOutput).toContain(`sessionId: ${FIXED_RETRY_SESSION_ID}`)
    expect(textOutput).toContain(`address: orca_session_id:${FIXED_RETRY_SESSION_ID}`)
  })

  it.each([
    {
      name: 'missing activate.v1',
      capabilities: [STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY]
    },
    {
      name: 'missing resume-history.v1',
      capabilities: [AGENT_SESSION_CREATE_ACTIVATE_RUNTIME_CAPABILITY]
    },
    { name: 'missing both capabilities', capabilities: [] }
  ] satisfies { name: string; capabilities: readonly string[] }[])(
    'checks host capabilities before resolving workspaces ($name)',
    async ({ capabilities }) => {
      const { client, call } = resumeClient({ capabilities })
      await expect(
        runResume(client, [
          ['agent', 'antigravity'],
          ['session', 'conv-1'],
          ['worktree', 'branch:missing']
        ])
      ).rejects.toMatchObject({ code: 'incompatible_runtime' })
      expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    }
  )

  it('resolves explicit --worktree selectors to folder and identity prefixes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { client: folderClient, call: folderCall } = resumeClient({
      isRemote: true,
      worktreeShowRecord: { id: 'folder:f-1' }
    })

    await runResume(folderClient, [
      ['agent', 'codex'],
      ['session', 'thread-123'],
      ['worktree', 'name:MyFolder']
    ])
    expect(folderCall).toHaveBeenCalledWith('worktree.show', {
      worktree: 'name:MyFolder',
      matchFolderWorkspaces: true
    })
    expect(
      folderCall.mock.calls.find(([method]) => method === 'agentSession.create')?.[1]
    ).toMatchObject({ worktree: 'folder:f-1', agent: 'codex' })

    const { client: identityClient, call: identityCall } = resumeClient({
      worktreeShowRecord: {
        id: 'repo-1::/tmp/worktree',
        identity: { key: 'wt-key-1' }
      }
    })
    await runResume(identityClient, [
      ['agent', 'claude'],
      ['session', 'claude-1'],
      ['worktree', 'path:/tmp/worktree']
    ])
    expect(
      identityCall.mock.calls.find(([method]) => method === 'agentSession.create')?.[1]
    ).toMatchObject({ worktree: 'identity:wt-key-1', agent: 'claude' })
  })

  it.each([
    {
      name: 'missing --session',
      isRemote: false,
      entries: [['agent', 'claude']],
      message: '--session'
    },
    {
      name: 'orca_session_id address passed to --session',
      isRemote: false,
      entries: [
        ['agent', 'claude'],
        ['session', `orca_session_id:${FIXED_RETRY_SESSION_ID}`]
      ],
      message: 'orca agent show'
    },
    {
      name: 'paired host omitting --worktree',
      isRemote: true,
      entries: [
        ['agent', 'antigravity'],
        ['session', 'conv-1']
      ],
      message: '--worktree'
    },
    {
      name: 'paired host passing local active shortcut',
      isRemote: true,
      entries: [
        ['agent', 'codex'],
        ['session', 't-1'],
        ['worktree', 'active']
      ],
      message: 'active is a local cwd shortcut'
    },
    {
      name: 'empty --worktree',
      isRemote: false,
      entries: [
        ['agent', 'codex'],
        ['session', 't-1'],
        ['worktree', '']
      ]
    },
    {
      name: 'valueless --worktree',
      isRemote: false,
      entries: [
        ['agent', 'codex'],
        ['session', 't-1'],
        ['worktree', true]
      ]
    },
    {
      name: 'unknown --agent',
      isRemote: false,
      entries: [
        ['agent', 'not-an-agent'],
        ['session', 't-1']
      ]
    },
    {
      name: 'malformed --retry-resume token',
      isRemote: false,
      entries: [
        ['agent', 'codex'],
        ['session', 't-1'],
        ['retry-resume', `short:${FIXED_RETRY_OP_ID}`]
      ]
    }
  ] satisfies {
    name: string
    isRemote: boolean
    entries: [string, string | boolean][]
    message?: string
  }[])('rejects $name locally before issuing RPCs', async ({ isRemote, entries, message }) => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'chat-7')
    const { client, call } = resumeClient({ isRemote })

    const err = await runResume(client, entries).catch((error: unknown) => error)
    expect(err).toMatchObject({
      code: 'invalid_argument',
      ...(message ? { message: expect.stringContaining(message) } : {})
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('propagates selector_not_found from worktree resolution', async () => {
    const { client } = resumeClient({
      worktreeShowError: new RuntimeClientError(
        'selector_not_found',
        'No worktree matched branch:missing'
      )
    })
    await expect(
      runResume(client, [
        ['agent', 'codex'],
        ['session', 't-1'],
        ['worktree', 'branch:missing']
      ])
    ).rejects.toMatchObject({ code: 'selector_not_found' })
  })

  it.each([
    {
      name: 'unsent local runtime_unavailable preserves code and omits retryResume',
      error: new RuntimeClientError(
        'runtime_unavailable',
        'Runtime changed before sending request',
        {
          requestSent: false
        }
      ),
      expectedCode: 'runtime_unavailable',
      expectRetryToken: false
    },
    {
      name: 'unsent paired remote_runtime_unavailable preserves code and omits retryResume',
      error: new RuntimeClientError('remote_runtime_unavailable', 'Closed before hello', {
        requestSent: false
      }),
      expectedCode: 'remote_runtime_unavailable',
      expectRetryToken: false
    },
    {
      name: 'post-commit runtime_error attaches retryResume without detail',
      error: new RuntimeRpcFailureError({
        id: 'req-1',
        ok: false,
        error: { code: 'runtime_error', message: 'Journal cursor read failed after commit' },
        _meta: { runtimeId: 'runtime-1' }
      }),
      expectedCode: 'agent_session_operation_unknown',
      expectedCause: 'runtime_error',
      expectRetryToken: true
    },
    {
      name: 'deterministic bad_request RPC error passes through unchanged',
      error: new RuntimeRpcFailureError({
        id: 'req-1',
        ok: false,
        error: { code: 'bad_request', message: 'Invalid params' },
        _meta: { runtimeId: 'runtime-1' }
      }),
      expectedCode: 'bad_request',
      expectedMessage: 'Invalid params',
      expectRetryToken: false
    },
    {
      name: 'method_not_found maps to incompatible_runtime',
      error: new RuntimeRpcFailureError({
        id: 'req-1',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'runtime-1' }
      }),
      expectedCode: 'incompatible_runtime',
      expectRetryToken: false
    },
    {
      name: 'local disconnect runtime_unavailable attaches retryResume without detail',
      error: new RuntimeClientError('runtime_unavailable', 'Socket closed mid-request'),
      expectedCode: 'agent_session_operation_unknown',
      expectedCause: 'runtime_unavailable',
      expectedMessage: 'reply was lost before completion',
      expectRetryToken: true
    },
    {
      name: 'paired post-dispatch disconnect remote_runtime_unavailable attaches retryResume without detail',
      error: new RuntimeClientError('remote_runtime_unavailable', 'Remote socket closed (1006)'),
      expectedCode: 'agent_session_operation_unknown',
      expectedCause: 'remote_runtime_unavailable',
      expectedMessage: 'reply was lost before completion',
      expectRetryToken: true
    }
  ] satisfies {
    name: string
    error: Error
    expectedCode: string
    expectedCause?: string
    expectedMessage?: string
    expectRetryToken: boolean
  }[])(
    'maps thrown transport and RPC failures accurately: $name',
    async ({ error, expectedCode, expectedCause, expectedMessage, expectRetryToken }) => {
      const { client } = resumeClient({ createError: error })
      const caught = await runResume(client).catch((err: unknown) => err)

      expect(caught).toBeInstanceOf(RuntimeClientError)
      if (!(caught instanceof RuntimeClientError)) {
        throw new Error('Expected RuntimeClientError')
      }
      expect(caught).toMatchObject({
        code: expectedCode,
        ...(expectedMessage ? { message: expect.stringContaining(expectedMessage) } : {})
      })
      if (expectRetryToken) {
        expect(caught.data).toMatchObject({
          cause: expectedCause,
          retryResume: expect.stringContaining(':'),
          nextSteps: expect.arrayContaining([expect.stringContaining('--retry-resume')])
        })
        expect(caught.data).not.toHaveProperty('detail')
      } else {
        expect(caught.data).not.toMatchObject({ retryResume: expect.any(String) })
      }
    }
  )

  it('attaches retryResume on tabUnconfirmed refusal', async () => {
    const { client } = resumeClient({
      createResult: {
        ok: false,
        refusal: {
          code: 'agent_session_operation_unknown',
          message: 'internal log prose',
          details: { reason: 'tabUnconfirmed' }
        }
      }
    })
    const err = await runResume(client).catch((error: unknown) => error)
    expect(err).toMatchObject({
      code: 'agent_session_operation_unknown',
      message: expect.stringContaining('tab could not be confirmed'),
      data: {
        reason: 'tabUnconfirmed',
        sessionId: expect.any(String),
        operationId: expect.any(String),
        retryResume: expect.stringContaining(':'),
        nextSteps: expect.arrayContaining([expect.stringContaining('--retry-resume')])
      }
    })
  })

  it.each([
    {
      name: 'owned chat (open or closed)',
      refusal: {
        code: 'agent_session_conflict',
        message: 'internal log prose',
        details: {
          reason: 'conversationHeldElsewhere',
          owner: { sessionId: 'chat-9', workspaceId: 'ws-1' }
        }
      },
      expectedCode: 'agent_session_conflict',
      expectedMessage: 'open or closed in Session History',
      notExpectedMessage: 'already open'
    },
    {
      name: 'live terminal writer without owner',
      refusal: {
        code: 'agent_session_conflict',
        message: 'internal log prose',
        details: { reason: 'conversationHeldElsewhere' }
      },
      expectedCode: 'agent_session_conflict',
      expectedMessage: 'still running this conversation in a terminal',
      notExpectedMessage: 'existing Orca chat'
    },
    {
      name: 'otherFolder guidance',
      refusal: {
        code: 'agent_session_identity_required',
        message: 'internal log prose',
        details: { reason: 'transcriptUnreadable', otherFolder: true }
      },
      expectedCode: 'agent_session_identity_required',
      expectedMessage: 'Pass --worktree for a workspace rooted at that conversation'
    },
    {
      name: 'transcriptNotFound',
      refusal: {
        code: 'agent_session_identity_required',
        message: 'internal log prose',
        details: { reason: 'transcriptNotFound' }
      },
      expectedCode: 'agent_session_identity_required',
      expectedMessage: 'No saved Antigravity conversation found'
    },
    {
      name: 'operationIdReused conflict',
      refusal: {
        code: 'agent_session_operation_conflict',
        message: 'internal log prose',
        details: { reason: 'operationIdReused' }
      },
      expectedCode: 'agent_session_operation_conflict',
      expectedMessage: '--retry-resume token was reused with different arguments',
      notExpectedMessage: 'expired'
    },
    {
      name: 'operationExpired refusal',
      refusal: {
        code: 'agent_session_operation_expired',
        message: 'internal log prose',
        details: { reason: 'operationExpired' }
      },
      expectedCode: 'agent_session_operation_expired',
      expectedMessage: '--retry-resume retry window has expired'
    }
  ])(
    'translates $name refusals without exposing internal message prose',
    async ({ refusal, expectedCode, expectedMessage, notExpectedMessage }) => {
      const { client } = resumeClient({ createResult: { ok: false, refusal } })

      const caught = await runResume(client).catch((error: unknown) => error)
      expect(caught).toBeInstanceOf(RuntimeClientError)
      if (!(caught instanceof RuntimeClientError)) {
        throw new Error('Expected RuntimeClientError')
      }
      expect(caught).toMatchObject({
        code: expectedCode,
        message: expect.stringContaining(expectedMessage)
      })
      if (notExpectedMessage) {
        expect(caught.message).not.toContain(notExpectedMessage)
      }
      expect(caught.message).not.toContain('internal log prose')
    }
  )
})
