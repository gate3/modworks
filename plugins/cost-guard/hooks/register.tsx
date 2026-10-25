import { atom, read, update } from 'claude-code'
import type { Atom, EngineInterface, Register } from 'claude-code'

import type { Meter, Moment, Phase, GuardSettings } from '../types'

type E = EngineInterface

const PANE = 'cost-guard'
const TITLE = 'Cost guard'

const DEFAULTS: GuardSettings = {
  autoHandoff: true,
  handoffAt: 200_000,
  idleHandoff: true,
  idleHandoffAt: 80_000,
  trimOutput: true,
  trimAt: 12_000,
  cheapSubagents: false,
}

const settingsAtom: Atom<GuardSettings> = atom({ plugin: 'cost-guard', key: 'prefs' } as const, DEFAULTS)
const meterAtom: Atom<Meter> = atom({ plugin: 'cost-guard', key: 'meter' } as const, {
  tokens: 0,
  window: 0,
  model: '',
  ttl: '5m',
  hits: [],
  missUsd: 0,
  freedTokens: 0,
  handoffs: 0,
  limits: [],
} as Meter)
const phaseAtom: Atom<Phase> = atom({ plugin: 'cost-guard', key: 'phase' } as const, { kind: 'idle' } as Phase)
const momentsAtom: Atom<Moment[]> = atom({ plugin: 'cost-guard', key: 'moments' } as const, [] as Moment[])
const tickAtom: Atom<number> = atom({ plugin: 'cost-guard', key: 'tick' } as const, 0)
const runningAtom: Atom<boolean> = atom({ plugin: 'cost-guard', key: 'running' } as const, false)

// Idle handoff fires this long before a 1-hour cache entry lapses.
// The handoff points the pane offers; /cost-guard threshold sets any other.
const THRESHOLDS = [100_000, 150_000, 200_000, 300_000, 500_000]
const IDLE_HANDOFF_AFTER_MS = 50 * 60_000
const CHEAP_MODEL = 'claude-sonnet-5-5'
const ROUTED_TYPES = new Set(['Explore'])

// Module state: resets on reload, which is fine for all of it.
let isBusy = false
let isTurnRunning = false
let expectsFreshPrefix = false
let freedFrom: number | undefined
let lastStop = { background: 0 }
let lastBoxes = 0
let boxesAddedAt: { at: number; from: number } | undefined
let lastFive = 0
// When things last moved, so the pane's animations keep their place across redraws.
let limitBump: { at: number; points: number } | undefined
let hitAt: number | undefined
let handoffMark: { at: number; freed: number } | undefined
// Counts the main agent's turns, so a handoff can tell a message came in while it wrote the note.
let turnsStarted = 0
// The resume prompt waiting to run after a clear. A message the person sends first carries it instead.
let pendingResume: { prompt: string; context: string } | undefined
const agentTypes = new Map<string, string>()
const routedAgents = new Set<string>()

// ---------- pricing ----------

function basePrice(model: string): number | undefined {
  if (/opus-5-5/.test(model)) return 4
  if (/sonnet-5-5/.test(model)) return 2
  if (/haiku-5-5/.test(model)) return 0.1
  if (/opus/.test(model)) return 5
  if (/sonnet/.test(model)) return 3
  if (/haiku/.test(model)) return 1
  return undefined
}

function readMultiplier(model: string): number {
  if (/fable|mythos/.test(model)) return 0.025
  if (/-5-5/.test(model)) return 0.05
  return 0.1
}

const writeMultiplier = (ttl: Meter['ttl']) => (ttl === '1h' ? 2 : 1.25)
const ttlMs = (ttl: Meter['ttl']) => (ttl === '1h' ? 60 : 5) * 60_000

// ---------- formatting ----------

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}


function ago(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  return `${Math.floor(min / 60)}h ago`
}

function hitRate(hits: readonly number[]): number | undefined {
  const recent = hits.slice(-8)
  if (recent.length === 0) return undefined
  return Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
}

// ---------- shared helpers ----------

async function remember($: E, kind: Moment['kind'], text: string) {
  const at = await $.clock.now()
  await update($, momentsAtom, list => [...list, { at, kind, text }].slice(-30))
}

// The store is the source of truth: a /clear starts the session's values over
// without running session.start, so they are read back after each one.
async function loadSettings($: E) {
  const saved = (await $.store.get('settings')) as Partial<GuardSettings> | undefined
  if (!saved) return
  const current = await read($, settingsAtom)
  const next = { ...DEFAULTS, ...saved }
  if (JSON.stringify(current) !== JSON.stringify(next)) await update($, settingsAtom, () => next)
}

async function saveSettings($: E, change: Partial<GuardSettings>) {
  const next = await update($, settingsAtom, s => ({ ...s, ...change }))
  await $.store.set('settings', next)
  return next
}

async function home($: E) {
  return (await $.env.get('HOME')) ?? '/tmp'
}

async function stamp($: E) {
  return new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
}

async function refreshStatus($: E) {
  const m = await read($, meterAtom)
  const s = await read($, settingsAtom)
  const rate = hitRate(m.hits)
  const week = m.limits.find(l => l.kind === 'seven_day')
  const parts = [
    week ? `weekly ${Math.round(week.percentUsed)}%` : undefined,
    m.window > 0 ? `${tokens(m.tokens)}${s.autoHandoff ? ` / ${tokens(s.handoffAt)}` : ''}` : undefined,
    rate !== undefined ? `cache ${rate}%` : undefined,
  ].filter(Boolean)
  $.ui.status(parts.length ? parts.join(' · ') : undefined)
}

// ---------- handoff ----------

const NOTE_PROMPT = `Write a handoff note so a fresh session with no memory of this conversation can carry on exactly where you are. A plugin will clear this conversation to save cost and give the note to the new session. Reply with the note only, in this shape:

STATUS: <one of IN_PROGRESS, WAITING_FOR_USER, DONE>
(IN_PROGRESS: you were mid-work and would carry on without the user. WAITING_FOR_USER: your last message asked the user something or needs their decision or approval. DONE: the task is finished.)

## Goal
## Where things stand
## Decisions, constraints and the user's stated preferences
## Files touched (absolute paths, and what changed)
## Next steps
## Open question for the user (the exact question, or "none")
## Scheduled loops or check-ins (exact prompt and schedule, or "none")
## Facts not to re-derive (commands, ids, URLs, test results)

Be specific and complete, but under 1,500 words. Leave out secrets and credentials.`

function resumePrompt(note: string, path: string, before: number) {
  return `[cost-guard handoff] The conversation reached ${tokens(before)} tokens, so cost-guard cleared it to cut cost. The previous session wrote this handoff note (also saved at ${path}):

<handoff-note>
${note}
</handoff-note>

Carry on from the note:
- STATUS IN_PROGRESS: continue with the next steps now.
- STATUS WAITING_FOR_USER: restate the open question in one or two sentences, then stop.
- STATUS DONE: say in one line where things stand, then stop.
If the note lists scheduled loops or check-ins, check CronList and recreate only the ones that are missing. Read files again before editing them.`
}

// For when the person's message reaches the fresh context before the resume prompt does.
function resumeContext(note: string, path: string, before: number) {
  return `[cost-guard handoff] The conversation reached ${tokens(before)} tokens, so cost-guard cleared it to cut cost. The previous session wrote this handoff note (also saved at ${path}):

<handoff-note>
${note}
</handoff-note>

The user's message above came in right after the handoff. Answer it, using the note for context. If the note's status is IN_PROGRESS and the message doesn't change the plan, carry on with the note's next steps afterward. If the note lists scheduled loops or check-ins, check CronList and recreate only the ones that are missing. Read files again before editing them.`
}

async function handOff($: E, why: 'threshold' | 'idle' | 'manual') {
  if (isBusy) return
  isBusy = true
  const turnsAtStart = turnsStarted
  try {
    const before = (await read($, meterAtom)).tokens
    await update($, phaseAtom, (): Phase => ({ kind: 'writing', since: Date.now() }))

    const fork = await $.model.fork({ prompt: NOTE_PROMPT })
    if (!fork.isAnswered) {
      await remember($, 'skip', `Handoff skipped: couldn't write the note (${fork.reason}). Tries again after the next turn.`)
      return
    }
    const note = fork.text.trim()

    const dir = `${await home($)}/.claude/cost-guard/handoffs`
    const path = `${dir}/${await stamp($)}.md`
    await $.fs.write(path, note)

    // Clearing now would drop the message the person just sent from its own context.
    if (isTurnRunning || turnsStarted !== turnsAtStart) {
      await remember($, 'skip', 'Handoff skipped: you sent a message while the note was being written. Tries again after the next turn.')
      return
    }

    await update($, phaseAtom, (): Phase => ({ kind: 'clearing', since: Date.now() }))
    await $.command.run({ command: 'clear' })
    await loadSettings($)
    expectsFreshPrefix = true
    freedFrom = before
    // The context is empty now; the next measure fills in the real size.
    await update($, meterAtom, m => ({ ...m, tokens: 0 }))
    pendingResume = { prompt: resumePrompt(note, path, before), context: resumeContext(note, path, before) }
    // Runs once the session is idle; the prompt.submit hook hands it to an earlier message instead.
    void $.prompt.submit({ text: pendingResume.prompt })

    await update($, meterAtom, m => ({ ...m, handoffs: m.handoffs + 1 }))
    handoffMark = { at: await $.clock.now(), freed: before }
    const label = why === 'idle' ? 'before the cache expired' : why === 'manual' ? 'on request' : `at ${tokens(before)}`
    await remember($, 'handoff', `Handed off ${label}. Started a fresh context.`)
    $.ui.toast(`Handed off ${label}. Continuing in a fresh context.`)
  } catch (err) {
    await remember($, 'skip', `Handoff failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, phaseAtom, (): Phase => ({ kind: 'idle' }))
    isBusy = false
  }
}

async function maybeHandOff($: E) {
  const s = await read($, settingsAtom)
  const m = await read($, meterAtom)
  if (!s.autoHandoff || isBusy || isTurnRunning) return
  if (m.tokens < s.handoffAt) return
  if (lastStop.background > 0) {
    await remember($, 'skip', 'Handoff waiting for background work to finish.')
    return
  }
  await handOff($, 'threshold')
}

async function idleCheck($: E) {
  await update($, tickAtom, t => t + 1)
  const s = await read($, settingsAtom)
  const m = await read($, meterAtom)
  if (!s.autoHandoff || !s.idleHandoff || isBusy || isTurnRunning) return
  if (m.ttl !== '1h' || m.lastRequestAt === undefined || m.tokens < s.idleHandoffAt) return
  if (lastStop.background > 0) return
  const idle = (await $.clock.now()) - m.lastRequestAt
  if (idle < IDLE_HANDOFF_AFTER_MS || idle > ttlMs(m.ttl)) return
  await handOff($, 'idle')
}

// ---------- drawing ----------

const PALETTE = `
  :root { --fg:#1f1e1c; --muted:#7a776f; --track:#e9e5dc; --halo:rgba(250,249,245,.88); --wood:#b98a5a; --wood2:#8f6440; --note:#f6e7b0; --good:#2f9e6e; --warn:#d08a1f; --hot:#d0503c; --accent:#c96442; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#f2efe8; --muted:#a29e94; --track:#34322d; --halo:rgba(38,38,36,.88); --wood:#a67c52; --wood2:#7a5636; --note:#d9c47e; --good:#4cc08b; --warn:#e6a23c; --hot:#ef6b55; --accent:#e07a55; }
  }
  text { font-family: ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif; fill: var(--fg); }
  .muted { fill: var(--muted); }
  .num { font-variant-numeric: tabular-nums; }
  .halo { paint-order: stroke; stroke: var(--halo); stroke-width: 4px; stroke-linejoin: round; }
  .bar { transition: opacity .15s; }
  .bar:hover { opacity: .55; }
`

// What a drawing needs that isn't in $.state: when things last changed, so
// animations pick up where they were when the pane redraws.
type Motion = {
  now: number
  isRunning: boolean
  limitBump?: { at: number; points: number }
  hitAt?: number
  handoff?: { at: number; freed: number }
}

function tone(fraction: number) {
  return fraction < 0.6 ? 'var(--good)' : fraction < 0.85 ? 'var(--warn)' : 'var(--hot)'
}

function hitTone(hit: number) {
  return hit >= 80 ? 'var(--good)' : hit >= 40 ? 'var(--warn)' : 'var(--hot)'
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')

// A negative begin starts a looping animation part-way through, so a redraw
// doesn't restart it from zero.
const loopBegin = (now: number, dur: number) => `-${((now / 1000) % dur).toFixed(2)}s`
const sinceBegin = (now: number, at: number) => `-${Math.max(0, (now - at) / 1000).toFixed(2)}s`

// Seeded so a box keeps its place from one redraw to the next.
function jitter(seed: number) {
  const x = Math.sin(seed * 999.7) * 10_000
  return x - Math.floor(x)
}

const EASE = 'calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"'
const FALL = 'calcMode="spline" keyTimes="0;1" keySplines=".5 0 .9 .6"'

// The context as a load on a small creature's back: each box is a slice of
// the conversation, the tower wobbles and the critter tires as it grows, and
// a handoff drops the load for a single envelope.
function critter(m: Meter, limit: number, phase: Phase, motion: Motion) {
  const { now } = motion
  const raw = limit > 0 ? m.tokens / limit : 0
  const f = Math.min(1, raw)
  const n = m.tokens > 0 ? Math.max(1, Math.round(f * 9)) : 0
  const isClearing = phase.kind === 'clearing'
  const hop = motion.handoff !== undefined && now - motion.handoff.at < 3_200 ? motion.handoff : undefined
  const isWorking = phase.kind === 'writing' || motion.isRunning

  if (n > lastBoxes) boxesAddedAt = { at: now, from: lastBoxes }
  else if (n < lastBoxes) boxesAddedAt = undefined
  lastBoxes = n

  const cx = 70
  const baseY = 134
  const pace = hop ? 0.28 : (0.35 + f * 1.1) / (isWorking ? 1.25 : 1)
  const isTired = raw >= 0.85 && !hop
  const squash = hop ? 1 : 1 - f * 0.18

  const ground = `<rect x="0" y="150" width="142" height="12" rx="3" style="fill:var(--track)"/>
    <g clip-path="url(#scene)"><g>
      <animateTransform attributeName="transform" type="translate" from="0 0" to="-40 0" dur="${(pace * 2).toFixed(2)}s" begin="${loopBegin(now, pace * 2)}" repeatCount="indefinite"/>
      ${Array.from({ length: 6 }, (_, i) => `<rect x="${i * 40 + 6}" y="155" width="14" height="2" rx="1" style="fill:var(--muted)" opacity=".45"/>`).join('')}
    </g></g>`

  const legs = [-20, -8, 4, 16]
    .map((x, i) => {
      const begin = loopBegin(now + (i % 2 ? (pace / 2) * 1000 : 0), pace)
      return `<rect x="${x}" y="0" width="6" height="12" rx="2" style="fill:var(--accent)"><animate attributeName="height" values="12;7;12" dur="${pace.toFixed(2)}s" begin="${begin}" repeatCount="indefinite"/></rect>`
    })
    .join('')

  const blink = `<animate attributeName="height" values="7;7;1;7" keyTimes="0;.9;.95;1" dur="3.4s" begin="${loopBegin(now, 3.4)}" repeatCount="indefinite"/>`
  const eyes = isTired
    ? `<path d="M-12 -18 h8 M6 -18 h8" style="stroke:var(--fg)" stroke-width="2.4" stroke-linecap="round"/>`
    : `<rect x="-12" y="-22" width="5" height="7" rx="1.5" style="fill:var(--fg)">${blink}</rect><rect x="8" y="-22" width="5" height="7" rx="1.5" style="fill:var(--fg)">${blink}</rect>`
  const body = `<rect x="-24" y="-30" width="48" height="34" rx="9" style="fill:var(--accent)"/>
    <rect x="-30" y="-14" width="8" height="8" rx="2" style="fill:var(--accent)"/><rect x="22" y="-14" width="8" height="8" rx="2" style="fill:var(--accent)"/>${eyes}`

  const sweat =
    raw >= 0.7 && !hop && !isClearing
      ? [0, 1]
          .map(
            i =>
              `<path d="M${18 + i * 6} -30 q2 4 0 6 q-2 -2 0 -6z" style="fill:#7fb6d6"><animateTransform attributeName="transform" type="translate" values="0 0;${4 + i * 3} 14" dur="1.1s" begin="${loopBegin(now + i * 500, 1.1)}" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" dur="1.1s" begin="${loopBegin(now + i * 500, 1.1)}" repeatCount="indefinite"/></path>`,
          )
          .join('')
      : ''

  const box = (i: number) => {
    const w = 22 - (i % 3) * 3
    const x = -w / 2 + (jitter(i) - 0.5) * (3 + i * 1.2) * (0.5 + f)
    const isTop = i === n - 1
    const fill = isTop && raw >= 0.6 ? tone(raw) : i % 2 ? 'var(--wood)' : 'var(--wood2)'
    return `<rect x="${x.toFixed(1)}" y="${-(i + 1) * 11}" width="${w}" height="10" rx="1.5" style="fill:${fill}"/>`
  }
  const dropIn = (i: number) =>
    boxesAddedAt && i >= boxesAddedAt.from && now - boxesAddedAt.at < 900
      ? `<animateTransform attributeName="transform" type="translate" from="0 -60" to="0 0" dur=".7s" begin="${sinceBegin(now, boxesAddedAt.at)}" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".3 0 .5 1.4"/>`
      : ''
  const topple = (i: number, at: number) => {
    const begin = `-${Math.max(0, (now - at) / 1000 - i * 0.04).toFixed(2)}s`
    return `<animateTransform attributeName="transform" type="translate" from="0 0" to="${-60 - i * 14} ${(i + 1) * 11 + 20}" dur=".9s" begin="${begin}" fill="freeze" ${FALL}/>
      <animateTransform attributeName="transform" type="rotate" from="0" to="${-40 - jitter(i) * 80}" dur=".9s" begin="${begin}" fill="freeze" additive="sum"/>
      <animate attributeName="opacity" values="1;1;0" keyTimes="0;.7;1" dur="1.2s" begin="${begin}" fill="freeze"/>`
  }
  const wobble = Math.pow(f, 2) * 9
  const sway =
    !isClearing && wobble > 0.5
      ? `<animateTransform attributeName="transform" type="rotate" values="${-wobble};${wobble};${-wobble}" dur="${(pace * 2.4).toFixed(2)}s" begin="${loopBegin(now, pace * 2.4)}" repeatCount="indefinite" additive="sum"/>`
      : ''
  // While clearing, the load the critter carried falls off; the meter still
  // holds the old size until the next measure, so draw that one.
  const stack = isClearing
    ? Array.from({ length: n }, (_, i) => `<g>${topple(i, phase.since)}${box(i)}</g>`).join('')
    : Array.from({ length: n }, (_, i) => `<g>${dropIn(i)}${box(i)}</g>`).join('')

  const envelope = (x: number, y: number) =>
    `<g transform="translate(${x} ${y})"><rect width="16" height="11" rx="1.5" style="fill:var(--note);stroke:var(--wood2)" stroke-width=".7"/><path d="M0 0 l8 6 l8 -6" fill="none" style="stroke:var(--wood2)" stroke-width=".7"/></g>`
  const carriesNote = hop !== undefined || (n === 0 && phase.kind === 'idle')

  const writing =
    phase.kind === 'writing'
      ? `${envelope(28, -52)}${[0, 1, 2]
          .map(i => `<circle cx="${50 + i * 6}" cy="-46" r="1.8" style="fill:var(--accent)"><animate attributeName="opacity" values=".2;1;.2" dur="1.2s" begin="${(i * 0.2).toFixed(1)}s" repeatCount="indefinite"/></circle>`)
          .join('')}`
      : ''

  const bounceY = hop ? -16 : -3 + f * 2.5
  const bounce = `<animateTransform attributeName="transform" type="translate" values="0 0;0 ${bounceY.toFixed(1)};0 0" dur="${(hop ? 0.45 : pace).toFixed(2)}s" begin="${loopBegin(now, hop ? 0.45 : pace)}" repeatCount="indefinite" additive="sum"/>`

  let chip = ''
  if (hop) {
    const begin = sinceBegin(now, hop.at)
    chip = `<text x="${cx}" y="40" text-anchor="middle" font-size="13" font-weight="650" class="num halo" style="fill:var(--good)">−${tokens(hop.freed)} tokens
      <animate attributeName="y" from="60" to="24" dur="3s" begin="${begin}" fill="freeze" ${EASE}/>
      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.7;1" dur="3s" begin="${begin}" fill="freeze"/>
    </text>`
  }

  const label =
    phase.kind === 'writing'
      ? `<tspan font-weight="600">Writing note…</tspan>`
      : isClearing
        ? `<tspan font-weight="600">Clearing…</tspan>`
        : `<tspan font-weight="600">${tokens(m.tokens)}</tspan><tspan class="muted"> of ${tokens(limit)}</tspan>`

  const tip = `Context: ${tokens(m.tokens)} of ${tokens(limit)} tokens. Each box is part of the conversation. At ${tokens(limit)}, Cost guard hands off to a fresh context and drops the load.`

  return `<g>
    <title>${esc(tip)}</title>
    ${ground}
    <g transform="translate(${cx} ${baseY})"><g>
      ${bounce}
      ${legs}
      <g transform="scale(1 ${squash.toFixed(2)})">
        ${body}
        <g transform="translate(-4 -30)">${sway}${stack}</g>
        ${sweat}
        ${carriesNote ? envelope(-6, -42) : ''}
        ${writing}
      </g>
    </g></g>
    ${chip}
    <text x="${cx}" y="176" text-anchor="middle" font-size="12" class="num">${label}</text>
  </g>`
}

function floater(text: string, x: number, at: number | undefined, now: number) {
  if (at === undefined || now - at > 2_400) return ''
  const begin = sinceBegin(now, at)
  return `<text x="${x}" y="30" font-size="12" font-weight="600" class="num" style="fill:var(--accent)">${text}
      <animate attributeName="y" from="32" to="16" dur="2.4s" begin="${begin}" fill="freeze" ${EASE}/>
      <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.12;.6;1" dur="2.4s" begin="${begin}" fill="freeze"/>
    </text>`
}

function resetsIn(iso: string | undefined, now: number) {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'resets soon'
  const h = Math.floor(ms / 3_600_000)
  const min = Math.ceil((ms % 3_600_000) / 60_000)
  if (h >= 48) return `resets in ${Math.round(h / 24)} days`
  if (h >= 1) return `resets in ${h}h ${min}m`
  return `resets in ${min} min`
}

// The plan's usage limits, never dollars: the person is on a subscription.
function usageBlock(m: Meter, motion: Motion) {
  const { now } = motion
  const week = m.limits.find(l => l.kind === 'seven_day')
  const five = m.limits.find(l => l.kind === 'five_hour')

  if (!week && !five) {
    return `<g>
      <title>Your plan's usage limits show here once Claude replies.</title>
      <text x="150" y="32" font-size="28" font-weight="650" class="num muted">—</text>
      <text x="150" y="49" font-size="11" class="muted">Usage limits appear after Claude's next reply</text>
    </g>`
  }

  const main = week ?? five!
  const big = `${Math.round(main.percentUsed)}%`
  const fromSession =
    week && m.weekAtStart !== undefined ? Math.max(0, Math.round(week.percentUsed - m.weekAtStart)) : undefined
  const sub = [
    week ? 'of your weekly limit' : 'of your 5-hour limit',
    fromSession !== undefined ? `${fromSession}% from this session` : resetsIn(main.resetsAt, now),
  ]
    .filter(Boolean)
    .join(' · ')
  const mainTip = `${week ? 'Weekly' : '5-hour'} limit: ${main.percentUsed}% used${main.resetsAt ? `, ${resetsIn(main.resetsAt, now)}` : ''}.`

  let fiveRow = ''
  if (week && five) {
    const W = 246
    const used = Math.min(1, five.percentUsed / 100)
    fiveRow = `<g><title>5-hour limit: ${five.percentUsed}% used${five.resetsAt ? `, ${resetsIn(five.resetsAt, now)}` : ''}.</title>
      <text x="150" y="66" font-size="11"><tspan font-weight="600">5-hour limit ${Math.round(five.percentUsed)}%</tspan><tspan class="muted"> · ${resetsIn(five.resetsAt, now)}</tspan></text>
      <rect x="150" y="72" width="${W}" height="6" rx="3" style="fill:var(--track)"/>
      <rect x="150" y="72" width="${(W * used).toFixed(1)}" height="6" rx="3" style="fill:${tone(used)}">
        <animate attributeName="width" from="${(W * Math.min(1, lastFive / 100)).toFixed(1)}" to="${(W * used).toFixed(1)}" dur=".9s" fill="freeze" ${EASE}/>
      </rect></g>`
    lastFive = five.percentUsed
  }

  return `<g>
    <title>${esc(mainTip)}</title>
    <text x="150" y="32" font-size="28" font-weight="650" class="num" style="fill:${tone(main.percentUsed / 100)}">${big}</text>
    ${floater(`+${motion.limitBump?.points ?? 1}%`, 150 + big.length * 16 + 8, motion.limitBump?.at, now)}
    <text x="150" y="49" font-size="11" class="muted">${esc(sub)}</text>
  </g>${fiveRow}`
}

function warmthBlock(m: Meter, warmMs: number | undefined, motion: Motion) {
  const W = 246
  const x = 150
  const y = 98
  const total = ttlMs(m.ttl)
  const tip = `The cache lets Claude reread this conversation for a fraction of the usage. It expires after ${m.ttl === '1h' ? '1 hour' : '5 minutes'} without a message.`

  if (motion.isRunning) {
    return `<g><title>${esc(tip)}</title>
      <text x="${x}" y="${y - 6}" font-size="11"><tspan font-weight="600">Cache in use</tspan></text>
      <clipPath id="warm"><rect x="${x}" y="${y}" width="${W}" height="6" rx="3"/></clipPath>
      <g clip-path="url(#warm)">
        <rect x="${x}" y="${y}" width="${W}" height="6" style="fill:var(--good)"/>
        <rect x="${x - 60}" y="${y}" width="60" height="6" fill="url(#shine)">
          <animate attributeName="x" from="${x - 60}" to="${x + W}" dur="1.6s" begin="${loopBegin(motion.now, 1.6)}" repeatCount="indefinite"/>
        </rect>
      </g></g>`
  }

  if (warmMs === undefined) {
    return `<g><title>${esc(tip)}</title>
      <text x="${x}" y="${y - 6}" font-size="11" class="muted">The cache starts with Claude's first reply</text>
      <rect x="${x}" y="${y}" width="${W}" height="6" rx="3" style="fill:var(--track)"/></g>`
  }

  const left = Math.max(0, Math.min(1, warmMs / total))
  const minutes = Math.ceil(warmMs / 60_000)
  const color = left <= 0 ? 'var(--hot)' : warmMs < 10 * 60_000 && m.ttl === '1h' ? 'var(--warn)' : warmMs < 60_000 ? 'var(--warn)' : 'var(--good)'
  const label =
    left <= 0
      ? `<tspan font-weight="600" style="fill:var(--hot)">Cache expired</tspan><tspan class="muted"> · the next message rebuilds it</tspan>`
      : `<tspan font-weight="600">Cache warm</tspan><tspan class="muted"> · ${minutes} min left</tspan>`
  const fillW = (W * left).toFixed(1)
  const drain =
    left > 0
      ? `<animate attributeName="width" from="${fillW}" to="0" dur="${(warmMs / 1000).toFixed(0)}s" fill="freeze"/>`
      : ''
  const ember =
    left > 0
      ? `<circle cx="${(x + W * left).toFixed(1)}" cy="${y + 3}" r="4.2" style="fill:${color}">
          <animate attributeName="cx" from="${(x + W * left).toFixed(1)}" to="${x}" dur="${(warmMs / 1000).toFixed(0)}s" fill="freeze"/>
          <animate attributeName="r" values="3.4;5;3.4" dur="2s" begin="${loopBegin(motion.now, 2)}" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="1;.55;1" dur="2s" begin="${loopBegin(motion.now, 2)}" repeatCount="indefinite"/>
        </circle>`
      : ''
  return `<g><title>${esc(tip)}</title>
    <text x="${x}" y="${y - 6}" font-size="11">${label}</text>
    <rect x="${x}" y="${y}" width="${W}" height="6" rx="3" style="fill:var(--track)"/>
    <rect x="${x}" y="${y}" width="${fillW}" height="6" rx="3" style="fill:${color}">${drain}</rect>
    ${ember}</g>`
}

function historyBlock(m: Meter, motion: Motion) {
  const hits = m.hits.slice(-24)
  const offset = m.hits.length - hits.length
  const base = 156
  const barW = 6.5
  const gap = 3.7
  const isFresh = motion.hitAt !== undefined && motion.now - motion.hitAt < 1_200
  const bars = hits
    .map((hit, i) => {
      const h = Math.max(3, Math.round((hit / 100) * 36))
      const x = (150 + i * (barW + gap)).toFixed(1)
      const isNewest = i === hits.length - 1
      const grow =
        isNewest && isFresh && motion.hitAt !== undefined
          ? `<animate attributeName="height" from="0" to="${h}" dur=".7s" begin="${sinceBegin(motion.now, motion.hitAt)}" fill="freeze" ${EASE}/>
             <animate attributeName="y" from="${base}" to="${base - h}" dur=".7s" begin="${sinceBegin(motion.now, motion.hitAt)}" fill="freeze" ${EASE}/>`
          : ''
      const glow = isNewest
        ? `<animate attributeName="opacity" values="1;.6;1" dur="2.4s" begin="${loopBegin(motion.now, 2.4)}" repeatCount="indefinite"/>`
        : ''
      return `<rect class="bar" x="${x}" y="${base - h}" width="${barW}" height="${h}" rx="2" style="fill:${hitTone(hit)}"><title>Request ${offset + i + 1}: ${hit}% from cache</title>${grow}${glow}</rect>`
    })
    .join('')
  const rate = hitRate(m.hits)
  const empty = hits.length === 0 ? `<text x="150" y="146" font-size="11" class="muted">Cache history fills in as Claude works</text>` : ''
  return `<line x1="150" y1="${base + 0.5}" x2="396" y2="${base + 0.5}" style="stroke:var(--track)"/>
    ${bars}${empty}
    <text x="150" y="172" font-size="11"><tspan font-weight="600">${rate !== undefined ? `${rate}% from cache` : 'Cache'}</tspan><tspan class="muted">${rate !== undefined ? ' · last 8 requests' : ''}</tspan></text>`
}

function heroSvg(m: Meter, s: GuardSettings, phase: Phase, warmMs: number | undefined, motion: Motion) {
  const limit = s.autoHandoff ? s.handoffAt : m.window || s.handoffAt
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 178" width="100%">
  <style>${PALETTE}</style>
  <defs>
    <clipPath id="scene"><rect width="142" height="178"/></clipPath>
    <linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  ${critter(m, limit, phase, motion)}
  ${usageBlock(m, motion)}
  ${warmthBlock(m, warmMs, motion)}
  ${historyBlock(m, motion)}
</svg>`
}

function gaugeText(m: Meter, s: GuardSettings) {
  const limit = s.autoHandoff ? s.handoffAt : m.window || s.handoffAt
  const width = 24
  const filled = Math.round(Math.min(1, m.tokens / Math.max(1, limit)) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${tokens(m.tokens)} / ${tokens(limit)}`
}

function sparkText(hits: readonly number[]) {
  const blocks = '▁▂▃▄▅▆▇█'
  return hits
    .slice(-24)
    .map(h => blocks[Math.min(7, Math.floor(h / 12.5))])
    .join('')
}

const MOMENT_MARK: Record<Moment['kind'], { mark: string; color: 'success' | 'warning' | 'error' | 'suggestion' | 'subtle' }> = {
  handoff: { mark: '↻', color: 'success' },
  miss: { mark: '!', color: 'error' },
  trim: { mark: '✂', color: 'suggestion' },
  route: { mark: '→', color: 'suggestion' },
  skip: { mark: '·', color: 'warning' },
}

// ---------- register ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadSettings($)
    // A meter saved by an older version has no limits yet.
    await update($, meterAtom, m => (m.limits ? m : { ...m, limits: [] }))
    await $.command.register({ name: 'cost-guard', description: 'Open the cost guard pane, or: on, off, status, threshold <tokens>' })
    await $.command.register({ name: 'handoff', description: 'Save a handoff note, clear the conversation and carry on in a fresh context' })
    $.clock.every(30_000, () => void idleCheck($))
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const isSubscription = e.rateLimits.length > 0
    const now = await $.clock.now()
    const prev = await read($, meterAtom)
    const weekNow = e.rateLimits.find(l => l.kind === 'seven_day')?.percentUsed
    const weekBefore = prev.limits.find(l => l.kind === 'seven_day')?.percentUsed
    if (weekNow !== undefined && weekBefore !== undefined && Math.floor(weekNow) > Math.floor(weekBefore)) {
      limitBump = { at: now, points: Math.floor(weekNow) - Math.floor(weekBefore) }
    }
    await update($, meterAtom, (m): Meter => ({
      ...m,
      tokens: e.context.tokens ?? m.tokens,
      window: e.context.window,
      usd: e.cost?.usd ?? m.usd,
      ttl: isSubscription ? '1h' : '5m',
      limits: isSubscription ? e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })) : m.limits,
      weekAtStart: m.weekAtStart ?? weekNow,
    }))
    if (freedFrom !== undefined && e.context.tokens !== undefined && e.context.tokens < freedFrom) {
      const freed = freedFrom - e.context.tokens
      freedFrom = undefined
      await update($, meterAtom, m => ({ ...m, freedTokens: m.freedTokens + freed }))
    }
    await refreshStatus($)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await loadSettings($)
      await refreshStatus($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const isResume = e.origin?.kind === 'plugin' && e.origin.name === 'cost-guard' && e.text.startsWith('[cost-guard handoff]')
    if (isResume) {
      // The note already went with the person's message.
      if (pendingResume === undefined) return { drop: 'The handoff note already went with your message.' }
      pendingResume = undefined
      return next(e)
    }
    if (pendingResume === undefined || e.command !== undefined || e.isMeta) return next(e)
    const { context } = pendingResume
    pendingResume = undefined
    return next({ ...e, context: [...(e.context ?? []), context] })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await loadSettings($)
      turnsStarted += 1
      isTurnRunning = true
      await update($, runningAtom, () => true)
    }
    return next(e)
  })

  on('classic.Stop', ($, e, next) => {
    lastStop = { background: e.background_tasks?.length ?? 0 }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      await update($, runningAtom, () => false)
      if (e.reason === 'answer') $.clock.after(1_500, () => void maybeHandOff($))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let step = e
    if (e.agentId !== undefined && /opus|fable|mythos/.test(e.model)) {
      const s = await read($, settingsAtom)
      if (s.cheapSubagents) {
        let type = agentTypes.get(e.agentId)
        if (type === undefined) {
          for (const agent of await $.agent.list()) agentTypes.set(agent.id, agent.type)
          type = agentTypes.get(e.agentId)
        }
        if (type !== undefined && ROUTED_TYPES.has(type)) {
          step = { ...e, model: CHEAP_MODEL }
          if (!routedAgents.has(e.agentId)) {
            routedAgents.add(e.agentId)
            await remember($, 'route', `${type} subagent switched to Sonnet 5.5 from ${e.model.replace(/^claude-/, '')}.`)
          }
        }
      }
    }

    const r = yield* next(step)

    if (e.agentId === undefined && r.usage) {
      const u = r.usage
      const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const now = await $.clock.now()
      const before = await read($, meterAtom)
      if (total > 0) {
        const hit = Math.round((u.cache_read_input_tokens / total) * 100)
        const isMiss = total > 20_000 && hit < 50 && !expectsFreshPrefix && before.lastRequestAt !== undefined
        let lost = 0
        if (isMiss) {
          const price = basePrice(u.model)
          if (price !== undefined) {
            lost = (u.cache_creation_input_tokens * price * (writeMultiplier(before.ttl) - readMultiplier(u.model))) / 1e6
          }
          const idle = now - (before.lastRequestAt ?? now)
          const cause =
            idle > ttlMs(before.ttl)
              ? `the cache expired after ${Math.round(idle / 60_000)} min idle`
              : before.model && before.model !== u.model
                ? 'the model changed'
                : 'tools, MCP servers or settings changed'
          await remember($, 'miss', `Cache miss: ${cause}.`)
        }
        expectsFreshPrefix = false
        hitAt = now
        await update($, meterAtom, m => ({
          ...m,
          hits: [...m.hits, hit].slice(-48),
          missUsd: m.missUsd + lost,
          lastRequestAt: now,
          model: u.model,
        }))
        await refreshStatus($)
      }
    }
    return r
  })

  on('session.compact', ($, e, next) => {
    const keep =
      'Keep: the goal, the current plan and next steps, decisions and the user\'s stated preferences, every file touched with its absolute path, open questions, scheduled loops, and exact commands, ids and test results.'
    expectsFreshPrefix = true
    return next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${keep}` : keep })
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || e.run_in_background) return ran
    const s = await read($, settingsAtom)
    const output = ran.result as Record<string, unknown> | undefined
    const out = output?.stdout
    if (!s.trimOutput || typeof out !== 'string' || out.length <= s.trimAt) return ran

    const path = `${await home($)}/.claude/cost-guard/output/${await stamp($)}.log`
    await $.fs.write(path, out)
    const head = out.slice(0, Math.floor(s.trimAt * 0.6))
    const tail = out.slice(-Math.floor(s.trimAt * 0.3))
    const cut = out.length - head.length - tail.length
    const stdout = `${head}\n\n[cost-guard cut ${cut.toLocaleString('en-US')} characters from the middle of this output. The full output is at ${path}: read it with an offset and limit, or grep it, if you need more.]\n\n${tail}`
    await remember($, 'trim', `Trimmed ${cut.toLocaleString('en-US')} characters of Bash output. Full output saved.`)
    // Dropping `ref` and `text` makes core map the trimmed result instead of its own.
    const { ref: _ref, text: _text, ...rest } = ran
    return { ...rest, result: { ...output, stdout } }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'handoff' }, async $ => {
    if (isBusy) return { text: 'A handoff is already running.' }
    $.clock.after(200, () => void handOff($, 'manual'))
    return { text: 'Writing a handoff note. Then the conversation clears and continues in a fresh context.' }
  })

  on('command.run', { command: 'cost-guard' }, async ($, e) => {
    const [word, value] = (e.args ?? '').trim().toLowerCase().split(/\s+/)
    if (word === 'on' || word === 'off') {
      await saveSettings($, { autoHandoff: word === 'on' })
      await refreshStatus($)
      return { text: `Auto handoff is ${word}.` }
    }
    if (word === 'threshold') {
      const n = Number((value ?? '').replace(/k$/, '000').replace(/m$/, '000000'))
      if (!Number.isFinite(n) || n < 50_000) return { text: 'Use at least 50K tokens, for example /cost-guard threshold 150k.' }
      await saveSettings($, { handoffAt: Math.round(n) })
      await refreshStatus($)
      return { text: `Auto handoff now runs at ${tokens(n)} tokens.` }
    }
    if (word === 'status') {
      const s = await read($, settingsAtom)
      const m = await read($, meterAtom)
      return {
        text: [
          `Auto handoff: ${s.autoHandoff ? `on, at ${tokens(s.handoffAt)} tokens` : 'off'}`,
          `Idle handoff: ${s.idleHandoff ? `on, when idle with ${tokens(s.idleHandoffAt)}+ tokens` : 'off'}`,
          `Trim output: ${s.trimOutput ? `on, Bash output over ${s.trimAt.toLocaleString('en-US')} characters` : 'off'}`,
          `Cheaper subagents: ${s.cheapSubagents ? 'on' : 'off'}`,
          `Context: ${tokens(m.tokens)} · cache ${hitRate(m.hits) ?? '—'}% · ${m.handoffs} handoffs`,
        ].join('\n'),
      }
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Cost guard pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const s = await read($, settingsAtom)
    const m = await read($, meterAtom)
    const phase = await read($, phaseAtom)
    const moments = await read($, momentsAtom)
    const isRunning = await read($, runningAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    const warmMs = m.lastRequestAt === undefined ? undefined : ttlMs(m.ttl) - (now - m.lastRequestAt)
    const motion: Motion = { now, isRunning, limitBump, hitAt, handoff: handoffMark }

    const limit = s.autoHandoff ? s.handoffAt : m.window || s.handoffAt
    const fullness = m.tokens / Math.max(1, limit)
    const thresholds = [...new Set([...THRESHOLDS, s.handoffAt])].sort((a, b) => a - b)
    const isFresh = handoffMark !== undefined && now - handoffMark.at < 60_000

    const tips: Record<string, { title: string; body: string }> = {
      'handoff-now': {
        title: 'Hand off now',
        body: 'Saves a handoff note, clears the conversation and continues in a fresh context. Best between tasks.',
      },
      threshold: {
        title: `Hand off at ${tokens(s.handoffAt)}`,
        body: 'Lower resends less history with each message; higher keeps more in one context. Takes effect after Claude’s next reply. Other values: /cost-guard threshold 250k',
      },
      autoHandoff: {
        title: `Auto handoff · ${s.autoHandoff ? 'On' : 'Off'}`,
        body: `At ${tokens(s.handoffAt)} tokens, saves a handoff note and continues in a fresh context, so long sessions use less of your limit.`,
      },
      idleHandoff: {
        title: `Idle handoff · ${s.idleHandoff ? 'On' : 'Off'}`,
        body: 'After 50 minutes away, hands off before the cache expires, so your next message doesn’t reprocess the whole conversation.',
      },
      trimOutput: {
        title: `Trim output · ${s.trimOutput ? 'On' : 'Off'}`,
        body: `Shortens command output over ${tokens(s.trimAt)} characters to its start and end. The full output is saved to a file Claude can read.`,
      },
      cheapSubagents: {
        title: `Cheaper subagents · ${s.cheapSubagents ? 'On' : 'Off'}`,
        body: 'Runs Explore subagents on Sonnet 5.5 to save usage. Your main conversation keeps its model and its cache.',
      },
    }

    // Each button lights a hover group; its tip in the slot below joins the
    // same group, so pointing at a button reveals what it does.
    const withTip = (id: string, button: ReturnType<typeof Button>) => (
      <Box key={`tip-${id}`} hover={{ scope: `tip-${id}` }}>
        {button}
      </Box>
    )

    const toggle = (key: keyof GuardSettings, label: string, value: boolean) =>
      withTip(
        key,
        <Button
          key={key}
          label={`${label}: ${value ? 'On' : 'Off'}`}
          dimColor={!value}
          onPress={async () => {
            await saveSettings($, { [key]: !value })
            await refreshStatus($)
          }}
        >
          <Text color={value ? 'success' : 'subtle'}>{value ? '●' : '○'}</Text> {label}
        </Button>,
      )

    const headline =
      phase.kind === 'writing'
        ? 'Writing the handoff note…'
        : phase.kind === 'clearing'
          ? 'Clearing and continuing in a fresh context…'
          : isFresh
            ? `Fresh start. Freed ${tokens(handoffMark!.freed)} tokens.`
            : !s.autoHandoff
              ? 'Auto handoff is off. Use Hand off now when the context gets large.'
              : fullness < 0.6
                ? `Plenty of room. Hands off at ${tokens(s.handoffAt)}.`
                : fullness < 0.85
                  ? `Filling up. Hands off at ${tokens(s.handoffAt)}.`
                  : `Almost full. Hands off at ${tokens(s.handoffAt)}.`
    const headlineColor =
      phase.kind !== 'idle' ? 'claude' : isFresh ? 'success' : !s.autoHandoff ? 'subtle' : fullness < 0.6 ? 'success' : fullness < 0.85 ? 'warning' : 'error'

    const week = m.limits.find(l => l.kind === 'seven_day')
    const alt = [
      `Context ${tokens(m.tokens)} of ${tokens(limit)}`,
      week ? `weekly limit ${week.percentUsed}% used` : undefined,
      `cache ${hitRate(m.hits) ?? 0}%`,
    ]
      .filter(Boolean)
      .join(', ')

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {'Svg' in ui && e.surface !== 'terminal' ? (
          <ui.Svg source={heroSvg(m, s, phase, warmMs, motion)} alt={alt} isInteractive />
        ) : (
          <Box flexDirection="column">
            <Text weight="semibold">
              {week ? `${Math.round(week.percentUsed)}%` : '—'}{' '}
              <Text dimColor>{week ? 'of your weekly limit' : 'usage limits appear after Claude’s next reply'}</Text>
            </Text>
            <Text color={fullness < 0.6 ? 'success' : fullness < 0.85 ? 'warning' : 'error'}>{gaugeText(m, s)}</Text>
            <Text color="success">
              {sparkText(m.hits)} <Text dimColor>cache {hitRate(m.hits) ?? '—'}%</Text>
            </Text>
          </Box>
        )}

        <Text color={headlineColor} weight="medium">
          {headline}
        </Text>

        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {withTip(
              'handoff-now',
              <Button key="handoff-now" variant="primary" onPress={() => void handOff($, 'manual')}>
                Hand off now
              </Button>,
            )}
            {toggle('autoHandoff', 'Auto handoff', s.autoHandoff)}
            {toggle('idleHandoff', 'Idle handoff', s.idleHandoff)}
            {toggle('trimOutput', 'Trim output', s.trimOutput)}
            {toggle('cheapSubagents', 'Cheaper subagents', s.cheapSubagents)}
          </Box>
          <Box key="tip-threshold" hover={{ scope: 'tip-threshold' }} flexDirection="row" flexWrap="wrap" alignItems="center" gap={1} marginTop={1}>
            <Text dimColor>Hand off at</Text>
            {thresholds.map(value => (
              <Button
                key={`threshold-${value}`}
                label={value === s.handoffAt ? `✓ ${tokens(value)}` : tokens(value)}
                variant={value === s.handoffAt ? 'primary' : undefined}
                dimColor={value !== s.handoffAt}
                onPress={async () => {
                  await saveSettings($, { handoffAt: value })
                  await refreshStatus($)
                }}
              />
            ))}
          </Box>
          <Box flexDirection="column" height={4} overflow="hidden" marginTop={1}>
            {Object.entries(tips).map(([id, tip]) => (
              <Box key={`tip-card-${id}`} flexDirection="column" display="none" hover={{ scope: `tip-${id}`, display: 'flex' }}>
                <Text weight="semibold" size="footnote">{tip.title}</Text>
                <Text dimColor size="footnote">{tip.body}</Text>
              </Box>
            ))}
            <Text dimColor size="footnote">Point at a button to see what it does.</Text>
          </Box>
        </Box>

        {m.handoffs > 0 && (
          <Text dimColor>
            Freed {tokens(m.freedTokens)} tokens in {m.handoffs} {m.handoffs === 1 ? 'handoff' : 'handoffs'}.
          </Text>
        )}

        <Box flexDirection="column">
          <Text weight="semibold" size="footnote">Recent</Text>
          {moments.length === 0 && <Text dimColor>Nothing yet. Handoffs, cache misses and trimmed output appear here.</Text>}
          {moments
            .slice(-6)
            .reverse()
            .map((moment, i) => (
              <Text weight={i === 0 && now - moment.at < 60_000 ? 'medium' : undefined}>
                <Text color={MOMENT_MARK[moment.kind].color}>{MOMENT_MARK[moment.kind].mark}</Text> {moment.text}{' '}
                <Text dimColor>{ago(now - moment.at)}</Text>
              </Text>
            ))}
        </Box>
      </Box>
    )
  })
}
