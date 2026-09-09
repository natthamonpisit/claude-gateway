import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FrontVoiceConfig, Logger, Message } from '../types';

// Nova CHARTER #40 ("gate แรกให้ตรงเข้า LLM ก่อนเลย"): a fresh, tool-less,
// low-effort call that answers directly (or hands off to the full session)
// before the slower Sonnet turn even starts. This module is pure
// orchestration — no Telegram/session-store side effects live here;
// src/agent/runner.ts owns sending the reply and deciding what happens next.
//
// Two transports (CHARTER #40, measured 2026-09-09): "http" posts straight
// to an Anthropic-compatible /v1/messages endpoint (GLM-5-turbo over
// api.z.ai measured 3.1-3.5s, $0, good Thai) and is the fast path; the
// original "claude-cli" transport (`claude -p`, ~10s end-to-end because of
// CLI startup) is kept as the default for backward compatibility and as the
// automatic fallback when the http call fails, times out, or comes back
// empty — front voice must never be the reason a message is lost.

const DEFAULT_RECENT_MESSAGES = 8;
const STATUS_TIMEOUT_MS = 4_000; // fixed per CHARTER #40 — not agent-configurable
const STATUS_CLIP_BYTES = 2048; // ~2KB
const MEMORY_CLIP_BYTES = 3072; // ~3KB
// Not spec'd explicitly — chosen conservatively: the whole point of the
// front voice is to be fast, so if it hasn't answered by here it's not
// doing its job and AgentRunner should fall back to the normal path instead
// of making Nat wait twice.
const FRONT_VOICE_TIMEOUT_MS = 20_000;
const DEFAULT_HTTP_TIMEOUT_MS = 12_000;
const DEFAULT_HTTP_MAX_TOKENS = 300;
const ANTHROPIC_VERSION = '2023-06-01';
const UNKNOWN_STATUS = 'ไม่ทราบ';
// Everything in AGENTS.md above this heading is Nova's persona/voice; the
// rest is operational rules meant for the full tool-using session, not the
// front voice. If an agent's AGENTS.md has no such heading, the whole file
// is used as-is (safe default rather than an empty prompt).
const PERSONA_SECTION_MARKER = '# กติกาและความสามารถของ Nova';

export interface FrontVoiceParams {
  claudeBin: string;
  workspace: string;
  cfg: FrontVoiceConfig;
  userText: string;
  /** Full recent history for this chat; only the last `cfg.recentMessages` are used. */
  recentMessages: Message[];
  logger: Logger;
}

export interface FrontVoiceOutcome {
  /** false = the call failed or produced nothing usable — caller should fall back to the normal session path. */
  ok: boolean;
  /** The reply to show Nat (handoff marker already stripped). Empty when !ok. */
  replyText: string;
  /** True when the reply ended with cfg.handoffMarker — caller should also dispatch the normal session path. */
  handoff: boolean;
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Expand a leading "~" (and only a leading "~") to the current user's home dir. */
function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function clip(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString('utf8')}\n...(truncated)`;
}

export function extractPersonaSection(agentsMd: string): string {
  const idx = agentsMd.indexOf(PERSONA_SECTION_MARKER);
  return (idx === -1 ? agentsMd : agentsMd.slice(0, idx)).trim();
}

/**
 * Run the agent's configured status command with a fixed timeout, clipped
 * to STATUS_CLIP_BYTES. Never throws and never returns empty — a missing
 * command, a non-zero exit, or a timeout all resolve to UNKNOWN_STATUS so a
 * flaky status probe never blocks the front voice from answering.
 */
export function runStatusCommand(command: string, timeoutMs = STATUS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (text: string): void => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(UNKNOWN_STATUS);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(out.trim() ? clip(out, STATUS_CLIP_BYTES) : UNKNOWN_STATUS);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(UNKNOWN_STATUS);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0 && out.trim() ? clip(out, STATUS_CLIP_BYTES) : UNKNOWN_STATUS);
    });
  });
}

/**
 * Everything the front voice knows *except* the new message: persona,
 * status, memory, recent conversation (background only — see instructions),
 * and the operating instructions themselves. Used as the http transport's
 * `system` field, and as the head of the claude-cli transport's single
 * prompt string (see buildCliPrompt).
 */
function buildSystemPrompt(opts: {
  persona: string;
  status: string;
  memory: string;
  recentMessages: Message[];
  handoffMarker: string;
}): string {
  const convo = opts.recentMessages
    .map((m) => `${m.role === 'user' ? 'Nat' : 'Nova'}: ${m.content}`)
    .join('\n');

  const instructions = [
    'คำสั่ง: ตอบเป็นภาษาไทยในฐานะ Nova ทันที เป็นข้อความสั้น กระชับ ตรงประเด็น',
    '[บทสนทนาล่าสุด] ถ้ามี คือบริบทประกอบเท่านั้น — ตอบเฉพาะ "ข้อความใหม่จาก Nat" ที่ให้มาในเทิร์นนี้ ' +
      'ห้ามหยิบเรื่องเก่าในนั้นมาสานต่อหรือพูดซ้ำ ห้ามพูดซ้ำคำตอบที่เคยตอบไปแล้ว',
    'ถ้าข้อความใหม่เป็นแค่คำทักทายสั้นๆ (เช่น "หวัดดี", "โย่ว", "อยู่มั้ย") ให้ทักทายกลับสั้นๆ ' +
      'แล้วต่อด้วยหนึ่งบรรทัดว่าตอนนี้กำลังเฝ้าอะไรอยู่ (อิงจาก [สถานะระบบ] เท่านั้น) จบแค่นั้น ไม่ต้องพูดเรื่องอื่น',
    'ห้ามพูดถึงว่าตัวเองเป็นบอทอัตโนมัติหรือไม่ใช่บอท เว้นแต่ Nat ถามเรื่องนี้ตรงๆ ในข้อความใหม่',
    `ถ้าคำขอนี้ต้องลงมือทำจริง (เช่น รันคำสั่ง ssh เข้าเครื่อง แก้ไฟล์ หรือสั่งงานอื่นที่ต้องใช้เครื่องมือ) ` +
      `ให้ตอบรับสั้นๆ ว่ากำลังจะไปทำ แล้วปิดท้ายข้อความด้วยบรรทัดใหม่ที่ขึ้นต้นด้วย "${opts.handoffMarker}" ตามด้วยสิ่งที่ต้องทำต่อแบบสั้นๆ`,
    `ถ้าตอบตรงๆ ได้เลยจากข้อมูลข้างต้น ไม่ต้องลงมือทำอะไรเพิ่ม ก็ตอบให้ครบไปเลย ห้ามใส่ "${opts.handoffMarker}"`,
  ].join('\n');

  return [
    opts.persona,
    '---',
    `[สถานะระบบ]\n${opts.status}`,
    `[บันทึกความจำ]\n${opts.memory || '(ไม่มี)'}`,
    convo ? `[บทสนทนาล่าสุด]\n${convo}` : '',
    instructions,
  ].filter(Boolean).join('\n\n');
}

/** claude-cli transport wants one prompt string on stdin — system block + the new message, in order. */
function buildCliPrompt(systemPrompt: string, userText: string): string {
  return `${systemPrompt}\n\n[ข้อความใหม่จาก Nat]\n${userText}`;
}

/**
 * Spawn one fresh `claude -p` turn: no --resume/--continue (a clean slate
 * every time), --tools "" (no tool use at all — this is a voice, not an
 * agent), the configured model/effort, text output. Prompt goes in on
 * stdin, same convention as the fast-path commands in receiver-server.ts.
 * Never throws — spawn errors and timeouts fold into a non-zero exitCode.
 */
function spawnClaudePrint(
  claudeBin: string,
  cfg: FrontVoiceConfig,
  prompt: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout });
    };
    const args = ['-p', '--model', cfg.model, '--effort', cfg.effort, '--output-format', 'text', '--tools', ''];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(claudeBin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      finish(127); // command not found / not executable
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124); // conventional shell timeout exit code
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', () => {}); // not user-facing; nothing to log without risking prompt content
    child.on('error', () => {
      clearTimeout(timer);
      finish(127);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
    child.stdin?.on('error', () => {}); // e.g. EPIPE if the process exits before reading stdin
    child.stdin?.end(prompt);
  });
}

/**
 * Run the claude-cli transport and return trimmed stdout, or null on any
 * failure (non-zero exit, timeout, empty output). Never throws.
 */
async function callCliTransport(
  claudeBin: string,
  cfg: FrontVoiceConfig,
  systemPrompt: string,
  userText: string,
  workspace: string,
): Promise<string | null> {
  const prompt = buildCliPrompt(systemPrompt, userText);
  const { exitCode, stdout } = await spawnClaudePrint(claudeBin, cfg, prompt, workspace, FRONT_VOICE_TIMEOUT_MS);
  const text = stdout.trim();
  if (exitCode !== 0 || !text) return null;
  return text;
}

/**
 * Run the http transport: POST straight to `<baseUrl>/v1/messages` (the
 * Anthropic Messages API shape, which GLM-5-turbo over api.z.ai and
 * compatible providers accept). `system` carries everything except the new
 * user text; the new user text is the single user message. Returns the
 * concatenated `content[].text`, or null on any error/timeout/empty
 * response — the key is read fresh from disk each call and is never logged,
 * including on failure.
 */
async function callHttpTransport(
  cfg: FrontVoiceConfig,
  systemPrompt: string,
  userText: string,
): Promise<string | null> {
  if (!cfg.baseUrl || !cfg.apiKeyFile) return null;

  let apiKey: string;
  try {
    apiKey = fs.readFileSync(expandHome(cfg.apiKeyFile), 'utf8').trim();
  } catch {
    return null;
  }
  if (!apiKey) return null;

  const timeoutMs = cfg.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? DEFAULT_HTTP_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userText }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = (data.content ?? []).map((c) => c.text ?? '').join('').trim();
    return text || null;
  } catch {
    // Covers network errors and the AbortError thrown on timeout.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip the trailing handoff marker (if present) and fold into the final outcome shape. Empty reply after stripping = failure. */
function finalizeOutcome(text: string, handoffMarker: string, logger: Logger): FrontVoiceOutcome {
  const markerIdx = text.indexOf(handoffMarker);
  const hasHandoff = markerIdx !== -1;
  const replyText = (hasHandoff ? text.slice(0, markerIdx) : text).trim();
  if (!replyText) {
    logger.warn('Front voice reply was empty after stripping handoff marker', { hasHandoff });
    return { ok: false, replyText: '', handoff: false };
  }
  return { ok: true, replyText, handoff: hasHandoff };
}

/**
 * Run the full front-voice turn: gather status + memory + recent context,
 * build the compact prompt, and get one fast reply from a fresh low-effort
 * call. `ok: false` means the caller must fall back to the normal session
 * path (front voice must never be the reason a message is lost).
 *
 * transport "http" tries the HTTP call first; on any failure it falls back
 * to the claude-cli transport before giving up. transport "claude-cli" (the
 * default) goes straight to the CLI, as before this option existed.
 */
export async function runFrontVoice(params: FrontVoiceParams): Promise<FrontVoiceOutcome> {
  const { claudeBin, workspace, cfg, userText, recentMessages, logger } = params;

  const status = await runStatusCommand(cfg.statusCommand);
  const persona = extractPersonaSection(readFileSafe(path.join(workspace, 'AGENTS.md')));
  const memory = clip(readFileSafe(path.join(workspace, 'MEMORY.md')), MEMORY_CLIP_BYTES);
  const recent = recentMessages.slice(-(cfg.recentMessages ?? DEFAULT_RECENT_MESSAGES));

  const systemPrompt = buildSystemPrompt({ persona, status, memory, recentMessages: recent, handoffMarker: cfg.handoffMarker });
  const transport = cfg.transport ?? 'claude-cli';

  if (transport === 'http') {
    const start = Date.now();
    const httpText = await callHttpTransport(cfg, systemPrompt, userText);
    const elapsedMs = Date.now() - start;
    if (httpText) {
      logger.info('Front voice answered', { transport: 'http', elapsedMs });
      return finalizeOutcome(httpText, cfg.handoffMarker, logger);
    }
    logger.warn('Front voice http transport failed — falling back to claude-cli', { transport: 'http', elapsedMs });
  }

  const cliStart = Date.now();
  const cliText = await callCliTransport(claudeBin, cfg, systemPrompt, userText, workspace);
  const cliElapsedMs = Date.now() - cliStart;
  if (!cliText) {
    logger.warn('Front voice call failed or produced no text', { transport: 'claude-cli', elapsedMs: cliElapsedMs });
    return { ok: false, replyText: '', handoff: false };
  }
  logger.info('Front voice answered', { transport: 'claude-cli', elapsedMs: cliElapsedMs });
  return finalizeOutcome(cliText, cfg.handoffMarker, logger);
}
