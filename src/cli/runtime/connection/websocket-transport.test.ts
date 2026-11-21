import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import {
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'

const { sendRemoteRuntimeRequestOnSocketMock } = vi.hoisted(() => ({
  sendRemoteRuntimeRequestOnSocketMock: vi.fn()
}))

vi.mock('../../../shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: sendRemoteRuntimeRequestOnSocketMock
}))

import { sendWebSocketRequest } from './websocket-transport'

function fakeConnection(): PairedRuntimeConnection {
  const connection = { id: 'conn-1' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double passes a stub connection into mocked sendRemoteRuntimeRequestOnSocket.
  return connection as unknown as PairedRuntimeConnection
}

describe('websocket-transport client capabilities', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('scopes create.message capability to agentSession.create without leaking to agent.read or agentSession.rename', async () => {
    const sentCapabilities = new Map<string, readonly string[] | undefined>()
    sendRemoteRuntimeRequestOnSocketMock.mockImplementation(
      async (
        _connection: unknown,
        method: string,
        _params: unknown,
        _timeoutMs: number,
        _envelope: unknown,
        _validateStatus: unknown,
        _onProgress: unknown,
        capabilities: readonly string[] | undefined
      ) => {
        sentCapabilities.set(method, capabilities)
        return {
          id: `req-${method}`,
          ok: true,
          result: { ok: true },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
    )

    await sendWebSocketRequest(
      fakeConnection(),
      'agentSession.create',
      { agent: 'antigravity' },
      5000
    )
    await sendWebSocketRequest(fakeConnection(), 'agent.read', { id: 'orca_session_id:1' }, 5000)
    await sendWebSocketRequest(
      fakeConnection(),
      'agentSession.rename',
      { sessionId: 's-1', name: 'x' },
      5000
    )

    const createCaps = sentCapabilities.get('agentSession.create') ?? []
    expect(createCaps).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(createCaps).toContain(CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(createCaps).toContain(STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY)
    expect(createCaps).toContain(PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY)
    expect(createCaps).toContain(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)

    const readCaps = sentCapabilities.get('agent.read') ?? []
    expect(readCaps).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(readCaps).not.toContain(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)

    const renameCaps = sentCapabilities.get('agentSession.rename') ?? []
    expect(renameCaps).not.toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(renameCaps).not.toContain(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)
  })
})
