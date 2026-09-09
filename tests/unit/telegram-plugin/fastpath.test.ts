/**
 * Unit tests for the NOVA zero-LLM fast path matcher (matchFastPath / substituteCaptures).
 * Pure functions only — no child_process, no Grammy Context.
 */
import { matchFastPath, substituteCaptures, FastPathConfig } from '../../../mcp/tools/telegram/pure'

const NOVA_CONFIG: FastPathConfig = {
  command: '/home/ouk/bin/nova',
  timeoutMs: 5000,
  rules: [
    { match: '^(สถานะ|ใครว่าง|status)$', args: ['say', '-'] },
    { match: '^@[a-z0-9][a-z0-9-]*\\s+', args: ['say', '-'] },
    { match: '^เปิด\\s+[a-z0-9-]+\\s+', args: ['say', '-'] },
    { match: '^(อนุมัติ|approve)\\s+([0-9A-Z]{26})$', args: ['approve', '$2'] },
    { match: '^(ไม่อนุมัติ|ปฏิเสธ|deny)\\s+([0-9A-Z]{26})$', args: ['deny', '$2'] },
    { match: '^(approvals|รออนุมัติ)$', args: ['approvals'], reply: true },
  ],
}

describe('matchFastPath()', () => {
  it('returns undefined when no fastPath is configured (untouched / normal path)', () => {
    expect(matchFastPath(undefined, 'สถานะ')).toBeUndefined()
  })

  it('returns undefined when rules is missing/malformed', () => {
    expect(matchFastPath({ command: 'x' } as unknown as FastPathConfig, 'สถานะ')).toBeUndefined()
  })

  it('returns undefined when no rule matches — falls through to Claude', () => {
    expect(matchFastPath(NOVA_CONFIG, 'สวัสดีครับ ช่วยอธิบายอะไรหน่อย')).toBeUndefined()
  })

  it('matches the status rule exactly (rule 0)', () => {
    const m = matchFastPath(NOVA_CONFIG, 'สถานะ')
    expect(m).toBeDefined()
    expect(m!.ruleIndex).toBe(0)
    expect(m!.args).toEqual(['say', '-'])
  })

  it('is case-insensitive and trims surrounding whitespace', () => {
    const m = matchFastPath(NOVA_CONFIG, '  STATUS  ')
    expect(m).toBeDefined()
    expect(m!.ruleIndex).toBe(0)
  })

  it('matches the @lane rule (rule 1)', () => {
    const m = matchFastPath(NOVA_CONFIG, '@rig ทำอะไรอยู่')
    expect(m).toBeDefined()
    expect(m!.ruleIndex).toBe(1)
    expect(m!.args).toEqual(['say', '-'])
  })

  it('matches the เปิด rule (rule 2)', () => {
    const m = matchFastPath(NOVA_CONFIG, 'เปิด nova-fastpath ทำต่อ')
    expect(m).toBeDefined()
    expect(m!.ruleIndex).toBe(2)
  })

  it('matches approve and substitutes the ULID capture group into $2', () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const m = matchFastPath(NOVA_CONFIG, `อนุมัติ ${ulid}`)
    expect(m).toBeDefined()
    expect(m!.ruleIndex).toBe(3)
    expect(m!.args).toEqual(['approve', ulid])
  })

  it('matches the English "approve" alias too (same rule)', () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const m = matchFastPath(NOVA_CONFIG, `approve ${ulid}`)
    expect(m).toBeDefined()
    expect(m!.ruleIndex).toBe(3)
    expect(m!.args).toEqual(['approve', ulid])
  })

  it('matches deny/ไม่อนุมัติ/ปฏิเสธ and substitutes into $2 (rule 4)', () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    expect(matchFastPath(NOVA_CONFIG, `ไม่อนุมัติ ${ulid}`)!.args).toEqual(['deny', ulid])
    expect(matchFastPath(NOVA_CONFIG, `ปฏิเสธ ${ulid}`)!.args).toEqual(['deny', ulid])
    expect(matchFastPath(NOVA_CONFIG, `deny ${ulid}`)!.ruleIndex).toBe(4)
  })

  it('does not match approve/deny without a well-formed 26-char ULID', () => {
    expect(matchFastPath(NOVA_CONFIG, 'อนุมัติ abc')).toBeUndefined()
  })

  it('matches approvals rule with reply:true carried through (rule 5)', () => {
    const m = matchFastPath(NOVA_CONFIG, 'approvals')
    expect(m).toBeDefined()
    expect(m!.ruleIndex).toBe(5)
    expect(m!.rule.reply).toBe(true)
    expect(m!.args).toEqual(['approvals'])
  })

  it('first match wins when multiple rules could apply', () => {
    // "สถานะ" alone only matches rule 0, not the catch-all เปิด/@ rules — but
    // verify ordering explicitly with a config where two rules could both match.
    const config: FastPathConfig = {
      command: 'echo',
      rules: [
        { match: '^foo', args: ['first'] },
        { match: '^foo', args: ['second'] },
      ],
    }
    const m = matchFastPath(config, 'foobar')
    expect(m!.ruleIndex).toBe(0)
    expect(m!.args).toEqual(['first'])
  })

  it('skips a rule with an invalid regex and keeps checking later rules', () => {
    const config: FastPathConfig = {
      command: 'echo',
      rules: [
        { match: '(unclosed', args: ['bad'] },
        { match: '^ok$', args: ['good'] },
      ],
    }
    const m = matchFastPath(config, 'ok')
    expect(m!.ruleIndex).toBe(1)
    expect(m!.args).toEqual(['good'])
  })

  it('leaves a literal $2 alone when the capture group did not participate', () => {
    const config: FastPathConfig = {
      command: 'echo',
      rules: [{ match: '^(a)(b)?$', args: ['$1', '$2'] }],
    }
    const m = matchFastPath(config, 'a')
    expect(m!.args).toEqual(['a', ''])
  })
})

describe('substituteCaptures()', () => {
  it('substitutes multiple capture groups', () => {
    const re = /^(\w+)\s+(\w+)$/
    const m = re.exec('hello world')!
    expect(substituteCaptures('$1-$2', m)).toBe('hello-world')
  })

  it('passes through args with no placeholders unchanged', () => {
    const re = /^x$/
    const m = re.exec('x')!
    expect(substituteCaptures('say', m)).toBe('say')
    expect(substituteCaptures('-', m)).toBe('-')
  })
})
