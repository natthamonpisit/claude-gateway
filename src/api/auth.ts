import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { ApiKey, ApiKeyScope } from '../types';

/**
 * Hashes a token with SHA-256 so comparison operates on fixed-length
 * digests. This prevents length-based timing side channels that would
 * otherwise leak how long the configured key is.
 */
function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest();
}

/**
 * Express middleware that validates the Bearer token or X-Api-Key header
 * against the configured API keys.
 *
 * Uses timing-safe comparison to prevent timing-based key enumeration attacks.
 * Attaches the matched ApiKey to `req.apiKey` on success.
 */
export function createApiAuthMiddleware(apiKeys: ApiKey[]) {
  return function apiAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers['authorization'];
    const xApiKey = req.headers['x-api-key'] as string | undefined;

    let token: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (xApiKey) {
      token = xApiKey.trim();
    }

    if (!token) {
      res.status(401).json({ error: 'Missing API key' });
      return;
    }

    // Compare SHA-256 digests so both operands are always 32 bytes.
    // This closes the length-based timing side channel in the previous
    // implementation, which returned early when buffer lengths differed.
    const tokenHash = sha256(token);
    const matched = apiKeys.find((k) => {
      try {
        return timingSafeEqual(sha256(k.key), tokenHash);
      } catch {
        return false;
      }
    });

    if (!matched) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    (req as Request & { apiKey: ApiKey }).apiKey = matched;
    next();
  };
}

/**
 * Returns true if the given API key is allowed to access the specified agent.
 */
export function canAccessAgent(apiKey: ApiKey, agentId: string): boolean {
  if (apiKey.agents === '*') return true;
  return (apiKey.agents as string[]).includes(agentId);
}

/**
 * Returns true if the given API key has been granted the requested scope.
 *
 * Scopes default to the empty set — callers that protect privileged
 * operations must fail closed when this returns false.
 */
export function hasScope(apiKey: ApiKey, scope: ApiKeyScope): boolean {
  return Array.isArray(apiKey.scopes) && apiKey.scopes.includes(scope);
}
