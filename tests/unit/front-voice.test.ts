/**
 * Unit tests for src/agent/front-voice.ts — specifically the "http" transport
 * added for Nova CHARTER #40 (GLM-5-turbo over api.z.ai measured 3.1-3.5s vs
 * ~10s for claude-cli) and its fallback chain to the pre-existing claude-cli
 * transport. AgentRunner-level integration (front voice inside a real
 * message flow) is covered separately in agent-runner.test.ts's "front
 * voice" describe block — these tests call runFrontVoice() directly.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock child_process (the claude-cli transport) ──────────────────────────

interface MockStdin {
  writable: boolean;
  write: jest.Mock;
  end: jest.Mock;
  on: jest.Mock;
}

interface MockChildProcess extends EventEmitter {
  stdin: MockStdin | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  killed: boolean;
  kill: jest.Mock;
  pid: number;
}

const allProcesses: MockChildProcess[] = [];

function makeMockProcess(): MockChildProcess {
  const stdin: MockStdin = { writable: true, write: jest.fn(), end: jest.fn(), on: jest.fn() };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const proc = new EventEmitter() as MockChildProcess;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 90000) + 10000;
  proc.kill = jest.fn((signal?: string) => {
    proc.killed = true;
    process.nextTick(() => proc.emit('exit', 0, signal ?? 'SIGTERM'));
    return true;
  });

  allProcesses.push(proc);
  return proc;
}

jest.mock('child_process', () => ({
  spawn: jest.fn((..._args) => makeMockProcess()),
}));

// ── Imports (after the mock) ────────────────────────────────────────────────

import { runFrontVoice, extractPersonaSection } from '../../src/agent/front-voice';
import { FrontVoiceConfig, Logger, Message } from '../../src/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met within timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Every real spawn() in front-voice.ts (status command, then claude-cli)
// goes through the mocked child_process, landing in allProcesses in call
// order. procCursor tracks how many have been consumed so far this test.
let procCursor = 0;

/** Wait for and drive the NEXT not-yet-resolved mock process to a result (status command, then claude-cli, in order). */
async function resolveNextCli(text: string, exitCode = 0): Promise<MockChildProcess> {
  await waitFor(() => allProcesses.length > procCursor);
  const proc = allProcesses[procCursor++]!;
  if (text) proc.stdout!.emit('data', Buffer.from(text));
  proc.emit('exit', exitCode);
  return proc;
}

function makeLogger(): Logger & { warnCalls: unknown[][]; infoCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];
  const infoCalls: unknown[][] = [];
  return {
    info: jest.fn((...args: unknown[]) => infoCalls.push(args)),
    warn: jest.fn((...args: unknown[]) => warnCalls.push(args)),
    error: jest.fn(),
    debug: jest.fn(),
    warnCalls,
    infoCalls,
  };
}

function baseCfg(overrides: Partial<FrontVoiceConfig> = {}): FrontVoiceConfig {
  return {
    enabled: true,
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    statusCommand: 'true', // real command: front-voice.ts's own status-command spawn also goes through the mocked spawn
    recentMessages: 8,
    handoffMarker: '[งานต่อ]',
    ...overrides,
  };
}

const RECENT_MESSAGES: Message[] = [
  { role: 'user', content: 'เมื่อกี้ถามเรื่องเดิม', ts: 1 },
  { role: 'assistant', content: 'ตอบไปแล้วว่าอย่างนี้ครับ', ts: 2 },
];

describe('front-voice — http transport (Nova CHARTER #40)', () => {
  let tmpDir: string;
  let workspace: string;
  let keyFile: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-test-'));
    workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'ตัวตนของ Nova\n\n# กติกาและความสามารถของ Nova\nrules here');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), 'จำไว้ว่า...');
    keyFile = path.join(tmpDir, 'api_key');
    fs.writeFileSync(keyFile, '  test-key-123 \n');

    allProcesses.length = 0;
    procCursor = 0;
    (require('child_process').spawn as jest.Mock).mockClear();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('U-FVH-01: builds the right request and returns the reply on success', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn((input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! });
      return Promise.resolve(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'สวัสดีครับอุ๊ก' }] }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const logger = makeLogger();
    const promise = runFrontVoice({
      claudeBin: 'claude',
      workspace,
      cfg: baseCfg({
        transport: 'http',
        baseUrl: 'https://api.z.ai/api/anthropic',
        apiKeyFile: keyFile,
        model: 'glm-5-turbo',
        maxTokens: 250,
        timeoutMs: 5000,
      }),
      userText: 'โย่ว โนว่า',
      recentMessages: RECENT_MESSAGES,
      logger,
    });
    await resolveNextCli('nova: ok'); // status command — the only spawn on the http success path

    const outcome = await promise;
    expect(outcome).toEqual({ ok: true, replyText: 'สวัสดีครับอุ๊ก', handoff: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.z.ai/api/anthropic/v1/messages');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key-123'); // trimmed
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe('glm-5-turbo');
    expect(body.max_tokens).toBe(250);
    expect(body.messages).toEqual([{ role: 'user', content: 'โย่ว โนว่า' }]);
    expect(typeof body.system).toBe('string');
    expect(body.system).not.toContain('โย่ว โนว่า'); // new user text is NOT folded into system

    // http succeeded — spawn was used only for the status command, never for a claude-cli fallback.
    expect(require('child_process').spawn as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('U-FVH-02: concatenates multiple content[].text blocks', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'ส่วนแรก ' }, { type: 'text', text: 'ส่วนสอง' }] }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const promise = runFrontVoice({
      claudeBin: 'claude',
      workspace,
      cfg: baseCfg({ transport: 'http', baseUrl: 'https://api.z.ai/api/anthropic', apiKeyFile: keyFile }),
      userText: 'test',
      recentMessages: [],
      logger: makeLogger(),
    });
    await resolveNextCli('nova: ok'); // status command

    const outcome = await promise;
    expect(outcome.ok).toBe(true);
    expect(outcome.replyText).toBe('ส่วนแรก ส่วนสอง');
  });

  it('U-FVH-03: strips the handoff marker and reports handoff:true', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ text: 'เดี๋ยวจัดการให้ครับ\n[งานต่อ] รีสตาร์ท nova' }] }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const promise = runFrontVoice({
      claudeBin: 'claude',
      workspace,
      cfg: baseCfg({ transport: 'http', baseUrl: 'https://api.z.ai/api/anthropic', apiKeyFile: keyFile }),
      userText: 'ช่วยรีสตาร์ท nova ให้หน่อย',
      recentMessages: [],
      logger: makeLogger(),
    });
    await resolveNextCli('nova: ok'); // status command

    const outcome = await promise;
    expect(outcome.ok).toBe(true);
    expect(outcome.handoff).toBe(true);
    expect(outcome.replyText).toBe('เดี๋ยวจัดการให้ครับ');
  });

  it('U-FVH-04: timeout falls back to claude-cli, which then succeeds', async () => {
    global.fetch = jest.fn((_input: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const logger = makeLogger();
    const promise = runFrontVoice({
      claudeBin: 'claude',
      workspace,
      cfg: baseCfg({
        transport: 'http',
        baseUrl: 'https://api.z.ai/api/anthropic',
        apiKeyFile: keyFile,
        timeoutMs: 50, // short so the test doesn't hang
      }),
      userText: 'โย่ว โนว่า',
      recentMessages: [],
      logger,
    });

    // First real spawn is the status command (statusCommand: 'true'); resolve
    // it, then the http timeout fires and the claude-cli fallback spawns.
    await resolveNextCli('nova: ok');
    await resolveNextCli('ตอบจาก claude-cli fallback');

    const outcome = await promise;
    expect(outcome).toEqual({ ok: true, replyText: 'ตอบจาก claude-cli fallback', handoff: false });
    expect(logger.warnCalls.some((c) => String(c[0]).includes('falling back to claude-cli'))).toBe(true);
  }, 10000);

  it('U-FVH-05: http failure AND claude-cli failure together mean ok:false (caller falls back to session)', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;

    const promise = runFrontVoice({
      claudeBin: 'claude',
      workspace,
      cfg: baseCfg({ transport: 'http', baseUrl: 'https://api.z.ai/api/anthropic', apiKeyFile: keyFile }),
      userText: 'hello',
      recentMessages: [],
      logger: makeLogger(),
    });

    await resolveNextCli('nova: ok'); // status command
    await resolveNextCli('', 1); // claude-cli fallback also fails

    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, replyText: '', handoff: false });
  }, 10000);

  it('U-FVH-06: missing apiKeyFile skips the HTTP call entirely and falls back to claude-cli', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = runFrontVoice({
      claudeBin: 'claude',
      workspace,
      cfg: baseCfg({
        transport: 'http',
        baseUrl: 'https://api.z.ai/api/anthropic',
        apiKeyFile: path.join(tmpDir, 'does-not-exist'),
      }),
      userText: 'hello',
      recentMessages: [],
      logger: makeLogger(),
    });

    await resolveNextCli('nova: ok'); // status command
    await resolveNextCli('ตอบจาก claude-cli'); // claude-cli fallback

    const outcome = await promise;
    expect(outcome).toEqual({ ok: true, replyText: 'ตอบจาก claude-cli', handoff: false });
    expect(fetchMock).not.toHaveBeenCalled();
  }, 10000);

  it('U-FVH-07: transport absent (default) goes straight to claude-cli, never calls fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = runFrontVoice({
      claudeBin: 'claude',
      workspace,
      cfg: baseCfg(), // no transport field — default 'claude-cli'
      userText: 'hello',
      recentMessages: [],
      logger: makeLogger(),
    });

    await resolveNextCli('nova: ok');
    await resolveNextCli('สวัสดีครับ');

    const outcome = await promise;
    expect(outcome.ok).toBe(true);
    expect(outcome.replyText).toBe('สวัสดีครับ');
    expect(fetchMock).not.toHaveBeenCalled();
  }, 10000);
});

describe('front-voice — prompt content (17:16 evidence, CHARTER #40)', () => {
  let tmpDir: string;
  let workspace: string;
  let keyFile: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-prompt-'));
    workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'persona\n\n# กติกาและความสามารถของ Nova\nrules');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '');
    keyFile = path.join(tmpDir, 'api_key');
    fs.writeFileSync(keyFile, 'k');
    allProcesses.length = 0;
    procCursor = 0;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('U-FVP-01: system prompt tells the model recent messages are background only and to answer only the new message', async () => {
    let capturedSystem = '';
    global.fetch = jest.fn((_input: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      capturedSystem = body.system;
      return Promise.resolve(new Response(JSON.stringify({ content: [{ text: 'ok' }] }), { status: 200 }));
    }) as unknown as typeof fetch;

    const promise = runFrontVoice({
      claudeBin: 'claude',
      workspace,
      cfg: baseCfg({ transport: 'http', baseUrl: 'https://api.z.ai/api/anthropic', apiKeyFile: keyFile }),
      userText: 'โย่ว โนว่า',
      recentMessages: RECENT_MESSAGES,
      logger: makeLogger(),
    });
    await resolveNextCli('nova: ok'); // status command
    await promise;

    // The 17:16 bug: front voice continued an older topic from recent
    // messages instead of answering the new one. The reworked instructions
    // must explicitly say recent messages are background only.
    expect(capturedSystem).toContain('บริบทประกอบเท่านั้น');
    expect(capturedSystem).toContain('ตอบเฉพาะ');
    expect(capturedSystem).toContain('ห้ามพูดซ้ำคำตอบที่เคยตอบไปแล้ว');
    // Still must not mention บอท/ตัวจริง unprompted.
    expect(capturedSystem).toContain('ห้ามพูดถึงว่าตัวเองเป็นบอท');
    // Handoff-marker rule is preserved.
    expect(capturedSystem).toContain('[งานต่อ]');
    // The old chat history IS still present as background context...
    expect(capturedSystem).toContain('ตอบไปแล้วว่าอย่างนี้ครับ');
    // ...but the new message itself is never embedded in the system block
    // (it's the separate user message for the http transport).
    expect(capturedSystem).not.toContain('โย่ว โนว่า');
  });
});

describe('extractPersonaSection', () => {
  it('U-FVX-01: keeps only the text above the persona-section marker', () => {
    const md = 'persona text\n\n# กติกาและความสามารถของ Nova\noperational rules';
    expect(extractPersonaSection(md)).toBe('persona text');
  });

  it('U-FVX-02: returns the whole file when the marker is absent', () => {
    const md = 'just a persona file with no operational heading';
    expect(extractPersonaSection(md)).toBe(md);
  });
});
