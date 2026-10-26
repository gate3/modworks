import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  plugin: 'ship-gate',
  component: 'Pane',
  requestId: 'ship-gate',
  props: {
    title: 'Ship gate',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TOUR = 'export const Tour = () => (\n  <View>\n    <Text>Hello</Text>\n  </View>\n)'

// A git repository at /repo, answered from memory: `base` is what the remote
// has, `work` the working tree, and every git command the mod runs reads them.
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  const repo = {
    base: { 'src/Tour.tsx': TOUR, 'src/api.ts': 'export const limit = 1\n' } as Record<string, string>,
    work: { 'src/Tour.tsx': TOUR, 'src/api.ts': 'export const limit = 1\n' } as Record<string, string>,
    untracked: new Set<string>(),
    hasRemote: true,
    hasStaging: true,
    branch: 'feature/tour',
    // git's batch hashing stops at a path it can't hash, like a submodule.
    batchFails: false,
  }
  const files: Record<string, string> = {}
  const seen = { bash: [] as string[], skillArgs: [] as (string | undefined)[], spawnModels: [] as (string | undefined)[] }
  const failing = new Set<string>()

  const blobs = new Map<string, string>()
  const hash = (text: string) => {
    let h = 5381
    for (const c of text) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0
    const key = h.toString(16).padStart(8, '0')
    blobs.set(key, text)
    return key
  }
  const lineDiff = (a: string, b: string) => {
    const al = a.split('\n')
    const bl = b.split('\n')
    const minus = al.filter(l => !bl.includes(l)).map(l => `-${l}`)
    const plus = bl.filter(l => !al.includes(l)).map(l => `+${l}`)
    return ['@@ -1 +1 @@', ...minus, ...plus].join('\n')
  }
  const changed = () =>
    [...new Set([...Object.keys(repo.base), ...Object.keys(repo.work)])].filter(
      p => !repo.untracked.has(p) && repo.base[p] !== repo.work[p],
    )
  const result = (exitCode: number, stdout = '') => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('process.run', (_, e) => {
    const a = e.argv.slice(1).join(' ')
    const cwd = e.init?.cwd ?? '/repo'
    if (a === 'rev-parse --show-toplevel') return cwd.startsWith('/repo') ? result(0, '/repo\n') : cwd.startsWith('/other') ? result(0, '/other\n') : result(128)
    if (a.startsWith('merge-base HEAD')) return repo.hasRemote ? result(0, 'base0\n') : result(1)
    if (a === 'rev-parse --verify --quiet HEAD' || a === 'rev-parse HEAD') return result(0, 'head0\n')
    if (a === 'rev-parse --abbrev-ref HEAD') return result(0, `${repo.branch}\n`)
    if (a === 'rev-parse --verify --quiet refs/remotes/origin/staging') return result(repo.hasStaging ? 0 : 1, 'x')
    if (a === 'rev-parse --verify --quiet refs/remotes/origin/HEAD') return result(repo.hasRemote ? 0 : 1, 'x')
    if (a.startsWith('diff --no-renames --name-status -z')) {
      return result(0, changed().map(p => `${p in repo.work ? (p in repo.base ? 'M' : 'A') : 'D'}\0${p}\0`).join(''))
    }
    if (a === 'ls-files -o --exclude-standard -z') return result(0, [...repo.untracked].map(p => `${p}\0`).join(''))
    if (a.startsWith('hash-object -w -- ')) return result(0, `${hash(repo.work[e.argv[e.argv.length - 1]!] ?? '')}\n`)
    if (a === 'hash-object -w --stdin-paths') {
      if (repo.batchFails) return result(128)
      const paths = (e.init?.stdin ?? '').split('\n').filter(Boolean)
      return result(0, `${paths.map(p => hash(repo.work[p] ?? '')).join('\n')}\n`)
    }
    if (a.startsWith('diff -U0 --no-color --no-ext-diff --no-renames')) {
      return result(0, changed().map(p => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${lineDiff(repo.base[p] ?? '', repo.work[p] ?? '')}`).join('\n'))
    }
    if (a.startsWith('diff -U0 --no-color --no-ext-diff ')) {
      const [x, y] = e.argv.slice(-2)
      return result(0, lineDiff(blobs.get(x!) ?? '', blobs.get(y!) ?? ''))
    }
    return result(1)
  })

  const fileAt = (path: string) => (path.startsWith('/repo/') && path.slice(6) in repo.work ? repo.work[path.slice(6)] : files[path])
  on('fs.exists', (_, e) => ({ value: fileAt(e.path) !== undefined }))
  on('fs.read', (_, e) => {
    const text = fileAt(e.path)
    if (text === undefined) throw new Error(`no file ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })

  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('agent.spawn', (_, e) => {
    seen.spawnModels.push(e.model)
    return { model: e.model ?? 'claude-opus-5-5', agentId: `a${seen.spawnModels.length}` }
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') {
      seen.bash.push(e.command)
      if ([...failing].some(f => e.command.includes(f))) return { isError: true, result: 'Exit code 1', text: 'Exit code 1' }
      return { result: { stdout: e.command.startsWith('gh pr create') ? 'https://github.com/o/r/pull/7\n' : '', stderr: '', interrupted: false } }
    }
    if (e.tool === 'Skill') seen.skillArgs.push(e.args)
    return { result: {} }
  })

  return { clock, repo, files, seen, failing }
}

const settle = (clock: { advance: (ms: number) => Promise<void> }) => clock.advance(50)

async function start($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await settle(clock)
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'ship-gate', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
const endTurn = ($: Engine, id: string) =>
  $.turn.complete({ turnId: id, reason: 'answer', answer: 'ok', isAborted: false, durationMs: 1_000 })

const spawn = ($: Engine) =>
  $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'review',
    description: 'Review',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })

const WELCOME = TOUR.replace('<Text>Hello</Text>', '<Text>Welcome to your bakery</Text>')

async function doAllSteps($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await $.skill.prompt({ skill: 'code-review', text: 'Review the diff at medium effort.' })
  await $.skill.prompt({ skill: 'design:ux-copy', text: 'Review the copy.' })
  await endTurn($, 't-steps')
  await settle(clock)
  await $.tool.call({ tool: 'SendUserFile', files: ['/tmp/tour.png'], status: 'normal' })
  await settle(clock)
}

test('the pane shows the harbor and the manifest on every surface', async ($, on) => {
  const { clock, repo } = world(on)
  repo.work['src/Tour.tsx'] = WELCOME
  await start($, clock)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /3 steps before shipping: Code review, UX copy check and Proof\./ })).toBeDefined()
    expect(await ui.find({ key: 'step-review' })).toBeDefined()
    expect(await ui.find({ key: 'help-pass' })).toBeDefined()
    await ui.unmount()
  }
})

test('a commit waits for review, copy check and proof, then goes through', async ($, on) => {
  const { clock, repo, seen } = world(on)
  repo.work['src/Tour.tsx'] = WELCOME
  await start($, clock)

  const held = await bash($, 'git add -A && git commit -m "Tour copy"')
  expect(held.deny).toContain('Ship gate held this commit in repo.')
  expect(held.deny).toContain('- Code review')
  expect(held.deny).toContain('- UX copy check (copy changed in Tour.tsx)')
  expect(held.deny).toContain('- Proof')
  expect(held.deny).not.toContain('Marketing')
  expect(seen.bash).toEqual([])

  await doAllSteps($, clock)
  const ok = await bash($, 'git add -A && git commit -m "Tour copy"')
  expect(ok.deny).toBeUndefined()
  expect(seen.bash).toHaveLength(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Clear to ship/ })).toBeDefined()
  await ui.unmount()
})

test('a copy-only edit keeps the review; a code edit takes it down', async ($, on) => {
  const { clock, repo } = world(on)
  repo.work['src/Tour.tsx'] = WELCOME
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)
  await doAllSteps($, clock)

  repo.work['src/Tour.tsx'] = WELCOME.replace('Welcome to your bakery', 'Welcome to your bakery!')
  const copyEdit = await bash($, 'git commit -am "Copy"')
  expect(copyEdit.deny).toContain('- UX copy check (code changed since then: Tour.tsx)')
  expect(copyEdit.deny).not.toContain('- Code review')
  expect(copyEdit.deny).toContain('Done for this code: Code review.')

  repo.work['src/api.ts'] = 'export const limit = 3\n'
  const codeEdit = await bash($, 'git commit -am "Limit"')
  expect(codeEdit.deny).toContain('- Code review (code changed since then: api.ts)')
})

test('fixes made in the same turn as a review count as reviewed', async ($, on) => {
  const { clock, repo } = world(on)
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)
  await $.skill.prompt({ skill: 'code-review', text: 'Review the diff at high effort.' })
  await settle(clock)

  repo.work['src/api.ts'] = 'export const limit = 3\n'
  const fixed = await bash($, 'git commit -am "Limit"')
  expect(fixed.deny ?? '').not.toContain('- Code review')

  repo.work['src/api.ts'] = 'export const limit = 4\n'
  const later = await bash($, 'git commit -am "Limit again"')
  expect(later.deny).toContain('- Code review (code changed since then: api.ts)')
})

test('JSX text between expressions is copy', async ($, on) => {
  const { clock, repo } = world(on)
  repo.work['src/Tour.tsx'] = TOUR.replace('<Text>Hello</Text>', '<Text>{code} applied: you save {off}%.</Text>')
  await start($, clock)
  const held = await bash($, 'git commit -am "Tour"')
  expect(held.deny).toContain('- UX copy check (copy changed in Tour.tsx)')
})

test('a change inside a code string takes the review down', async ($, on) => {
  const { clock, repo } = world(on)
  repo.work['src/api.ts'] = "export const canRefund = (role: string) => role === 'admin'\n"
  await start($, clock)
  await doAllSteps($, clock)
  expect((await bash($, 'git commit -am "Refunds"')).deny ?? '').not.toContain('- Code review')

  repo.work['src/api.ts'] = "export const canRefund = (role: string) => role === 'guest'\n"
  expect((await bash($, 'git commit -am "Refunds"')).deny).toContain('- Code review (code changed since then: api.ts)')
})

test('a review covers fixes, not a feature written after it', async ($, on) => {
  const { clock, repo } = world(on)
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)
  await $.skill.prompt({ skill: 'code-review', text: 'Review the diff at medium effort.' })
  await settle(clock)

  repo.untracked.add('src/orders.ts')
  repo.work['src/orders.ts'] = Array.from({ length: 300 }, (_, i) => `export const o${i} = ${i}`).join('\n')
  const held = await bash($, 'git add -A && git commit -m "Orders"')
  expect(held.deny).toContain('- Code review (code changed since then: orders.ts)')
})

test('a file git hashes alone still takes the review down when it changes', async ($, on) => {
  const { clock, repo } = world(on)
  repo.batchFails = true
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)
  await $.skill.prompt({ skill: 'code-review', text: 'Review.' })
  await endTurn($, 't1')
  await settle(clock)
  expect((await bash($, 'git commit -am "x"')).deny ?? '').not.toContain('- Code review')

  repo.work['src/api.ts'] = 'export const limit = 9\n'
  expect((await bash($, 'git commit -am "x"')).deny).toContain('- Code review (code changed since then: api.ts)')
})

test('a gate that fails holds a commit and lets other commands run', async ($, on) => {
  const { clock, repo, files, seen } = world(on)
  files['/repo/.claude/ship-gate.json'] = JSON.stringify({ prBase: { branch: 'staging', except: '(' } })
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)

  expect((await bash($, 'gh pr create --title "x"')).deny).toContain("Ship gate couldn't check this command")
  expect((await bash($, 'ls')).deny).toBeUndefined()
  expect(seen.bash).toEqual(['ls'])
})

test('test files are not UX copy', async ($, on) => {
  const { clock, repo } = world(on)
  repo.untracked.add('src/Tour.test.tsx')
  repo.work['src/Tour.test.tsx'] = "test('Shows the welcome line', () => expect(text).toBe('Welcome to your bakery.'))"
  await start($, clock)
  const held = await bash($, 'git add -A && git commit -m "Test"')
  expect(held.deny).not.toContain('UX copy check')
  expect(held.deny).toContain("Don't ask the user first")
})

test('yarn is blocked where the lockfile is package-lock.json', async ($, on) => {
  const { clock, files, seen } = world(on)
  files['/repo/package-lock.json'] = '{}'
  await start($, clock)

  const denied = await bash($, 'cd /repo && yarn install')
  expect(denied.deny).toContain('repo uses npm')
  expect((await bash($, 'npm ci && npm test')).deny).toBeUndefined()

  files['/repo/yarn.lock'] = ''
  expect((await bash($, 'yarn install')).deny).toBeUndefined()
  expect(seen.bash).toEqual(['npm ci && npm test', 'yarn install'])
})

test('pull requests go to staging unless the branch is a hotfix', async ($, on) => {
  const { clock, repo, seen } = world(on)
  await start($, clock)

  await bash($, 'gh pr create --title "Tour" --body "x"')
  expect(seen.bash[0]).toBe('gh pr create --base staging --title "Tour" --body "x"')

  const wrong = await bash($, 'gh pr create --base main --title "Tour"')
  expect(wrong.deny).toContain('go to staging, not main')

  repo.branch = 'hotfix/login'
  await bash($, 'gh pr create --base main --title "Fix"')
  expect(seen.bash[1]).toBe('gh pr create --base main --title "Fix"')
})

test("Claude's code review gets its level and reviewer model from the risk", async ($, on) => {
  const { clock, repo, seen } = world(on)
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)

  await $.tool.call({ tool: 'Skill', skill: 'code-review' })
  await spawn($)
  expect(seen.skillArgs[0]).toBe('medium')
  expect(seen.spawnModels[0]).toBe('claude-sonnet-5-5')
  await endTurn($, 't1')

  repo.untracked.add('src/auth/session.ts')
  repo.work['src/auth/session.ts'] = Array.from({ length: 500 }, (_, i) => `export const t${i} = ${i}`).join('\n')
  await $.tool.call({ tool: 'Skill', skill: 'code-review' })
  await spawn($)
  expect(seen.skillArgs[1]).toBe('high')
  expect(seen.spawnModels[1]).toBe('claude-opus-5-5')
  await endTurn($, 't2')

  // A level someone chose stays, and so does the reviewer's model.
  await $.tool.call({ tool: 'Skill', skill: 'code-review', args: 'max' })
  await spawn($)
  expect(seen.skillArgs[2]).toBe('max')
  expect(seen.spawnModels[2]).toBeUndefined()
  await endTurn($, 't3')

  // Other agents in the same turn keep their own model.
  await $.tool.call({ tool: 'Skill', skill: 'code-review' })
  await $.agent.spawn({
    tool_use_id: 'tu2',
    prompt: 'Find where orders are saved.',
    description: 'Explore orders',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  expect(seen.spawnModels[3]).toBeUndefined()
})

test('a review of another repository counts there, not in the one last edited', async ($, on) => {
  const { clock, repo } = world(on)
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)
  await $.tool.call({ tool: 'Edit', file_path: '/other/notes.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Skill', skill: 'code-review', args: 'medium /repo' })
  await $.skill.prompt({ skill: 'code-review', text: 'Review.' })
  await endTurn($, 't1')
  await settle(clock)
  expect((await bash($, 'cd /repo && git commit -am "x"')).deny ?? '').not.toContain('- Code review')
})

test('the review the gate asks for names the level the risk calls for', async ($, on) => {
  const { clock, repo } = world(on)
  repo.untracked.add('migrations/0042_orders.sql')
  repo.work['migrations/0042_orders.sql'] = 'ALTER TABLE orders ADD COLUMN note TEXT;'
  await start($, clock)
  const held = await bash($, 'git commit -m "Orders"')
  expect(held.deny).toContain('run the code-review skill with "high"')
  expect(held.deny).toContain('touches migrat')
})

test('/ship-gate pass lets one commit through', async ($, on) => {
  const { clock, repo, seen } = world(on)
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)

  await run($, 'pass')
  expect((await bash($, 'git commit -am "x"')).deny).toBeUndefined()
  expect((await bash($, 'git commit -am "y"')).deny).toContain('Ship gate held')
  expect(seen.bash).toEqual(['git commit -am "x"'])
})

test('a pass is used up by the next commit even when nothing was missing', async ($, on) => {
  const { clock, repo } = world(on)
  await start($, clock)
  await run($, 'pass')
  expect((await bash($, 'git commit --allow-empty -m "x"')).deny).toBeUndefined()

  repo.work['src/api.ts'] = 'export const limit = 2\n'
  expect((await bash($, 'git commit -am "y"')).deny).toContain('Ship gate held')
})

test('a step added for a command waits until the command passes', async ($, on) => {
  const { clock, repo, files, failing } = world(on)
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)

  const added = await run($, 'add command npm test')
  expect(added.text).toContain('Added “npm test passes”')
  expect(JSON.parse(files['/repo/.claude/ship-gate.json']!).steps[0].done).toEqual({ command: 'npm test' })

  await $.skill.prompt({ skill: 'code-review', text: 'Review.' })
  await endTurn($, 't1')
  await settle(clock)
  expect((await bash($, 'git commit -am "x"')).deny).toContain('- npm test passes')

  failing.add('npm test')
  await bash($, 'npm test')
  expect((await bash($, 'git commit -am "x"')).deny).toContain('- npm test passes')

  // Piped, the exit code is tail's, so it doesn't count.
  failing.clear()
  await bash($, 'npm test 2>&1 | tail -20')
  expect((await bash($, 'git commit -am "x"')).deny).toContain('- npm test passes')

  await bash($, 'npm test')
  expect((await bash($, 'git commit -am "x"')).deny).toBeUndefined()
})

test('an approval step is approved from the pane', async ($, on) => {
  const { clock, repo, files } = world(on)
  files['/repo/.claude/ship-gate.json'] = JSON.stringify({
    steps: [{ id: 'review', off: true }, { id: 'signoff', name: 'Design sign-off', flag: 'D', done: { approval: true } }],
  })
  repo.work['src/api.ts'] = 'export const limit = 2\n'
  await start($, clock)

  expect((await bash($, 'git commit -am "x"')).deny).toContain('ask the user to approve it')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'approve-signoff' })
  await settle(clock)
  await ui.unmount()
  expect((await bash($, 'git commit -am "x"')).deny).toBeUndefined()
})

test('when the gate is off, nothing is held', async ($, on) => {
  const { clock, repo } = world(on)
  repo.work['src/Tour.tsx'] = WELCOME
  await start($, clock)
  expect((await run($, 'off')).text).toBe('Ship gate is off. Nothing is checked or blocked.')
  expect((await bash($, 'git commit -am "x"')).deny).toBeUndefined()
})

test('a held commit shows on the pane, and a push sails', async ($, on) => {
  const { clock, repo } = world(on)
  repo.work['src/Tour.tsx'] = WELCOME
  await start($, clock)
  await bash($, 'git commit -am "x"')
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Held at the gate: Code review, UX copy check and Proof still needed\./ })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('HELD')
  await ui.unmount()

  await doAllSteps($, clock)
  await bash($, 'git push')
  await settle(clock)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Shipped: feature\/tour pushed\./ })).toBeDefined()
  await ui.unmount()
})
