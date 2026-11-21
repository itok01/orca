import type { CommandSpec } from '../discovery/command-spec'
import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'

export const CHAT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['chat', 'rename'],
    summary: 'Rename a chat tab',
    usage: 'orca chat rename [--session <id>] --name <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'name'],
    notes: [
      '--session takes the chat session id `orca agent launch` prints. Run inside a chat, it defaults to that chat; with --environment it is required.',
      'The name shows in the tab, the sidebar, Session History and on paired phones, the same as renaming the tab by hand.'
    ],
    examples: [
      'orca chat rename --name "Migrate auth to OAuth"',
      'orca chat rename --session <sessionId> --name "Release notes" --json'
    ]
  },
  {
    path: ['chat', 'resume'],
    summary: 'Resume an existing agent conversation as a chat tab',
    usage:
      'orca chat resume --agent <id> --session <providerSessionId> [--worktree <selector>] [--focus] [--retry-resume <token>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'session', 'worktree', 'focus', 'retry-resume'],
    notes: [
      '--session is the provider conversation or thread id to resume (for example an Antigravity conversation UUID, Claude session id, or Codex thread id), never an `orca_session_id:` address.',
      'Supports agents with chat transcript import (antigravity, claude, codex, grok, hermes, omp, opencode, opencode2, pi). Returns `sessionId` (for `chat rename`), `address` (`orca_session_id:<id>` for `agent show/read` and `orchestration send`), and an open-presentation `tabId` (changes if closed and reopened). Refuses if already owned by an existing chat (open or closed) or a live terminal writer.',
      '--worktree defaults to the workspace containing the current directory locally; when targeting a paired remote host (--environment, ORCA_ENVIRONMENT, or --pairing-code; --environment local targets this machine), --worktree is required. Tabs open in the background unless --focus is passed.',
      'If an interrupted resume reports `retryResume` (`<sessionId>:<operationId>`), rerun the exact command with `--retry-resume <token>` before the retry window expires rather than starting a fresh resume.'
    ],
    examples: [
      'orca chat resume --agent antigravity --session <conversationId> --json',
      'orca chat resume --agent claude --session <providerSessionId> --worktree active --focus --json',
      'orca chat resume --environment prod --agent codex --session <threadId> --worktree folder:<id> --json'
    ]
  }
]
