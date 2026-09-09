import * as fs from 'fs';
import { GatewayConfig, AgentConfig } from '../types';

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export class DuplicateAgentIdError extends Error {
  constructor(id: string) {
    super(`Duplicate agent id: "${id}"`);
    this.name = 'DuplicateAgentIdError';
  }
}

export class MissingEnvVarError extends Error {
  constructor(varName: string) {
    super(`Missing environment variable: ${varName}`);
    this.name = 'MissingEnvVarError';
  }
}

/**
 * Interpolate ${VAR} placeholders in a string value using process.env.
 * Throws MissingEnvVarError if any referenced variable is not set.
 */
function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new MissingEnvVarError(varName);
    }
    return envValue;
  });
}

/**
 * Recursively walk an object and interpolate all string values.
 */
function interpolateObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return interpolateEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateObject);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateObject(val);
    }
    return result;
  }
  return obj;
}

/**
 * Validate an agent config. Returns an error message if invalid, or null if valid.
 */
function validateAgent(agent: Record<string, unknown>, index: number): string | null {
  if (!agent.id || typeof agent.id !== 'string') {
    return `Agent at index ${index} is missing required field "id"`;
  }
  if (!agent.telegram || typeof agent.telegram !== 'object') {
    return `Agent "${agent.id}" is missing "telegram" config`;
  }
  const telegram = agent.telegram as Record<string, unknown>;
  if (!telegram.botToken || typeof telegram.botToken !== 'string') {
    return `Agent "${agent.id}" is missing "telegram.botToken"`;
  }
  if (telegram.dmPolicy !== 'allowlist' && telegram.dmPolicy !== 'open') {
    return `Agent "${agent.id}" has invalid dmPolicy "${telegram.dmPolicy}". Must be "allowlist" or "open".`;
  }

  if (agent.session !== undefined && typeof agent.session === 'object') {
    const session = agent.session as Record<string, unknown>;
    if (session.idleTimeoutMinutes !== undefined && (typeof session.idleTimeoutMinutes !== 'number' || session.idleTimeoutMinutes <= 0)) {
      return `agent '${agent.id}': session.idleTimeoutMinutes must be > 0`;
    }
    if (session.maxConcurrent !== undefined && (typeof session.maxConcurrent !== 'number' || session.maxConcurrent <= 0)) {
      return `agent '${agent.id}': session.maxConcurrent must be > 0`;
    }
  }

  if (agent.fastPath !== undefined) {
    if (typeof agent.fastPath !== 'object' || agent.fastPath === null) {
      return `agent '${agent.id}': fastPath must be an object`;
    }
    const fastPath = agent.fastPath as Record<string, unknown>;
    if (!fastPath.command || typeof fastPath.command !== 'string') {
      return `agent '${agent.id}': fastPath.command must be a non-empty string`;
    }
    if (!Array.isArray(fastPath.rules)) {
      return `agent '${agent.id}': fastPath.rules must be an array`;
    }
    for (let i = 0; i < fastPath.rules.length; i++) {
      const rule = fastPath.rules[i];
      if (typeof rule !== 'object' || rule === null) {
        return `agent '${agent.id}': fastPath.rules[${i}] must be an object`;
      }
      const r = rule as Record<string, unknown>;
      if (!r.match || typeof r.match !== 'string') {
        return `agent '${agent.id}': fastPath.rules[${i}].match must be a non-empty string`;
      }
      if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== 'string')) {
        return `agent '${agent.id}': fastPath.rules[${i}].args must be an array of strings`;
      }
      if (r.reply !== undefined && typeof r.reply !== 'boolean') {
        return `agent '${agent.id}': fastPath.rules[${i}].reply must be a boolean`;
      }
    }
    if (fastPath.timeoutMs !== undefined && (typeof fastPath.timeoutMs !== 'number' || fastPath.timeoutMs <= 0)) {
      return `agent '${agent.id}': fastPath.timeoutMs must be > 0`;
    }
  }

  // "Ack first, think after" (Nova CHARTER #39) — optional, off by default.
  // See AckConfig in types.ts for the runtime behavior.
  if (agent.ack !== undefined) {
    if (typeof agent.ack !== 'object' || agent.ack === null) {
      return `agent '${agent.id}': ack must be an object`;
    }
    const ack = agent.ack as Record<string, unknown>;
    if (typeof ack.enabled !== 'boolean') {
      return `agent '${agent.id}': ack.enabled must be a boolean`;
    }
    if (ack.afterMs !== undefined && (typeof ack.afterMs !== 'number' || ack.afterMs <= 0)) {
      return `agent '${agent.id}': ack.afterMs must be > 0`;
    }
    if (!Array.isArray(ack.phrases) || ack.phrases.length === 0 || ack.phrases.some((p) => typeof p !== 'string')) {
      return `agent '${agent.id}': ack.phrases must be a non-empty array of strings`;
    }
  }

  // "Front voice" pre-flight gate (Nova CHARTER #40) — optional, off by default.
  // See FrontVoiceConfig in types.ts for the runtime behavior.
  if (agent.frontVoice !== undefined) {
    if (typeof agent.frontVoice !== 'object' || agent.frontVoice === null) {
      return `agent '${agent.id}': frontVoice must be an object`;
    }
    const frontVoice = agent.frontVoice as Record<string, unknown>;
    if (typeof frontVoice.enabled !== 'boolean') {
      return `agent '${agent.id}': frontVoice.enabled must be a boolean`;
    }
    if (!frontVoice.model || typeof frontVoice.model !== 'string') {
      return `agent '${agent.id}': frontVoice.model must be a non-empty string`;
    }
    const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (typeof frontVoice.effort !== 'string' || !validEfforts.includes(frontVoice.effort)) {
      return `agent '${agent.id}': frontVoice.effort must be one of ${validEfforts.join(', ')}`;
    }
    if (!frontVoice.statusCommand || typeof frontVoice.statusCommand !== 'string') {
      return `agent '${agent.id}': frontVoice.statusCommand must be a non-empty string`;
    }
    if (frontVoice.recentMessages !== undefined && (typeof frontVoice.recentMessages !== 'number' || frontVoice.recentMessages <= 0)) {
      return `agent '${agent.id}': frontVoice.recentMessages must be > 0`;
    }
    if (!frontVoice.handoffMarker || typeof frontVoice.handoffMarker !== 'string') {
      return `agent '${agent.id}': frontVoice.handoffMarker must be a non-empty string`;
    }
    const validTransports = ['http', 'claude-cli'];
    if (frontVoice.transport !== undefined && (typeof frontVoice.transport !== 'string' || !validTransports.includes(frontVoice.transport))) {
      return `agent '${agent.id}': frontVoice.transport must be one of ${validTransports.join(', ')}`;
    }
    const transport = (frontVoice.transport as string | undefined) ?? 'claude-cli';
    if (transport === 'http') {
      if (!frontVoice.baseUrl || typeof frontVoice.baseUrl !== 'string') {
        return `agent '${agent.id}': frontVoice.baseUrl is required (non-empty string) when transport is "http"`;
      }
      if (!frontVoice.apiKeyFile || typeof frontVoice.apiKeyFile !== 'string') {
        return `agent '${agent.id}': frontVoice.apiKeyFile is required (non-empty string) when transport is "http"`;
      }
    }
    if (frontVoice.maxTokens !== undefined && (typeof frontVoice.maxTokens !== 'number' || frontVoice.maxTokens <= 0)) {
      return `agent '${agent.id}': frontVoice.maxTokens must be > 0`;
    }
    if (frontVoice.timeoutMs !== undefined && (typeof frontVoice.timeoutMs !== 'number' || frontVoice.timeoutMs <= 0)) {
      return `agent '${agent.id}': frontVoice.timeoutMs must be > 0`;
    }
  }
  return null;
}

/**
 * Load and validate config.json from the given path.
 * Interpolates ${VAR} env vars throughout the config.
 */
export function loadConfig(configPath: string): GatewayConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new ConfigValidationError(`Cannot read config file at "${configPath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigValidationError(`Config file is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigValidationError('Config must be a JSON object');
  }

  const config = parsed as Record<string, unknown>;

  if (!Array.isArray(config.agents)) {
    throw new ConfigValidationError('Config is missing required "agents" array');
  }

  if (!config.gateway || typeof config.gateway !== 'object') {
    throw new ConfigValidationError('Config is missing required "gateway" object');
  }

  // Validate each agent before interpolation — skip invalid agents with a warning
  const validAgents: Record<string, unknown>[] = [];
  const skippedAgents: string[] = [];
  for (let i = 0; i < (config.agents as unknown[]).length; i++) {
    const agent = (config.agents as unknown[])[i];
    if (typeof agent !== 'object' || agent === null) {
      console.warn(`[gateway] Skipping agent at index ${i}: must be an object`);
      skippedAgents.push(`index ${i}`);
      continue;
    }
    const error = validateAgent(agent as Record<string, unknown>, i);
    if (error) {
      const agentId = (agent as Record<string, unknown>).id || `index ${i}`;
      console.warn(`[gateway] Skipping agent "${agentId}": ${error}`);
      skippedAgents.push(String(agentId));
      continue;
    }
    validAgents.push(agent as Record<string, unknown>);
  }

  // Check for duplicate IDs among valid agents
  const ids = new Set<string>();
  for (const agent of validAgents) {
    const id = agent.id as string;
    if (ids.has(id)) {
      throw new DuplicateAgentIdError(id);
    }
    ids.add(id);
  }

  // Validate gateway.api.keys if present
  const gateway = config.gateway as Record<string, unknown>;
  if (gateway.api !== undefined) {
    const api = gateway.api as Record<string, unknown>;
    if (!Array.isArray(api.keys)) {
      throw new ConfigValidationError('gateway.api.keys must be an array');
    }
    const seenKeys = new Set<string>();
    for (const k of api.keys as unknown[]) {
      if (typeof k !== 'object' || k === null) {
        throw new ConfigValidationError('Each entry in gateway.api.keys must be an object');
      }
      const entry = k as Record<string, unknown>;
      if (!entry.key || typeof entry.key !== 'string') {
        throw new ConfigValidationError('Each API key must have a non-empty "key" string');
      }
      if (seenKeys.has(entry.key as string)) {
        throw new ConfigValidationError(`Duplicate API key value detected`);
      }
      seenKeys.add(entry.key as string);
      if (entry.agents !== '*' && !Array.isArray(entry.agents)) {
        throw new ConfigValidationError(
          `API key "${entry.key}": "agents" must be an array of agent IDs or the string "*"`,
        );
      }
    }
  }

  // Interpolate gateway config (fatal if env vars missing here)
  const interpolatedGateway = interpolateObject(config.gateway);

  // Interpolate each agent individually — skip agents with missing env vars
  const interpolatedAgents: unknown[] = [];
  for (const agent of validAgents) {
    try {
      interpolatedAgents.push(interpolateObject(agent));
    } catch (err) {
      if (err instanceof MissingEnvVarError) {
        console.warn(`[gateway] Skipping agent "${agent.id}": ${err.message}`);
        skippedAgents.push(String(agent.id));
        continue;
      }
      throw err;
    }
  }

  if (interpolatedAgents.length === 0) {
    throw new ConfigValidationError(
      'No valid agents found in config. All agents were skipped due to configuration errors.'
    );
  }

  if (skippedAgents.length > 0) {
    console.warn(`[gateway] ${skippedAgents.length} agent(s) skipped: ${skippedAgents.join(', ')}`);
  }

  return {
    agents: interpolatedAgents,
    gateway: interpolatedGateway,
  } as GatewayConfig;
}
