import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../dispatch/dispatch'
import {
  getPresentStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty,
  rejectValuelessFlag
} from '../arguments/flags'
import { assertLocalCwdWorktreeSelector } from '../hosts/local-environment-selector'
import { printResult } from '../output/command-result-output'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveCallerDistroPathSelector } from '../workspace-selection/wsl-caller-path-selector'
import { resolveCurrentWorktreeSelection } from '../workspace-selection/workspace-selector'
import { parseCliAgent } from './agent-launch-request'
import {
  explainResumeRefusal,
  explainResumeThrow,
  type ResumeRetryContext
} from './chat-resume-errors'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../shared/agent-session/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../shared/agent-session/identity/orca-session-address-prefix'
import { isAgentSessionId } from '../../shared/agent-session/lifecycle/agent-session-record'
import { AGENT_SESSION_CREATE_ACTIVATE_RUNTIME_CAPABILITY } from '../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { parseAgentSessionOperationTimestamp } from '../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import { structuredAgentSessionCreateParams } from '../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { StructuredAgentId } from '../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { parseWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'

type ChatRenameResult = { name: string | null; applied: boolean }

type ChatResumeResult = {
  sessionId: string
  address: string
  agent: StructuredAgentId
  providerSessionId: string
  worktreeId: string
  tabId?: string
}

export const CHAT_HANDLERS: Record<string, CommandHandler> = {
  'chat rename': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    // An empty --session must not fall back to this chat; the injected id is local-only.
    const sessionId =
      getPresentStringFlag(flags, 'session') ??
      (client.isRemote ? undefined : readInjectedAgentSessionId())
    if (!sessionId) {
      throw new RuntimeClientError(
        'invalid_argument',
        client.isRemote
          ? 'Missing required --session: on a paired host, name the chat by its session id.'
          : 'Missing required --session: this is not running inside a chat, so name the chat by its session id.'
      )
    }
    const result = await client
      .call<ChatRenameResult>('agentSession.rename', { sessionId, name })
      .catch((error: unknown) => {
        throw explainRenameRefusal(error, sessionId)
      })
    if (!result.result.applied) {
      throw new RuntimeClientError('invalid_argument', 'Not renamed: the name has no visible text.')
    }
    printResult(result, json, (value) => `Renamed chat to "${value.name}".`)
  },
  'chat resume': async ({ flags, client, cwd, json }) => {
    const tuiAgent = parseCliAgent(getRequiredStringFlag(flags, 'agent'))
    const providerSessionId = getRequiredStringFlag(flags, 'session')
    if (providerSessionId.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--session takes the provider's own conversation id (for example from \`orca search --json\` \`.sessionId\`), not an Orca chat address. To inspect an existing chat, use \`orca agent show ${providerSessionId}\`.`
      )
    }
    const retry = parseRetryResumeFlag(flags)
    validateResumeWorktreeFlag(flags, client)
    const focus = flags.get('focus') === true
    const status = await client.call<RuntimeStatus>('status.get')
    const capabilities = status.result.capabilities ?? []
    if (
      !capabilities.includes(STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY) ||
      !capabilities.includes(AGENT_SESSION_CREATE_ACTIVATE_RUNTIME_CAPABILITY)
    ) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host cannot safely resume conversations into chat tabs from the CLI. Update Orca on the execution host.'
      )
    }
    const { worktree, worktreeId } = await resolveResumeWorkspace(flags, cwd, client)
    const createParams = structuredAgentSessionCreateParams({
      sessionId: retry?.sessionId ?? randomUUID(),
      ...(retry ? { clientOperationId: retry.operationId } : {}),
      worktree,
      agent: tuiAgent,
      resumeFrom: { providerSessionId },
      activate: focus,
      randomUuid: randomUUID
    })
    const retryContext: ResumeRetryContext = {
      sessionId: createParams.envelope.sessionId,
      operationId: createParams.envelope.clientOperationId,
      retryToken: `${createParams.envelope.sessionId}:${createParams.envelope.clientOperationId}`
    }
    const response = await client
      .call<AgentSessionMutationResult<AgentSessionAttachResult>>(
        'agentSession.create',
        createParams
      )
      .catch((error: unknown) => {
        throw explainResumeThrow(error, tuiAgent, retryContext)
      })
    if (!response.result.ok) {
      throw explainResumeRefusal(response.result.refusal, tuiAgent, providerSessionId, retryContext)
    }
    const { value } = response.result
    const output: ChatResumeResult = {
      sessionId: value.sessionId,
      address: `${ORCA_SESSION_ADDRESS_PREFIX}${value.sessionId}`,
      agent: tuiAgent,
      providerSessionId,
      worktreeId,
      ...(value.tabId ? { tabId: value.tabId } : {})
    }
    printResult({ ...response, result: output }, json, formatChatResume)
  }
}

function parseRetryResumeFlag(
  flags: Map<string, string | boolean>
): { sessionId: string; operationId: string } | undefined {
  if (!flags.has('retry-resume')) {
    return undefined
  }
  const token = getRequiredStringFlagAllowingEmpty(flags, 'retry-resume')
  const separator = token.indexOf(':')
  const sessionId = separator > 0 ? token.slice(0, separator) : ''
  const operationId = separator > 0 ? token.slice(separator + 1) : ''
  if (!isAgentSessionId(sessionId) || parseAgentSessionOperationTimestamp(operationId) === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Malformed --retry-resume token. Use the <sessionId>:<operationId> token reported by the failed resume.'
    )
  }
  return { sessionId, operationId }
}

function validateResumeWorktreeFlag(
  flags: Map<string, string | boolean>,
  client: RuntimeClient
): void {
  if (client.isRemote && !flags.has('worktree')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Remote chat resume requires --worktree because the client cwd cannot identify a server worktree.'
    )
  }
  const rawWorktree = flags.get('worktree')
  rejectValuelessFlag(rawWorktree, 'worktree')
  if (rawWorktree === undefined) {
    return
  }
  if (rawWorktree === 'active' || rawWorktree === 'current') {
    assertLocalCwdWorktreeSelector(rawWorktree, client)
    return
  }
  if (typeof rawWorktree !== 'string' || rawWorktree.length === 0) {
    throw new RuntimeClientError('invalid_argument', '--worktree requires a non-empty selector.')
  }
}

async function resolveResumeWorkspace(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<{ worktree: string; worktreeId: string }> {
  const rawWorktree = flags.get('worktree')
  if (rawWorktree === undefined || rawWorktree === 'active' || rawWorktree === 'current') {
    const selection = await resolveCurrentWorktreeSelection(cwd, client, 'worktree')
    return { worktree: selection.selector, worktreeId: selection.worktreeId }
  }
  if (typeof rawWorktree !== 'string' || rawWorktree.length === 0) {
    throw new RuntimeClientError('invalid_argument', '--worktree requires a non-empty selector.')
  }
  const normalized = await resolveCallerDistroPathSelector(rawWorktree, cwd, client)
  const shown = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: normalized,
    matchFolderWorkspaces: true
  })
  const record = shown.result.worktree
  const worktree =
    parseWorkspaceKey(record.id)?.type === 'folder'
      ? record.id
      : record.identity?.key
        ? `identity:${record.identity.key}`
        : `id:${record.id}`
  return { worktree, worktreeId: record.id }
}

function formatChatResume(value: ChatResumeResult): string {
  return [
    `agent: ${value.agent}`,
    `sessionId: ${value.sessionId}`,
    `address: ${value.address}`,
    `providerSessionId: ${value.providerSessionId}`,
    `worktreeId: ${value.worktreeId}`,
    ...(value.tabId ? [`tabId: ${value.tabId}`] : [])
  ].join('\n')
}

// The host answers with bare wire codes; say what they mean for this command.
function explainRenameRefusal(error: unknown, sessionId: string): unknown {
  if (!(error instanceof RuntimeClientError)) {
    return error
  }
  if (error.message === 'agent_session_identity_required') {
    return new RuntimeClientError(
      'agent_session_identity_required',
      `No chat with session id ${sessionId} on this host.`
    )
  }
  if (
    error.message === 'structured_agent_session_unsupported' ||
    error.code === 'method_not_found'
  ) {
    return new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot rename chats from the CLI. Update Orca on that host, or check that it has chats turned on.'
    )
  }
  return error
}
