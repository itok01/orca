import { isRequestUnsent } from '../runtime/connection/client-error-recovery'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/connection/types'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import type { AgentSessionRefusalReason } from '../../shared/agent-session/failures/agent-session-refusal-details'
import type { AgentSessionWireRefusal } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../shared/agent-session/identity/orca-session-address-prefix'

export type ResumeRetryContext = {
  sessionId: string
  operationId: string
  retryToken: string
}

const AMBIGUOUS_RESUME_TRANSPORT_CODES = new Set([
  'runtime_timeout',
  'runtime_unavailable',
  'remote_runtime_unavailable',
  'invalid_runtime_response'
])

function resumeUnknownOutcomeData(retry: ResumeRetryContext, extra?: Record<string, unknown>) {
  return {
    ...extra,
    sessionId: retry.sessionId,
    operationId: retry.operationId,
    retryResume: retry.retryToken,
    nextSteps: [
      `Rerun the exact same command on the same host with --retry-resume ${retry.retryToken}.`,
      'Or run `orca agent list --json` to check whether the chat is already open.'
    ]
  }
}

export function explainResumeThrow(
  error: unknown,
  agent: TuiAgent,
  retry: ResumeRetryContext
): unknown {
  if (!(error instanceof RuntimeClientError)) {
    return error
  }
  if (isRequestUnsent(error)) {
    return error
  }
  if (
    error.code === 'method_not_found' ||
    error.message === 'structured_agent_session_unsupported'
  ) {
    return new RuntimeClientError(
      'incompatible_runtime',
      `This Orca host cannot resume ${TUI_AGENT_DISPLAY_NAMES[agent]} conversations as chat tabs. Update Orca on that host, or check that chats are turned on.`
    )
  }
  if (error instanceof RuntimeRpcFailureError) {
    if (error.code === 'runtime_error') {
      return new RuntimeClientError(
        'agent_session_operation_unknown',
        'Orca encountered an error before confirming whether the chat was created.',
        resumeUnknownOutcomeData(retry, { cause: error.code })
      )
    }
    return error
  }
  if (AMBIGUOUS_RESUME_TRANSPORT_CODES.has(error.code)) {
    return new RuntimeClientError(
      'agent_session_operation_unknown',
      'Orca could not confirm whether the chat was created; the reply was lost before completion.',
      resumeUnknownOutcomeData(retry, { cause: error.code })
    )
  }
  return error
}

const INVALID_RESUME_REASON_MESSAGES: Partial<
  Record<
    AgentSessionRefusalReason<'agent_session_operation_invalid'>,
    (agentName: string) => string
  >
> = {
  conversationOpenInTerminal: (agentName) =>
    `${agentName} is still running this conversation in a terminal. Quit ${agentName} or close that terminal, then retry.`,
  cliMissing: (agentName) => `${agentName} is not installed on the execution host.`,
  notSignedIn: (agentName) =>
    `${agentName} is not signed in on the execution host. Sign in and retry.`,
  launchFolderMissing: () =>
    'The workspace folder for this conversation no longer exists on the execution host.',
  historyInOtherAccount: (agentName) =>
    `This ${agentName} conversation belongs to another account on the execution host.`
}

export function explainResumeRefusal(
  refusal: AgentSessionWireRefusal,
  agent: TuiAgent,
  providerSessionId: string,
  retry: ResumeRetryContext
): RuntimeClientError {
  const agentName = TUI_AGENT_DISPLAY_NAMES[agent]
  const details = refusal.details
  if (refusal.code === 'structured_agent_session_unsupported') {
    const message =
      details?.reason === 'hostDisabled'
        ? 'This Orca host cannot resume chats right now. Check that it has chats turned on.'
        : details?.reason === 'clientCapabilityMissing'
          ? 'This Orca host does not accept CLI resume requests for structured chats. Update Orca on that host.'
          : details?.reason === 'hostUnsupported'
            ? `${agentName} conversations cannot be resumed as chat tabs on this host.`
            : `Could not start ${agentName} chat on this host. Try again.`
    return new RuntimeClientError(refusal.code, message, details)
  }
  if (refusal.code === 'agent_session_identity_required') {
    const message =
      details?.reason === 'transcriptNotFound'
        ? `No saved ${agentName} conversation found for session ${providerSessionId}.`
        : details?.reason === 'transcriptUnreadable' && details.otherFolder === true
          ? `${agentName} session ${providerSessionId} belongs to a different folder, so it cannot be resumed in this workspace. Pass --worktree for a workspace rooted at that conversation's folder (register it as a folder workspace if needed).`
          : details?.reason === 'transcriptUnreadable'
            ? `Orca could not read the saved ${agentName} transcript for session ${providerSessionId}.`
            : `Could not resolve ${agentName} session ${providerSessionId} in this workspace.`
    return new RuntimeClientError(refusal.code, message, details)
  }
  if (
    refusal.code === 'agent_session_operation_conflict' &&
    (details?.reason === 'operationIdReused' || details?.reason === 'fingerprintMismatch')
  ) {
    return new RuntimeClientError(
      refusal.code,
      'Cannot retry resume: the --retry-resume token was reused with different arguments, host, or workspace than the original request. Check `orca agent list --json` or rerun the exact original command.',
      details
    )
  }
  if (refusal.code === 'agent_session_operation_expired') {
    return new RuntimeClientError(
      refusal.code,
      'Cannot retry resume: the --retry-resume retry window has expired. Run `orca agent list --json` to check whether the chat was already created before starting a new resume.',
      details
    )
  }
  if (
    refusal.code === 'agent_session_conflict' ||
    refusal.code === 'agent_session_ownership_unknown'
  ) {
    const message =
      details?.reason === 'conversationHeldElsewhere'
        ? details.owner
          ? `An existing Orca chat owns this ${agentName} conversation: ${ORCA_SESSION_ADDRESS_PREFIX}${details.owner.sessionId} (it may be open or closed in Session History). Use \`orca agent show ${ORCA_SESSION_ADDRESS_PREFIX}${details.owner.sessionId}\` to check its open locations.`
          : `${agentName} is still running this conversation in a terminal. Quit ${agentName} there, then retry.`
        : `Cannot resume ${agentName} session ${providerSessionId} (${details?.reason ?? refusal.code}).`
    return new RuntimeClientError(refusal.code, message, details)
  }
  if (refusal.code === 'agent_session_operation_unknown') {
    const message =
      details?.reason === 'tabUnconfirmed'
        ? 'The chat may have been created, but its tab could not be confirmed.'
        : 'Orca could not confirm whether the chat was created.'
    return new RuntimeClientError(
      refusal.code,
      message,
      resumeUnknownOutcomeData(retry, details ? { ...details } : undefined)
    )
  }
  if (refusal.code === 'agent_session_operation_invalid') {
    const formatter = details?.reason ? INVALID_RESUME_REASON_MESSAGES[details.reason] : undefined
    const message = formatter
      ? formatter(agentName)
      : `Cannot resume ${agentName} session ${providerSessionId}${details?.reason ? ` (${details.reason})` : ''}.`
    return new RuntimeClientError(refusal.code, message, details)
  }
  const suffix = details?.reason ? `${refusal.code}: ${details.reason}` : refusal.code
  return new RuntimeClientError(
    refusal.code,
    `Cannot resume ${agentName} session ${providerSessionId} (${suffix}).`,
    details
  )
}
