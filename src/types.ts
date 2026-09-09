export interface SessionConfig {
  idleTimeoutMinutes?: number; // default 30
  maxConcurrent?: number; // default 20
}

/**
 * One fast-path rule: an inbound DM whose (trimmed) text matches `match`
 * (case-insensitive regex) is handled by spawning `command` with `args`
 * instead of starting a Claude turn. Args may contain `$1`..`$9` placeholders
 * substituted from the rule's regex capture groups.
 */
export interface TelegramFastPathRule {
  match: string;
  args: string[];
  /** Send the command's stdout back to the chat. Default: false (the spawned command replies itself). */
  reply?: boolean;
}

/**
 * Zero-LLM fast path for an agent's Telegram receiver: inbound DMs matching
 * one of `rules` (first match wins) are handled by `command` instead of
 * being forwarded to Claude. See src/telegram/receiver.ts and
 * mcp/tools/telegram/receiver-server.ts for the runtime behavior.
 */
export interface TelegramFastPathConfig {
  command: string;
  rules: TelegramFastPathRule[];
  /** Max time to wait for the command, in ms. Default: 5000. */
  timeoutMs?: number;
}

export interface AgentConfig {
  id: string;
  description: string;
  workspace: string;
  env: string;
  telegram: {
    botToken: string;
    allowedUsers: number[];
    dmPolicy: 'allowlist' | 'open';
  };
  claude: {
    model: string;
    dangerouslySkipPermissions: boolean;
    extraFlags: string[];
  };
  /** Heartbeat / cron settings */
  heartbeat?: {
    rateLimitMinutes?: number; // default 30
  };
  /** Session pool settings */
  session?: SessionConfig;
  /** Agent's signature emoji (used in greetings/sign-offs) */
  signatureEmoji?: string;
  /** Zero-LLM fast path for simple commands (see TelegramFastPathConfig). Absent = no fast path (normal behavior). */
  fastPath?: TelegramFastPathConfig;
}

export interface AgentStats {
  id: string;
  isRunning: boolean;
  messagesReceived: number;
  messagesSent: number;
  lastActivityAt: string | null; // ISO timestamp
}

export interface WatchHandle {
  close(): void;
}

/**
 * Capability scopes that can be granted to an API key.
 *
 * `cron:command` — allows creating/updating cron jobs of `type: 'command'`,
 *   which execute arbitrary shell commands on the host. This is an RCE-class
 *   capability and must be granted explicitly (never the default).
 */
export type ApiKeyScope = 'cron:command';

export interface ApiKey {
  key: string;
  description?: string;
  agents: string[] | '*'; // agent IDs this key can access, or '*' for all
  /**
   * Optional capability scopes. If omitted, the key has no elevated scopes
   * and cannot perform privileged operations like shell-command cron jobs.
   */
  scopes?: ApiKeyScope[];
}

export interface ModelConfig {
  id: string;
  label: string;
  alias: string;
  contextWindow: number;
}

export interface GatewayConfig {
  gateway: {
    logDir: string;
    timezone: string;
    models?: ModelConfig[];
    api?: {
      keys: ApiKey[];
    };
  };
  agents: AgentConfig[];
}

export interface WorkspaceFiles {
  agentMd: string;
  identityMd: string;
  soulMd: string;
  userMd: string;
  heartbeatMd: string;
  memoryMd: string;

}

export interface HeartbeatTask {
  name: string;
  cron: string; // always stored as 5-field cron after parsing interval
  prompt: string;
}

export interface HeartbeatResult {
  taskName: string;
  sessionId: string;
  suppressed: boolean;
  rateLimited: boolean;
  response: string;
  durationMs: number;
  ts: string; // ISO timestamp
}

export interface LoadedWorkspace {
  systemPrompt: string;
  files: WorkspaceFiles;
  truncated: boolean;
  skillRegistry?: import('./skills').SkillRegistry;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
}

export interface SessionMeta {
  id: string;          // UUID
  name: string;        // user-set or auto-generated ("Session N")
  createdAt: number;
  lastActive: number;
  messageCount: number;
  totalTokensUsed: number;
  lastInputTokens?: number;
  loadedAtSpawn?: number;   // messages loaded into context at last spawn (≤ MAX_HISTORY_MESSAGES)
  archivedCount?: number;   // messages not loaded into context (older than loaded window)
  messageCountAtSpawn?: number; // total messageCount at spawn time, used to derive in-context count
}

export interface SessionIndex {
  activeSessionId: string;
  sessions: SessionMeta[];
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; name: string; id: string }
  | { type: 'thinking'; text: string }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string };

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// ─── Cron Manager Types ───────────────────────────────────────────────────────

export type CronScheduleKind = 'cron' | 'at';
export type CronJobType = 'command' | 'agent';

export interface CronJobState {
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  consecutiveErrors: number;
  runCount: number;
}

export interface CronJob {
  id: string;
  agentId: string;
  name: string;
  // Schedule fields
  scheduleKind?: CronScheduleKind;  // default: 'cron'
  schedule?: string;                // cron expression (kind=cron)
  scheduleAt?: string;              // ISO-8601 timestamp (kind=at)
  // Payload fields
  type?: CronJobType;               // default: 'command'
  command?: string;                 // shell command (type=command)
  prompt?: string;                  // agent prompt (type=agent)
  telegram?: string;                // chat_id to deliver agent response (type=agent, required)
  timeoutMs?: number;               // execution timeout ms (default 120000)
  // Lifecycle
  deleteAfterRun?: boolean;         // auto-delete after first successful run
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  state: CronJobState;
}

export interface CronJobCreate {
  agentId: string;
  name: string;
  // Schedule
  scheduleKind?: CronScheduleKind;
  schedule?: string;
  scheduleAt?: string;
  // Payload
  type?: CronJobType;
  command?: string;
  prompt?: string;
  telegram?: string;
  timeoutMs?: number;
  // Lifecycle
  deleteAfterRun?: boolean;
  enabled?: boolean;
}

export interface CronJobUpdate {
  name?: string;
  scheduleKind?: CronScheduleKind;
  schedule?: string;
  scheduleAt?: string;
  type?: CronJobType;
  command?: string;
  prompt?: string;
  telegram?: string;
  timeoutMs?: number;
  deleteAfterRun?: boolean;
  enabled?: boolean;
}

export interface CronRunLog {
  jobId: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  output: string;
  error: string | null;
}

export interface CronManagerConfig {
  storePath?: string;
  runsDir?: string;
}
