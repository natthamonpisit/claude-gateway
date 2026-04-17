#!/usr/bin/env ts-node
/**
 * npm run pair -- --agent=<agentId> --code=<code>
 *
 * Multi-agent pairing helper for Claude Gateway.
 * Approves a pending Telegram pairing without needing an interactive Claude session.
 *
 * Steps:
 *  1. Reads gateway config to find the agent's workspace path
 *  2. Opens {workspace}/.telegram-state/access.json
 *  3. Verifies the code exists in pending and is not expired
 *  4. Adds senderId to allowFrom
 *  5. Writes {workspace}/.telegram-state/approved/<senderId> (content = chatId)
 *  6. Saves access.json
 *
 * The plugin polls approved/ every 5 seconds and sends "Paired! Say hi to Claude."
 * when it detects the file.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/)
    if (m) {
      result[m[1]] = m[2] !== undefined ? m[2] : true
    }
  }
  return result
}

const args = parseArgs(process.argv)
const agentId = args['agent'] as string | undefined
const code = (args['code'] as string | undefined)?.toLowerCase()

if (!agentId || !code) {
  console.error('Usage: npm run pair -- --agent=<agentId> --code=<code>')
  process.exit(1)
}

// Find gateway config
const configPath = (process.env.GATEWAY_CONFIG
  ? (process.env.GATEWAY_CONFIG.startsWith('~/')
    ? path.join(os.homedir(), process.env.GATEWAY_CONFIG.slice(2))
    : process.env.GATEWAY_CONFIG)
  : path.join(os.homedir(), '.claude-gateway', 'config.json'))

let config: { agents: Array<{ id: string; workspace: string }> }
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (err) {
  console.error(`Cannot read gateway config at ${configPath}: ${(err as Error).message}`)
  process.exit(1)
}

const agent = config.agents.find((a) => a.id === agentId)
if (!agent) {
  console.error(`Agent "${agentId}" not found in config`)
  console.error(`Available agents: ${config.agents.map(a => a.id).join(', ') || '(none)'}`)
  process.exit(1)
}

const workspace = agent.workspace.startsWith('~/')
  ? path.join(os.homedir(), agent.workspace.slice(2))
  : agent.workspace

const stateDir = path.join(workspace, '.telegram-state')
const accessFile = path.join(stateDir, 'access.json')
const approvedDir = path.join(stateDir, 'approved')

// Read access.json
let access: {
  dmPolicy: string
  allowFrom: string[]
  groups: Record<string, unknown>
  pending: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies?: number }>
}
try {
  access = JSON.parse(fs.readFileSync(accessFile, 'utf8'))
} catch (err) {
  console.error(`Cannot read access.json at ${accessFile}: ${(err as Error).message}`)
  process.exit(1)
}

if (!access.pending) {
  console.error(`No pending entries in access.json`)
  process.exit(1)
}

const entry = access.pending[code]
if (!entry) {
  console.error(`Code "${code}" not found in pending`)
  const pendingCodes = Object.keys(access.pending)
  if (pendingCodes.length > 0) {
    console.error(`Available pending codes: ${pendingCodes.join(', ')}`)
  } else {
    console.error(`No pending entries found`)
  }
  process.exit(1)
}

if (entry.expiresAt < Date.now()) {
  console.error(`Code "${code}" has expired (expired ${new Date(entry.expiresAt).toISOString()})`)
  process.exit(1)
}

// Approve pairing
const { senderId, chatId } = entry

// SEC-H1: senderId / chatId are written under approvedDir as filenames and
// echoed to allowFrom. The receiver already rejects non-numeric senderIds
// before creating pending entries, but defense-in-depth here guards against
// a manually-tampered access.json used to pivot into path traversal.
if (!/^\d+$/.test(senderId) || !/^-?\d+$/.test(chatId)) {
  console.error(`Refusing to approve pairing: malformed senderId/chatId ("${senderId}" / "${chatId}")`)
  process.exit(1)
}

delete access.pending[code]
if (!access.allowFrom.includes(senderId)) {
  access.allowFrom.push(senderId)
}

// Write access.json atomically
const tmp = accessFile + '.tmp'
fs.writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
fs.renameSync(tmp, accessFile)

// Write approved file (plugin polls this directory every 5s)
fs.mkdirSync(approvedDir, { recursive: true })
fs.writeFileSync(path.join(approvedDir, senderId), chatId)

console.log(`Paired: senderId=${senderId} for agent "${agentId}"`)
console.log(`  State dir: ${stateDir}`)
console.log(`  Plugin will send confirmation message within 5s.`)
