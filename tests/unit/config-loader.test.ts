import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  loadConfig,
  ConfigValidationError,
  DuplicateAgentIdError,
  MissingEnvVarError,
} from '../../src/config/loader';

const FIXTURES = path.join(__dirname, '../fixtures/configs');

describe('config-loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));
    // Set required env vars for the valid-2-agents.json fixture
    process.env.ALFRED_BOT_TOKEN = 'alfred-test-token';
    process.env.BAERBEL_BOT_TOKEN = 'baerbel-test-token';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ALFRED_BOT_TOKEN;
    delete process.env.BAERBEL_BOT_TOKEN;
    delete process.env.TEST_TOKEN;
  });

  // -------------------------------------------------------------------------
  // U-CL-01: Valid config with 2 agents
  // -------------------------------------------------------------------------
  it('U-CL-01: loads a valid config with 2 agents', () => {
    const config = loadConfig(path.join(FIXTURES, 'valid-2-agents.json'));
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0].id).toBe('alfred');
    expect(config.agents[1].id).toBe('baerbel');
    // Env vars should be interpolated
    expect(config.agents[0].telegram.botToken).toBe('alfred-test-token');
    expect(config.agents[1].telegram.botToken).toBe('baerbel-test-token');
  });

  // -------------------------------------------------------------------------
  // U-CL-02: Missing agents array
  // -------------------------------------------------------------------------
  it('U-CL-02: throws ConfigValidationError when agents array is missing', () => {
    expect(() => loadConfig(path.join(FIXTURES, 'missing-agents.json'))).toThrow(
      ConfigValidationError
    );
    expect(() => loadConfig(path.join(FIXTURES, 'missing-agents.json'))).toThrow(/agents/i);
  });

  // -------------------------------------------------------------------------
  // U-CL-03: Agent missing id
  // -------------------------------------------------------------------------
  it('U-CL-03: throws ConfigValidationError when agent is missing id', () => {
    const configPath = path.join(tmpDir, 'no-id.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        description: 'no id here',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'open' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/id/i);
  });

  // -------------------------------------------------------------------------
  // U-CL-04: Agent missing botToken
  // -------------------------------------------------------------------------
  it('U-CL-04: skips agent when botToken is missing, throws if no agents remain', () => {
    const configPath = path.join(tmpDir, 'no-token.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        id: 'test-agent',
        description: 'missing bot token',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { allowedUsers: [], dmPolicy: 'open' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/no valid agents/i);
  });

  // -------------------------------------------------------------------------
  // U-CL-05: Duplicate agent IDs
  // -------------------------------------------------------------------------
  it('U-CL-05: throws DuplicateAgentIdError for duplicate agent IDs', () => {
    expect(() => loadConfig(path.join(FIXTURES, 'duplicate-ids.json'))).toThrow(
      DuplicateAgentIdError
    );
    expect(() => loadConfig(path.join(FIXTURES, 'duplicate-ids.json'))).toThrow('alfred');
  });

  // -------------------------------------------------------------------------
  // U-CL-06: Env var interpolation — variable set
  // -------------------------------------------------------------------------
  it('U-CL-06: interpolates ${VAR} when env variable is set', () => {
    process.env.TEST_TOKEN = 'my-real-token';
    const configPath = path.join(tmpDir, 'env-interp.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        id: 'test',
        description: 'env test',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: '${TEST_TOKEN}', allowedUsers: [], dmPolicy: 'open' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    const config = loadConfig(configPath);
    expect(config.agents[0].telegram.botToken).toBe('my-real-token');
  });

  // -------------------------------------------------------------------------
  // U-CL-07: Env var interpolation — missing variable
  // -------------------------------------------------------------------------
  it('U-CL-07: skips agent with missing env var, throws if no agents remain', () => {
    delete process.env.NONEXISTENT_VAR;
    const configPath = path.join(tmpDir, 'missing-env.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        id: 'test',
        description: 'env test',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: '${NONEXISTENT_VAR}', allowedUsers: [], dmPolicy: 'open' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/no valid agents/i);
  });

  // -------------------------------------------------------------------------
  // U-CL-08: dmPolicy valid values
  // -------------------------------------------------------------------------
  it('U-CL-08: accepts valid dmPolicy values (allowlist and open)', () => {
    const configPath = path.join(tmpDir, 'valid-policy.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [
        {
          id: 'agent-allowlist',
          description: '',
          workspace: '/tmp',
          env: '/tmp/.env',
          telegram: { botToken: 'tok-a', allowedUsers: [], dmPolicy: 'allowlist' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        },
        {
          id: 'agent-open',
          description: '',
          workspace: '/tmp',
          env: '/tmp/.env',
          telegram: { botToken: 'tok-b', allowedUsers: [], dmPolicy: 'open' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        },
      ],
    }));

    const config = loadConfig(configPath);
    expect(config.agents[0].telegram.dmPolicy).toBe('allowlist');
    expect(config.agents[1].telegram.dmPolicy).toBe('open');
  });

  // -------------------------------------------------------------------------
  // U-CL-09: dmPolicy invalid value
  // -------------------------------------------------------------------------
  it('U-CL-09: skips agent with invalid dmPolicy, throws if no agents remain', () => {
    const configPath = path.join(tmpDir, 'invalid-policy.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        id: 'test',
        description: '',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'everyone' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/no valid agents/i);
  });

  // -------------------------------------------------------------------------
  // U-CL-10: allowedUsers empty array
  // -------------------------------------------------------------------------
  it('U-CL-10: accepts empty allowedUsers array', () => {
    const configPath = path.join(tmpDir, 'empty-allowed.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        id: 'test',
        description: '',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'open' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    const config = loadConfig(configPath);
    expect(config.agents[0].telegram.allowedUsers).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------
  it('throws ConfigValidationError for missing gateway object', () => {
    const configPath = path.join(tmpDir, 'no-gateway.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: [{
        id: 'test',
        description: '',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'open' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError when config file does not exist', () => {
    expect(() => loadConfig('/nonexistent/path/config.json')).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError when config file is not valid JSON', () => {
    const configPath = path.join(tmpDir, 'bad-json.json');
    fs.writeFileSync(configPath, 'not { valid json');
    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
  });

  // -------------------------------------------------------------------------
  // Ack-first config (Nova CHARTER #39) — absent by default, validated when present
  // -------------------------------------------------------------------------
  function agentWithAck(ack: unknown) {
    return {
      id: 'test',
      description: '',
      workspace: '/tmp',
      env: '/tmp/.env',
      telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'open' },
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      ack,
    };
  }

  it('U-CL-ACK-01: loads a valid ack config', () => {
    const configPath = path.join(tmpDir, 'valid-ack.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [agentWithAck({ enabled: true, afterMs: 3000, phrases: ['หนึ่ง', 'สอง'] })],
    }));

    const config = loadConfig(configPath);
    expect(config.agents[0].ack).toEqual({ enabled: true, afterMs: 3000, phrases: ['หนึ่ง', 'สอง'] });
  });

  it('U-CL-ACK-02: absent ack is left undefined (feature off by default)', () => {
    const configPath = path.join(tmpDir, 'no-ack.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        id: 'test',
        description: '',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'open' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    const config = loadConfig(configPath);
    expect(config.agents[0].ack).toBeUndefined();
  });

  it('U-CL-ACK-03: skips agent when ack.enabled is missing/non-boolean', () => {
    const configPath = path.join(tmpDir, 'ack-bad-enabled.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [agentWithAck({ afterMs: 3000, phrases: ['a'] })],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/no valid agents/i);
  });

  it('U-CL-ACK-04: skips agent when ack.phrases is empty', () => {
    const configPath = path.join(tmpDir, 'ack-empty-phrases.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [agentWithAck({ enabled: true, phrases: [] })],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/no valid agents/i);
  });

  it('U-CL-ACK-05: skips agent when ack.phrases has a non-string entry', () => {
    const configPath = path.join(tmpDir, 'ack-bad-phrases.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [agentWithAck({ enabled: true, phrases: ['ok', 5] })],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
  });

  it('U-CL-ACK-06: skips agent when ack.afterMs is not a positive number', () => {
    const configPath = path.join(tmpDir, 'ack-bad-afterms.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [agentWithAck({ enabled: true, afterMs: 0, phrases: ['ok'] })],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
  });

  it('U-CL-ACK-07: accepts ack without afterMs (runtime default applies)', () => {
    const configPath = path.join(tmpDir, 'ack-no-afterms.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [agentWithAck({ enabled: true, phrases: ['ok'] })],
    }));

    const config = loadConfig(configPath);
    expect(config.agents[0].ack).toEqual({ enabled: true, phrases: ['ok'] });
  });
});
