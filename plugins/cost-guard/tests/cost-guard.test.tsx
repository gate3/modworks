import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  plugin: 'cost-guard',
  component: 'Pane',
  requestId: 'cost-guard',
  props: {
    title: 'Cost guard',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// The engine beneath the plugin: every call the mod makes is answered here.
// `veto` makes the compaction come back skipped, as a blocking hook would.
function world(on: On, opts: { veto?: string } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  const seen = { commands: [] as string[], prompts: [] as string[], writes: [] as string[], compactions: [] as (string | undefined)[] }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('fs.write', (_, e) => {
    seen.writes.push(e.path)
    return { value: undefined }
  })
  on('session.compact', (_, e) => {
    seen.compactions.push(e.instructions)
    if (opts.veto) return { skip: opts.veto }
    return { messages: [{ role: 'user', text: 'Summary', toolUses: [] }], tokensBefore: 250_000, tokensAfter: 18_000 }
  })
  on('command.run', (_, e) => {
    seen.commands.push(e.command)
    return { text: '' }
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  return { clock, seen }
}

async function measure($: Engine, tokens: number) {
  await $.session.measure({
    context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 12 },
      { kind: 'seven_day', percentUsed: 34 },
    ],
    cost: { usd: 3.42 },
    changed: ['context', 'cost'],
  })
}

test('the pane shows usage and context on every surface', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($, 142_000)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Filling up\. Compacts at 200K\./ })).toBeDefined()
    expect(await ui.find({ key: 'handoff-now' })).toBeDefined()
    await ui.unmount()
  }
})

test('every control says what it does without hovering', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($, 142_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  for (const id of ['handoff-now', 'autoHandoff', 'idleHandoff', 'trimOutput', 'cheapSubagents', 'threshold']) {
    expect(await ui.find({ key: `help-${id}` })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /Compacts at 200K so long sessions use less of your limit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Earlier messages stay on screen/ })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('"display":"none"')
  await ui.unmount()
})

test('the handoff point can be changed from the pane', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($, 142_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'threshold-100000' })
  expect(await ui.find({ type: 'Text', text: /Compacts at 100K/ })).toBeDefined()
  // A click never compacts on the spot; the next reply does.
  await clock.advance(2_000)
  expect(seen.compactions).toHaveLength(0)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', isAborted: false, durationMs: 1_000 })
  await clock.advance(2_000)
  expect(seen.compactions).toHaveLength(1)
  await ui.unmount()
})

test('on a subscription the pane shows the weekly limit, not dollars', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($, 142_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /34%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$/ })).toBeUndefined()
  await ui.unmount()
})

test('no dollar figure anywhere, even before the first usage reading', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 90_000, window: 1_000_000, percent: 9 },
    rateLimits: [],
    cost: { usd: 3.42 },
    changed: ['context', 'cost'],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('$3.42')
  await ui.unmount()
})

test('auto compact keeps the history: it compacts, never clears or re-prompts', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($, 250_000)

  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', isAborted: false, durationMs: 1_000 })
  await clock.advance(2_000)

  expect(seen.compactions).toHaveLength(1)
  expect(seen.compactions[0]).toContain('STATUS')
  expect(seen.commands).toEqual([])
  expect(seen.prompts).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Compacted\. Freed 232K tokens\./ })).toBeDefined()
  await ui.unmount()
})

test('no handoff below the threshold, or when turned off', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($, 120_000)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', isAborted: false, durationMs: 1_000 })
  await clock.advance(2_000)
  expect(seen.compactions).toHaveLength(0)

  const reply = await $.command.run({
    command: 'cost-guard',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(reply.text).toBe('Auto compact is off.')
  await measure($, 400_000)
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', isAborted: false, durationMs: 1_000 })
  await clock.advance(2_000)
  expect(seen.compactions).toHaveLength(0)
})

test('an interrupted turn never hands off', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($, 300_000)
  await $.turn.complete({ turnId: 't1', reason: 'aborted', answer: 'ok', isAborted: true, durationMs: 1_000 })
  await clock.advance(2_000)
  expect(seen.compactions).toHaveLength(0)
})

test('long Bash output is trimmed and saved', async ($, on) => {
  const { seen } = world(on)
  const long = `${'a'.repeat(20_000)}MIDDLE${'z'.repeat(20_000)}`
  on('tool.call', () => ({ result: { stdout: long, stderr: '', interrupted: false } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const stdout = (ran.result as { stdout: string }).stdout
  expect(stdout.length).toBeLessThan(13_000)
  expect(stdout).toContain('cost-guard cut')
  expect(stdout).not.toContain('MIDDLE')
  expect(seen.writes[0]).toMatch(/\/cost-guard\/output\//)
})

test('the chosen handoff point is marked and survives a clear', async ($, on) => {
  world(on)
  // The host's copy of the settings, which a /clear starts over.
  let prefs: { value: unknown; version: number } = { value: undefined, version: 0 }
  on('state.get', (_, e, next) => (e.key === 'prefs' ? { value: prefs } : next(e)))
  on('state.set', (_, e, next) => {
    if (e.key !== 'prefs') return next(e)
    if (e.ifVersion !== undefined && e.ifVersion !== prefs.version) return { value: { isSet: false, version: prefs.version } }
    prefs = { value: e.value, version: prefs.version + 1 }
    return { value: { isSet: true, version: prefs.version } }
  })
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($, 142_000)

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'threshold-300000' })
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(JSON.stringify(await ui.drawn())).toContain('✓ 300K')
  expect(JSON.stringify(await ui.drawn())).not.toContain('✓ 200K')
  await ui.unmount()

  prefs = { value: undefined, version: 0 }
  await $.classic.SessionStart({ source: 'clear' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Compacts at 300K/ })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('✓ 300K')
  await ui.unmount()
})

test('a vetoed compaction is noted and tried again later', async ($, on) => {
  const { clock, seen } = world(on, { veto: 'a PreCompact hook blocked it' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($, 250_000)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', isAborted: false, durationMs: 1_000 })
  await clock.advance(2_000)
  expect(seen.compactions).toHaveLength(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Compact skipped: a PreCompact hook blocked it/ })).toBeDefined()
  await ui.unmount()
})
