/**
 * URL guard for skill_install — blocks SSRF and enforces a host allowlist.
 *
 * Threat model: `skill_install` fetches an arbitrary URL and writes the
 * response into the agent's system prompt. A permissive fetch lets an
 * attacker (a) pull cloud-metadata / internal secrets and inject them into
 * the agent's context, and (b) plant a persistent prompt-injection.
 *
 * Defenses:
 *   1. Scheme must be HTTPS.
 *   2. Host must match the allowlist (defaults to GitHub raw/gist).
 *   3. DNS must not resolve to private / loopback / link-local / metadata IPs.
 *   4. Redirects are followed manually and each hop is re-validated.
 *   5. Content length and elapsed time are capped.
 */

import { lookup as dnsLookup, LookupAddress } from 'dns';
import { promisify } from 'util';
import * as net from 'net';

const dnsLookupAsync = promisify(dnsLookup);

const DEFAULT_ALLOWED_HOSTS = new Set<string>([
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'github.com',
]);

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

export interface GuardedFetchOptions {
  /** Override host allowlist. Falls back to env + defaults. */
  allowedHosts?: Set<string>;
  /** Max response size. Callers typically enforce their own cap after. */
  maxBytes?: number;
}

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlGuardError';
  }
}

/**
 * Parse CLAUDE_GATEWAY_SKILL_HOSTS env var (comma-separated) into a set.
 * Returns undefined if unset so callers can fall through to defaults.
 */
function allowedHostsFromEnv(): Set<string> | undefined {
  const raw = process.env.CLAUDE_GATEWAY_SKILL_HOSTS;
  if (!raw) return undefined;
  const entries = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return entries.length ? new Set(entries) : undefined;
}

function resolveAllowedHosts(override?: Set<string>): Set<string> {
  return override ?? allowedHostsFromEnv() ?? DEFAULT_ALLOWED_HOSTS;
}

/**
 * Returns true if the IP falls inside a range we refuse to reach —
 * loopback, private, link-local (incl. AWS/GCP metadata 169.254.169.254),
 * unique-local, unspecified, or multicast.
 */
export function isForbiddenIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true; // unparseable — fail closed

  if (family === 4) {
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    const [a, b] = parts;
    if (a === 10) return true;                               // 10.0.0.0/8
    if (a === 127) return true;                              // loopback
    if (a === 0) return true;                                // unspecified
    if (a === 169 && b === 254) return true;                 // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT 100.64/10
    if (a >= 224) return true;                               // multicast + reserved
    return false;
  }

  // IPv6 — normalize to lowercase, strip zone id
  const v6 = ip.toLowerCase().split('%')[0];
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7 ULA
  if (v6.startsWith('ff')) return true; // multicast
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — extract and recurse
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isForbiddenIp(mapped[1]);
  return false;
}

async function assertSafeHost(urlStr: string, allowedHosts: Set<string>): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new UrlGuardError(`Invalid URL: ${urlStr}`);
  }

  if (url.protocol !== 'https:') {
    throw new UrlGuardError('Only HTTPS URLs are allowed');
  }

  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new UrlGuardError(
      `Host "${host}" is not in the skill-install allowlist. ` +
        `Set CLAUDE_GATEWAY_SKILL_HOSTS to override.`
    );
  }

  // Resolve ALL addresses — attacker may register a name with mixed results.
  let addrs: LookupAddress[];
  try {
    addrs = await dnsLookupAsync(host, { all: true });
  } catch (err) {
    throw new UrlGuardError(`DNS lookup failed for "${host}": ${(err as Error).message}`);
  }

  if (!addrs.length) {
    throw new UrlGuardError(`DNS lookup returned no addresses for "${host}"`);
  }

  for (const addr of addrs) {
    if (isForbiddenIp(addr.address)) {
      throw new UrlGuardError(
        `Refusing to fetch "${host}" — resolves to blocked address ${addr.address}`
      );
    }
  }
}

/**
 * Fetch a URL with SSRF guards and manual redirect validation.
 * Returns the final response body as text.
 */
export async function guardedFetchText(
  urlStr: string,
  options: GuardedFetchOptions = {}
): Promise<{ url: string; body: string }> {
  const allowedHosts = resolveAllowedHosts(options.allowedHosts);
  let current = urlStr;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeHost(current, allowedHosts);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    // Manual redirect handling — validate the next hop before following it.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new UrlGuardError(`Redirect (${response.status}) without Location header`);
      }
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      throw new UrlGuardError(`Fetch failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.text();
    if (options.maxBytes && body.length > options.maxBytes) {
      throw new UrlGuardError(`Response exceeds ${options.maxBytes} byte limit`);
    }
    return { url: current, body };
  }

  throw new UrlGuardError(`Too many redirects (>${MAX_REDIRECTS})`);
}
