import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FrontVoiceConfig, Logger, Message } from '../types';

// Nova CHARTER #40 ("gate แรกให้ตรงเข้า LLM ก่อนเลย"): a fresh, tool-less,
// low-effort `claude -p` call that answers directly (or hands off to the
// full session) before the slower Sonnet turn even starts. This module is
// pure orchestration — no Telegram/session-store side effects live here;
// src/agent/runner.ts owns sending the reply and deciding what happens next.

const DEFAULT_RECENT_MESSAGES = 8;
const STATUS_TIMEOUT_MS = 4_000; // fixed per CHARTER #40 — not agent-configurable
const STATUS_CLIP_BYTES = 2048; // ~2KB
const MEMORY_CLIP_BYTES = 3072; // ~3KB
// Not spec'd explicitly — chosen conservatively: the whole point of the
// front voice is to be fast, so if it hasn't answered by here it's not
// doing its job and AgentRunner should fall back to the normal path instead
// of making Nat wait twice.
const FRONT_VOICE_TIMEOUT_MS = 20_000;
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

function buildPrompt(opts: {
  persona: string;
  status: string;
  memory: string;
  recentMessages: Message[];
  userText: string;
  handoffMarker: string;
}): string {
  const convo = opts.recentMessages
    .map((m) => `${m.role === 'user' ? 'Nat' : 'Nova'}: ${m.content}`)
    .join('\n');

  const instructions = [
    'คำสั่ง: ตอบเป็นภาษาไทยในฐานะ Nova ทันที เป็นข้อความสั้น กระชับ ตรงประเด็น',
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
    `[ข้อความใหม่จาก Nat]\n${opts.userText}`,
    instructions,
  ].filter(Boolean).join('\n\n');
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
 * Run the full front-voice turn: gather status + memory + recent context,
 * build the compact prompt, and get one fast reply from a fresh low-effort
 * session. `ok: false` means the caller must fall back to the normal
 * session path (front voice must never be the reason a message is lost).
 */
export async function runFrontVoice(params: FrontVoiceParams): Promise<FrontVoiceOutcome> {
  const { claudeBin, workspace, cfg, userText, recentMessages, logger } = params;

  const status = await runStatusCommand(cfg.statusCommand);
  const persona = extractPersonaSection(readFileSafe(path.join(workspace, 'AGENTS.md')));
  const memory = clip(readFileSafe(path.join(workspace, 'MEMORY.md')), MEMORY_CLIP_BYTES);
  const recent = recentMessages.slice(-(cfg.recentMessages ?? DEFAULT_RECENT_MESSAGES));

  const prompt = buildPrompt({ persona, status, memory, recentMessages: recent, userText, handoffMarker: cfg.handoffMarker });

  const { exitCode, stdout } = await spawnClaudePrint(claudeBin, cfg, prompt, workspace, FRONT_VOICE_TIMEOUT_MS);
  const text = stdout.trim();
  if (exitCode !== 0 || !text) {
    logger.warn('Front voice call failed or produced no text', { exitCode, hasOutput: text.length > 0 });
    return { ok: false, replyText: '', handoff: false };
  }

  const markerIdx = text.indexOf(cfg.handoffMarker);
  const hasHandoff = markerIdx !== -1;
  const replyText = (hasHandoff ? text.slice(0, markerIdx) : text).trim();
  if (!replyText) {
    logger.warn('Front voice reply was empty after stripping handoff marker', { hasHandoff });
    return { ok: false, replyText: '', handoff: false };
  }

  return { ok: true, replyText, handoff: hasHandoff };
}
