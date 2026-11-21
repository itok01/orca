import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { openCodexAppServerConnection } from '../../../../../codex/app-server/codex-app-server-connection'
import { createStructuredAgentSessionLogger } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { structuredAgentSessionCreateParams } from '../../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { stopStructuredAgentSessionRuntime } from '../../../../agent-session/installation/structured-agent-session-runtime'
import { ensureTestStructuredAgentSessionHost } from '../../../../agent-session/records/agent-session-record-store-test-harness'
import { scriptedCodexTransport } from '../../../../agent-session/testing/scripted-codex-transport.test-fixture'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcContext } from '../../../core'
import { handleStructuredAgentSessionCreate } from './structured-agent-session-create-handler'

type Harness = {
  dispose: () => Promise<void>
  publishTab: ReturnType<typeof vi.fn>
  focusHostWindow: ReturnType<typeof vi.fn>
  selectMobileTab: ReturnType<typeof vi.fn>
  createSpy: ReturnType<typeof vi.spyOn>
  attachSpy: ReturnType<typeof vi.spyOn>
  closeSessionTab: (sessionId: string) => Promise<void>
  failNextPresentationLookup: () => void
  ctx: (
    overrides?: Partial<Pick<RpcContext, 'caller' | 'clientKind' | 'clientCapabilities'>>
  ) => RpcContext
}

async function createHandlerHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'orca-create-handler-'))
  const openConnection: typeof openCodexAppServerConnection = async () => ({
    pid: 4321,
    closed: false,
    request: async (method) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1', path: '/rollouts/test.jsonl' } }
      }
      if (method === 'model/list') {
        return {
          data: [
            {
              model: 'gpt-live',
              displayName: 'GPT Live',
              hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
              defaultReasoningEffort: 'medium',
              isDefault: true
            }
          ],
          nextCursor: null
        }
      }
      return {}
    },
    notify: () => {},
    respond: () => {},
    respondWithError: () => {},
    close: async () => true
  })

  const host = await ensureTestStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async (workspaceId) => `/repos/${workspaceId}`,
    resolveCodexCommand: () => ({ command: '/usr/local/bin/codex', prefixArgs: [] }),
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveEnvironment: async () => ({ PATH: '/usr/bin', CODEX_HOME: '/tmp/codex-home' }),
    resolveAgentLaunchEnv: () => ({}),
    ...scriptedCodexTransport(openConnection)
  })
  const createSpy = vi.spyOn(host, 'create')
  const attachSpy = vi.spyOn(host, 'attach')
  const openTabs = new Set<string>()
  let failPresentationOnce = false
  const publishTab = vi.fn(async (input: { sessionId: string }) => {
    openTabs.add(input.sessionId)
  })
  const focusHostWindow = vi.fn()
  const selectMobileTab = vi.fn(async () => true)
  // Omit `adopt` so handler tests isolate at-rest routing and tab focus without reading external transcripts.
  const runtimeDouble = {
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    structuredAgentSessionLaunchSeedOptions: () => undefined,
    resolveStructuredAgentSessionCreateIntent: async () => ({
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree' as const
      },
      provider: 'codex' as const,
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME' as const, path: '/tmp/codex-home' },
      runtimeKind: 'native' as const
    }),
    currentLocalStructuredSessionPresentation: (sessionId: string) => {
      if (failPresentationOnce) {
        failPresentationOnce = false
        throw new Error('Chat presentation scope is unavailable')
      }
      return openTabs.has(sessionId)
        ? { worktreeId: 'workspace-1', tabId: `chat:${sessionId}` }
        : null
    },
    publishStructuredAgentSessionTab: publishTab,
    focusLaunchedChatInHostWindow: focusHostWindow,
    selectCreatedMobileSessionTabForClient: selectMobileTab,
    ensureStructuredAgentSessionHost: async () => getStructuredAgentSessionHost()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double implements only the create-handler methods exercised here.
  const runtime = runtimeDouble as unknown as OrcaRuntimeService

  return {
    publishTab,
    focusHostWindow,
    selectMobileTab,
    createSpy,
    attachSpy,
    closeSessionTab: async (sessionId: string) => {
      openTabs.delete(sessionId)
      await host.setSessionTabVisibility(sessionId, false)
    },
    failNextPresentationLookup: () => {
      failPresentationOnce = true
    },
    ctx: (overrides = {}) => {
      const context = {
        runtime,
        requestId: 'req-1',
        caller: { kind: 'local-cli' as const },
        clientKind: undefined,
        clientCapabilities: undefined,
        ...overrides
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test RPC context supplies only the caller and capability fields read by handleStructuredAgentSessionCreate.
      return context as unknown as RpcContext
    },
    dispose: async () => {
      vi.restoreAllMocks()
      await stopStructuredAgentSessionRuntime()
      await rm(root, { recursive: true, force: true })
    }
  }
}

describe('handleStructuredAgentSessionCreate', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('routes tab activation and host/paired-device focus by caller and activate flag', async () => {
    harness = await createHandlerHarness()

    const bgParams = structuredAgentSessionCreateParams({
      sessionId: 'session-bg-1',
      worktree: 'id:workspace-1',
      agent: 'codex',
      resumeFrom: { providerSessionId: 'thread-bg' },
      activate: false,
      randomUuid: randomUUID
    })
    const bgResult = await handleStructuredAgentSessionCreate(bgParams, harness.ctx())
    expect(bgResult).toMatchObject({ ok: true, value: { sessionId: 'session-bg-1' } })
    expect(harness.publishTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-bg-1', activate: false })
    )
    expect(harness.focusHostWindow).not.toHaveBeenCalled()

    const fgParams = structuredAgentSessionCreateParams({
      sessionId: 'session-fg-1',
      worktree: 'id:workspace-1',
      agent: 'codex',
      resumeFrom: { providerSessionId: 'thread-fg' },
      activate: true,
      randomUuid: randomUUID
    })
    const fgResult = await handleStructuredAgentSessionCreate(fgParams, harness.ctx())
    expect(fgResult).toMatchObject({ ok: true, value: { sessionId: 'session-fg-1' } })
    expect(harness.publishTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-fg-1', activate: true })
    )
    expect(harness.focusHostWindow).toHaveBeenCalledWith('workspace-1', 'session-fg-1')

    harness.focusHostWindow.mockClear()

    const pairedParams = structuredAgentSessionCreateParams({
      sessionId: 'session-paired-focus',
      worktree: 'id:workspace-1',
      agent: 'codex',
      resumeFrom: { providerSessionId: 'thread-paired' },
      activate: true,
      randomUuid: randomUUID
    })
    const pairedResult = await handleStructuredAgentSessionCreate(
      pairedParams,
      harness.ctx({
        caller: { kind: 'paired-device', deviceId: 'dev-1', agent: true },
        clientKind: 'runtime',
        clientCapabilities: [
          STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
          AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
        ]
      })
    )
    expect(pairedResult).toMatchObject({ ok: true, value: { sessionId: 'session-paired-focus' } })
    expect(harness.publishTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-paired-focus', activate: false })
    )
    expect(harness.selectMobileTab).toHaveBeenCalledWith(
      'workspace-1',
      { sessionId: 'session-paired-focus' },
      'dev-1'
    )
    expect(harness.focusHostWindow).not.toHaveBeenCalled()
  })

  it('keeps legacy local and runtime resumeFrom on attach unless activate or create.message capability is sent', async () => {
    harness = await createHandlerHarness()

    const cases = [
      {
        sessionId: 'session-local-cli-resume',
        thread: 'thread-local',
        activate: false,
        expectCreate: true
      },
      {
        sessionId: 'session-legacy-local-resume',
        thread: 'thread-legacy-local',
        expectCreate: false
      },
      {
        sessionId: 'session-runtime-no-cap',
        thread: 'thread-runtime-1',
        activate: false,
        expectCreate: false,
        ctx: {
          caller: { kind: 'desktop' as const },
          clientKind: 'runtime' as const,
          clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        }
      },
      {
        sessionId: 'session-runtime-with-cap',
        thread: 'thread-runtime-2',
        activate: false,
        expectCreate: true,
        ctx: {
          caller: { kind: 'paired-device' as const, deviceId: 'dev-1', agent: true as const },
          clientKind: 'runtime' as const,
          clientCapabilities: [
            STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
            AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
          ]
        }
      }
    ]
    for (const c of cases) {
      harness.createSpy.mockClear()
      harness.attachSpy.mockClear()
      const params = structuredAgentSessionCreateParams({
        sessionId: c.sessionId,
        worktree: 'id:workspace-1',
        agent: 'codex',
        resumeFrom: { providerSessionId: c.thread },
        ...(c.activate !== undefined ? { activate: c.activate } : {}),
        randomUuid: randomUUID
      })
      const result = await handleStructuredAgentSessionCreate(params, harness.ctx(c.ctx))
      expect(result).toMatchObject({ ok: true })
      expect(harness.createSpy).toHaveBeenCalledTimes(c.expectCreate ? 1 : 0)
      expect(harness.attachSpy).toHaveBeenCalledTimes(c.expectCreate ? 0 : 1)
    }
  })

  it('recovers tabUnconfirmed on same-envelope replay at rest without duplicating the session and preserves legacyReplay', async () => {
    harness = await createHandlerHarness()

    harness.publishTab.mockRejectedValueOnce(new Error('tab publication transient failure'))
    const resumeParams = structuredAgentSessionCreateParams({
      sessionId: 'session-tab-retry',
      worktree: 'id:workspace-1',
      agent: 'codex',
      resumeFrom: { providerSessionId: 'thread-retry' },
      activate: false,
      randomUuid: randomUUID
    })
    const firstAttempt = await handleStructuredAgentSessionCreate(resumeParams, harness.ctx())
    expect(firstAttempt).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        details: { reason: 'tabUnconfirmed' }
      }
    })

    const replayAttempt = await handleStructuredAgentSessionCreate(resumeParams, harness.ctx())
    expect(replayAttempt).toMatchObject({
      ok: true,
      replayed: true,
      value: { sessionId: 'session-tab-retry' }
    })
    expect(harness.createSpy).toHaveBeenCalledTimes(2)
    expect(harness.attachSpy).not.toHaveBeenCalled()
    expect(harness.publishTab).toHaveBeenCalledTimes(2)

    harness.createSpy.mockClear()
    harness.attachSpy.mockClear()

    const legacyAttachParams = structuredAgentSessionCreateParams({
      sessionId: 'session-legacy-replay',
      worktree: 'id:workspace-1',
      agent: 'codex',
      randomUuid: randomUUID
    })
    const firstLegacy = await handleStructuredAgentSessionCreate(
      legacyAttachParams,
      harness.ctx({
        caller: { kind: 'desktop' },
        clientKind: 'runtime',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      })
    )
    expect(firstLegacy).toMatchObject({ ok: true, replayed: false })
    expect(harness.attachSpy).toHaveBeenCalledTimes(1)
    expect(harness.createSpy).not.toHaveBeenCalled()

    const replayedLegacy = await handleStructuredAgentSessionCreate(
      legacyAttachParams,
      harness.ctx({
        caller: { kind: 'desktop' },
        clientKind: 'runtime',
        clientCapabilities: [
          STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
          AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
        ]
      })
    )
    expect(replayedLegacy).toMatchObject({ ok: true, replayed: true })
    expect(harness.attachSpy).toHaveBeenCalledTimes(2)
    expect(harness.createSpy).not.toHaveBeenCalled()
  })

  it('does not republish or refocus on same-envelope replay while open or after tab close', async () => {
    harness = await createHandlerHarness()

    const params = structuredAgentSessionCreateParams({
      sessionId: 'session-replay-life',
      worktree: 'id:workspace-1',
      agent: 'codex',
      resumeFrom: { providerSessionId: 'thread-replay-life' },
      activate: true,
      randomUuid: randomUUID
    })
    const created = await handleStructuredAgentSessionCreate(params, harness.ctx())
    expect(created).toMatchObject({
      ok: true,
      replayed: false,
      value: { sessionId: 'session-replay-life' }
    })
    expect(harness.publishTab).toHaveBeenCalledTimes(1)
    expect(harness.focusHostWindow).toHaveBeenCalledTimes(1)

    harness.publishTab.mockClear()
    harness.focusHostWindow.mockClear()

    const replayWhileOpen = await handleStructuredAgentSessionCreate(params, harness.ctx())
    expect(replayWhileOpen).toMatchObject({
      ok: true,
      replayed: true,
      value: { sessionId: 'session-replay-life' }
    })
    expect(harness.publishTab).not.toHaveBeenCalled()
    expect(harness.focusHostWindow).not.toHaveBeenCalled()

    harness.failNextPresentationLookup()
    const replayUnverified = await handleStructuredAgentSessionCreate(params, harness.ctx())
    expect(replayUnverified).toMatchObject({
      ok: true,
      replayed: true,
      value: { sessionId: 'session-replay-life' }
    })
    expect(harness.publishTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'session-replay-life', activate: false })
    )
    expect(harness.focusHostWindow).not.toHaveBeenCalled()
    harness.publishTab.mockClear()

    await harness.closeSessionTab('session-replay-life')

    const replayAfterClose = await handleStructuredAgentSessionCreate(params, harness.ctx())
    expect(replayAfterClose).toMatchObject({
      ok: true,
      replayed: true,
      value: { sessionId: 'session-replay-life' }
    })
    expect(replayAfterClose).not.toMatchObject({ value: { tabId: expect.any(String) } })
    expect(harness.publishTab).not.toHaveBeenCalled()
    expect(harness.focusHostWindow).not.toHaveBeenCalled()
  })
})
