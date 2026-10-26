import { atom, read, update } from 'claude-code'
import type { Atom, EngineInterface, Register } from 'claude-code'

import type { Harbor, LogEntry, StepStatus, StepView } from '../types'

type E = EngineInterface

const PANE = 'ship-gate'
const TITLE = 'Ship gate'

const harborAtom: Atom<Harbor> = atom({ plugin: 'ship-gate', key: 'harbor' } as const, { steps: [], changed: 0 } as Harbor)
const logAtom: Atom<LogEntry[]> = atom({ plugin: 'ship-gate', key: 'log' } as const, [] as LogEntry[])
const onAtom: Atom<boolean> = atom({ plugin: 'ship-gate', key: 'isOn' } as const, true)
const tickAtom: Atom<number> = atom({ plugin: 'ship-gate', key: 'tick' } as const, 0)

// ---------- steps ----------

type Action = 'commit' | 'push' | 'pr'
const ACTIONS: Action[] = ['commit', 'push', 'pr']
const ACTION_WORD: Record<Action, string> = { commit: 'commit', push: 'push', pr: 'pull request' }

type Done =
  | { skill: string | string[] }
  | { command: string }
  | { sent: 'media' | 'image' | 'video' | 'any' }
  | { approval: true }

type StepConfig = {
  id: string
  name?: string
  flag?: string
  /** Which actions wait for it. */
  gates?: Action[]
  /** It applies when a changed file matches one of these globs. */
  paths?: string[]
  exclude?: string[]
  /** It applies only when the matching files gained user-facing text. */
  copy?: boolean
  /** It applies only when an added line matches this regular expression. */
  matches?: string
  /** What the matching files are called in the pane: "UI files". */
  about?: string
  done?: Done
  /** Changes to strings alone don't undo it (a code review after a copy fix). */
  ignoreCopyEdits?: boolean
  off?: boolean
}

type Step = StepConfig & { name: string; flag: string; gates: Action[]; paths: string[]; done: Done }

type Route = { model: string; effort: string }

type GateConfig = {
  steps?: StepConfig[]
  /** Where pull requests go unless the branch matches `except`. */
  prBase?: { branch: string; except?: string } | false
  /** Blocks yarn and pnpm where the lockfile is package-lock.json. */
  lockfileGuard?: boolean
  review?: { small?: Route; large?: Route; riskyPaths?: string; largeLines?: number }
}

const UI_PATHS = [
  '**/*.{tsx,jsx,vue,svelte,html,css,scss,swift,kt,dart}',
  '**/res/layout/**',
  '**/{locales,locale,i18n,translations,lang}/**',
  '**/*.strings',
]

const DEFAULT_STEPS: Step[] = [
  {
    id: 'review',
    name: 'Code review',
    flag: 'R',
    gates: ACTIONS,
    paths: ['**'],
    exclude: ['**/*.md'],
    about: 'code',
    ignoreCopyEdits: true,
    done: { skill: 'code-review' },
  },
  {
    id: 'copy',
    name: 'UX copy check',
    flag: 'C',
    gates: ACTIONS,
    paths: UI_PATHS,
    copy: true,
    about: 'UI files',
    done: { skill: 'design:ux-copy' },
  },
  {
    id: 'marketing',
    name: 'Marketing copy check',
    flag: 'M',
    gates: ACTIONS,
    paths: ['**/README.md', '**/*.mdx', '**/{blog,marketing,landing,website}/**'],
    about: 'README or marketing pages',
    done: { skill: 'marketing:brand-review' },
  },
  {
    id: 'proof',
    name: 'Proof',
    flag: 'S',
    gates: ACTIONS,
    paths: UI_PATHS,
    exclude: ['**/*.{test,spec}.*', '**/__tests__/**', '**/tests/**'],
    about: 'UI files',
    done: { sent: 'media' },
  },
]

const DEFAULT_CONFIG: Required<Omit<GateConfig, 'steps' | 'review'>> & { review: Required<NonNullable<GateConfig['review']>> } = {
  prBase: { branch: 'staging', except: '^hotfix' },
  lockfileGuard: true,
  review: {
    small: { model: 'claude-sonnet-5-5', effort: 'medium' },
    large: { model: 'claude-opus-5-5', effort: 'high' },
    riskyPaths: '(pay|stripe|billing|checkout|invoice|auth|login|signup|password|oauth|token|migrat|schema|webhook|\\.sql$|(^|/)db/|database|wrangler\\.(toml|json))',
    largeLines: 400,
  },
}

type Config = typeof DEFAULT_CONFIG & { steps: Step[] }

// ---------- module state (resets on reload) ----------

let currentRoot: string | undefined
const rootOf = new Map<string, string | null>()
// Skills that started this turn, per repository: they count for the code as it
// stands when Claude next commits or the turn ends, so fixes made right after count.
const pending = new Map<string, Map<string, string>>()
const copyOnly = new Map<string, boolean>()
let reviewRoute: { model: string; why: string; isLogged: boolean } | undefined
let passOnce: string | undefined
let clearedAt: number | undefined
let wasClear = false
let queue: Promise<unknown> = Promise.resolve()

// Survey and record in turn: two at once would race on the same voyage.
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

// ---------- small helpers ----------

function globRe(glob: string): RegExp {
  let re = ''
  let depth = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      depth++
      re += '(?:'
    } else if (c === '}' && depth > 0) {
      depth--
      re += ')'
    } else if (c === ',' && depth > 0) re += '|'
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

const globCache = new Map<string, RegExp>()
function matches(glob: string, path: string) {
  let re = globCache.get(glob)
  if (!re) globCache.set(glob, (re = globRe(glob)))
  return re.test(path)
}

const inScope = (step: Step, path: string) =>
  step.paths.some(g => matches(g, path)) && !(step.exclude ?? []).some(g => matches(g, path))

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`
  return `${Math.floor(min / 1440)} days ago`
}

function clockTime(at: number) {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fileList(paths: string[], max = 2) {
  const names = paths.map(p => p.split('/').pop() ?? p)
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function listWords(words: string[]) {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

const skillTail = (s: string) => s.split(':').pop() ?? s
function skillMatches(want: string, got: string) {
  if (want === got) return true
  return skillTail(want) === skillTail(got) && (!want.includes(':') || !got.includes(':'))
}
const skillsOf = (done: Done) => ('skill' in done ? (Array.isArray(done.skill) ? done.skill : [done.skill]) : [])

async function log($: E, kind: LogEntry['kind'], text: string) {
  const at = await $.clock.now()
  await update($, logAtom, list => [...list, { at, kind, text }].slice(-40))
}

async function home($: E) {
  return (await $.env.get('HOME')) ?? '/tmp'
}

function resolvePath(dir: string, p: string, homeDir: string) {
  const raw = p.startsWith('~') ? homeDir + p.slice(1) : p.startsWith('/') ? p : `${dir}/${p}`
  const out: string[] = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2')
const repoName = (root: string) => root.split('/').pop() ?? root

// ---------- config ----------

async function readJson($: E, path: string): Promise<GateConfig | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    return JSON.parse(await $.fs.read(path)) as GateConfig
  } catch {
    return undefined
  }
}

const globalFile = async ($: E) => `${await home($)}/.claude/ship-gate.json`
const projectFile = (root: string) => `${root}/.claude/ship-gate.json`

function mergeSteps(base: Step[], extra: StepConfig[] | undefined): Step[] {
  const out = base.map(s => ({ ...s }))
  for (const s of extra ?? []) {
    const i = out.findIndex(o => o.id === s.id)
    if (i >= 0) out[i] = { ...out[i]!, ...s } as Step
    else if (s.done) out.push({ name: s.id, flag: 'Q', gates: ACTIONS, paths: ['**'], ...s, done: s.done })
  }
  return out
}

async function loadConfig($: E, root: string | undefined): Promise<Config> {
  const g = await readJson($, await globalFile($))
  const p = root ? await readJson($, projectFile(root)) : undefined
  const pick = <K extends keyof GateConfig>(k: K) => (p?.[k] !== undefined ? p[k] : g?.[k])
  return {
    prBase: pick('prBase') ?? DEFAULT_CONFIG.prBase,
    lockfileGuard: pick('lockfileGuard') ?? DEFAULT_CONFIG.lockfileGuard,
    review: { ...DEFAULT_CONFIG.review, ...g?.review, ...p?.review },
    steps: mergeSteps(mergeSteps(DEFAULT_STEPS, g?.steps), p?.steps).filter(s => !s.off),
  }
}

// ---------- git ----------

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function git($: E, root: string, args: string[], stdin?: string) {
  return $.process.run(['git', ...args], { cwd: root, timeoutMs: 20_000, ...(stdin !== undefined ? { stdin } : {}) })
}

async function repoRoot($: E, dir: string): Promise<string | undefined> {
  if (rootOf.has(dir)) return rootOf.get(dir) ?? undefined
  let root: string | null = null
  try {
    const r = await git($, dir, ['rev-parse', '--show-toplevel'])
    if (r.exitCode === 0 && r.stdout.trim()) root = r.stdout.trim()
  } catch {
    root = null
  }
  rootOf.set(dir, root)
  return root ?? undefined
}

type Record_ = { at: number; snap: Record<string, string>; how: string }
type Voyage = { base?: string; records: Record<string, Record_> }

// Store keys are capped at 256 characters, so a repository is known by a hash of its path.
function voyageKey(root: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < root.length; i++) h = Math.imul(h ^ root.charCodeAt(i), 0x01000193) >>> 0
  return `voyage:${repoName(root).slice(0, 60)}:${h.toString(36)}`
}

async function loadVoyage($: E, root: string): Promise<Voyage> {
  const v = (await $.store.get(voyageKey(root))) as Voyage | undefined
  return v && v.records ? v : { records: {} }
}

const saveVoyage = ($: E, root: string, v: Voyage) => $.store.set(voyageKey(root), v)

type Survey = {
  root: string
  base: string
  isRemote: boolean
  /** Every file that differs from the base: its blob hash, or "deleted". */
  files: Record<string, string>
  added: Record<string, string[]>
  lines: number
  branch: string
}

async function findBase($: E, root: string, voyage: Voyage) {
  for (const ref of ['@{u}', 'refs/remotes/origin/HEAD']) {
    const r = await git($, root, ['merge-base', 'HEAD', ref])
    if (r.exitCode === 0 && r.stdout.trim()) return { base: r.stdout.trim(), isRemote: true }
  }
  if (voyage.base) return { base: voyage.base, isRemote: false }
  const head = await git($, root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return { base: head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : EMPTY_TREE, isRemote: false }
}

function parseDiff(text: string) {
  const added: Record<string, string[]> = {}
  let file: string | undefined
  let inHunk = false
  let lines = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      file = undefined
      continue
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const p = line.slice(4)
        file = p === '/dev/null' ? undefined : p.replace(/^b\//, '')
      } else if (line.startsWith('@@')) inHunk = true
      continue
    }
    if (line.startsWith('@@')) continue
    if (line.startsWith('+')) {
      lines++
      if (file) (added[file] ??= []).push(line.slice(1))
    } else if (line.startsWith('-')) lines++
  }
  return { added, lines }
}

const TEXTY = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|html|css|scss|swift|kt|dart|json|md|mdx|strings|xml|ya?ml|txt|py|rb|go|rs|sql|toml)$/i

async function survey($: E, root: string): Promise<Survey> {
  const voyage = await loadVoyage($, root)
  const { base, isRemote } = await findBase($, root, voyage)
  if (!isRemote && voyage.base !== base) await saveVoyage($, root, { ...voyage, base })

  const status = await git($, root, ['diff', '--no-renames', '--name-status', '-z', base])
  const untracked = await git($, root, ['ls-files', '-o', '--exclude-standard', '-z'])
  const files: Record<string, string> = {}
  const parts = status.stdout.split('\0')
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const p = parts[i + 1]
    if (p) files[p] = parts[i] === 'D' ? 'deleted' : ''
  }
  const fresh = untracked.stdout.split('\0').filter(Boolean)
  for (const p of fresh) files[p] = ''

  const live = Object.keys(files).filter(p => files[p] === '')
  if (live.length > 0) {
    // -w keeps each version, so a later change can be compared with it.
    const h = await git($, root, ['hash-object', '-w', '--stdin-paths'], `${live.join('\n')}\n`)
    const hashes = h.stdout.trim().split('\n')
    live.forEach((p, i) => (files[p] = hashes[i] || 'unknown'))
  }

  const diff = await git($, root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', base])
  const { added, lines } = parseDiff(diff.stdout)
  let total = lines
  for (const p of fresh.filter(p => TEXTY.test(p)).slice(0, 200)) {
    try {
      const text = await $.fs.read(`${root}/${p}`)
      if (text.length > 200_000) continue
      added[p] = text.split('\n')
      total += added[p].length
    } catch {
      // Unreadable: it still counts as changed.
    }
  }
  const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'HEAD'
  return { root, base, isRemote, files, added, lines: total, branch }
}

// ---------- copy ----------

const NOT_COPY_KEY = /\b(className|class|style|styles|import|require|from|testID|key|href|src|url|path|d|id|type|kind|tool|variant|icon|color|component|name|event|mode|as|ref)\s*[=:(]\s*$/

function looksLikeCopy(s: string) {
  const t = s.trim()
  if (t.length < 2 || !/[A-Za-z]{2}/.test(t)) return false
  if (/[\\/]|https?:|\$\{|^[#.@]|^[a-z0-9_-]+(?:[ :][a-z0-9_:[\]/.-]+)*$/.test(t)) return false
  return (/^[A-Z]/.test(t) && /[a-z]/.test(t)) || (/\s/.test(t) && /[.!?…:]$/.test(t))
}

function isCopyLine(path: string, line: string) {
  if (/(?:^|\/)(?:locales?|i18n|translations|lang)\/|\.strings$/.test(path)) return /[A-Za-z]{2}/.test(line)
  if (/^\s*(?:import\b|export \{|\/\/|\/\*|\*)/.test(line)) return false
  for (const m of line.matchAll(/>([^<>{}]+)</g)) if (looksLikeCopy(m[1]!)) return true
  // A line of bare JSX text, between tags on other lines.
  if (/^\s*[A-Z][^<>{}=;()[\]"'`]*[a-z][^<>{}=;()[\]"'`]*$/.test(line) && /\s/.test(line.trim())) return true
  for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    const before = line.slice(0, m.index)
    if (NOT_COPY_KEY.test(before)) continue
    if (looksLikeCopy(m[2]!)) return true
  }
  return false
}

const stripCopy = (line: string) =>
  line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '$1$1')
    .replace(/>[^<>{}]*</g, '><')
    .trim()

// True when two versions of a file differ only inside strings and JSX text.
async function isCopyOnly($: E, root: string, a: string | undefined, b: string | undefined) {
  if (!a || !b || a === 'deleted' || b === 'deleted' || a === 'unknown' || b === 'unknown') return false
  const key = `${a}:${b}`
  const known = copyOnly.get(key)
  if (known !== undefined) return known
  const d = await git($, root, ['diff', '-U0', '--no-color', '--no-ext-diff', a, b])
  const minus: string[] = []
  const plus: string[] = []
  let inHunk = false
  for (const line of d.stdout.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) plus.push(stripCopy(line.slice(1)))
    else if (line.startsWith('-')) minus.push(stripCopy(line.slice(1)))
  }
  const result = d.exitCode === 0 && plus.length > 0 && JSON.stringify(minus.sort()) === JSON.stringify(plus.sort())
  copyOnly.set(key, result)
  return result
}

// ---------- verdicts ----------

type Verdict = { step: Step; status: StepStatus; note: string; why: string; changed: string[] }

const scopedFiles = (step: Step, sv: Survey) => Object.keys(sv.files).filter(p => inScope(step, p))

function snapshot(step: Step, sv: Survey) {
  const snap: Record<string, string> = {}
  for (const p of scopedFiles(step, sv)) snap[p] = sv.files[p]!
  return snap
}

function describeDone(step: Step, how: string, at: number, now: number) {
  return `${how}, ${ago(now - at)}.`
}

async function evaluate($: E, sv: Survey, steps: Step[], voyage: Voyage, now: number): Promise<Verdict[]> {
  const out: Verdict[] = []
  const running = pending.get(sv.root)
  for (const step of steps) {
    const scoped = scopedFiles(step, sv)
    const about = step.about ?? 'matching files'
    let applies = scoped.length > 0
    let why = `${plural(scoped.length, 'file')} changed`
    if (applies && step.copy) {
      const withCopy = scoped.filter(p => (sv.added[p] ?? []).some(line => isCopyLine(p, line)))
      applies = withCopy.length > 0
      why = `copy changed in ${fileList(withCopy)}`
    }
    if (applies && step.matches) {
      const re = new RegExp(step.matches)
      const hit = scoped.filter(p => (sv.added[p] ?? []).some(line => re.test(line)))
      applies = hit.length > 0
      why = `matching changes in ${fileList(hit)}`
    }
    if (!applies) {
      const note = step.copy ? 'Not needed: no copy changed.' : `Not needed: no ${about} changed.`
      out.push({ step, status: 'skipped', note, why: '', changed: [] })
      continue
    }
    if (running?.has(step.id)) {
      out.push({ step, status: 'running', note: `Running now: ${running.get(step.id)}.`, why, changed: [] })
      continue
    }
    const rec = voyage.records[step.id]
    if (!rec) {
      out.push({ step, status: 'needed', note: `Needed: ${why}.`, why, changed: [] })
      continue
    }
    const changed: string[] = []
    for (const p of scoped) {
      if (rec.snap[p] === sv.files[p]) continue
      if (step.ignoreCopyEdits && (await isCopyOnly($, sv.root, rec.snap[p], sv.files[p]))) continue
      changed.push(p)
    }
    if (changed.length > 0) {
      out.push({ step, status: 'stale', note: `Code changed since then: ${fileList(changed)}.`, why, changed })
    } else {
      out.push({ step, status: 'done', note: describeDone(step, rec.how, rec.at, now), why, changed: [] })
    }
  }
  return out
}

// ---------- the harbor (what the pane shows) ----------

async function finalizePending($: E, sv: Survey, steps: Step[], voyage: Voyage) {
  const running = pending.get(sv.root)
  if (!running || running.size === 0) return voyage
  const at = await $.clock.now()
  const records = { ...voyage.records }
  for (const [id, how] of running) {
    const step = steps.find(s => s.id === id)
    if (!step) continue
    records[id] = { at, snap: snapshot(step, sv), how }
    await log($, 'raise', `${step.name} done (${how}).`)
  }
  pending.delete(sv.root)
  const next = { ...voyage, records }
  await saveVoyage($, sv.root, next)
  return next
}

type Look = { sv: Survey; cfg: Config; verdicts: Verdict[]; voyage: Voyage }

async function look($: E, root: string): Promise<Look> {
  const cfg = await loadConfig($, root)
  const sv = await survey($, root)
  const voyage = await finalizePending($, sv, cfg.steps, await loadVoyage($, root))
  const verdicts = await evaluate($, sv, cfg.steps, voyage, await $.clock.now())
  await show($, sv, verdicts)
  return { sv, cfg, verdicts, voyage }
}

async function show($: E, sv: Survey, verdicts: Verdict[]) {
  const now = await $.clock.now()
  const prev = await read($, harborAtom)
  const sameRepo = prev.root === sv.root
  const steps: StepView[] = verdicts.map(v => {
    const old = sameRepo ? prev.steps.find(s => s.id === v.step.id) : undefined
    const changedAt = old && old.status !== v.status ? now : old?.changedAt
    return {
      id: v.step.id,
      name: v.step.name,
      flag: v.step.flag.toUpperCase().slice(0, 1),
      status: v.status,
      note: v.note,
      changedAt,
      isApproval: 'approval' in v.step.done,
    }
  })
  for (const s of steps) {
    const old = sameRepo ? prev.steps.find(o => o.id === s.id) : undefined
    if (old?.status === 'done' && s.status === 'stale') await log($, 'lower', `${s.name} is out of date. ${s.note}`)
  }
  const live = steps.filter(s => s.status !== 'skipped')
  const isClear = Object.keys(sv.files).length > 0 && live.every(s => s.status === 'done')
  if (isClear && !wasClear) clearedAt = now
  wasClear = isClear
  await update($, harborAtom, (h): Harbor => ({
    root: sv.root,
    name: repoName(sv.root),
    branch: sv.branch,
    steps,
    changed: Object.keys(sv.files).length,
    held: sameRepo ? h.held : undefined,
    shipped: sameRepo ? h.shipped : undefined,
  }))
}

async function refresh($: E, root?: string) {
  return serial(async () => {
    const r = root ?? currentRoot ?? (await repoRoot($, await $.session.cwd()))
    if (!r) {
      await update($, harborAtom, (): Harbor => ({ steps: [], changed: 0 }))
      return undefined
    }
    currentRoot = r
    return look($, r)
  })
}

async function record($: E, root: string, id: string, how: string) {
  return serial(async () => {
    const cfg = await loadConfig($, root)
    const step = cfg.steps.find(s => s.id === id)
    if (!step) return
    const sv = await survey($, root)
    const voyage = await loadVoyage($, root)
    voyage.records[id] = { at: await $.clock.now(), snap: snapshot(step, sv), how }
    await saveVoyage($, root, voyage)
    await log($, 'raise', `${step.name} done (${how}).`)
    currentRoot = root
    await look($, root)
  })
}

// ---------- reading commands ----------

type Segment = { text: string; dir: string }

function segments(command: string, cwd: string, homeDir: string): Segment[] {
  const out: Segment[] = []
  let dir = cwd
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const text = raw.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
    if (!text) continue
    const cd = text.match(/^(?:cd|pushd)\s+("[^"]+"|'[^']+'|\S+)\s*$/)
    if (cd) {
      dir = resolvePath(dir, unquote(cd[1]!), homeDir)
      continue
    }
    const c = text.match(/^git\s+-C\s+("[^"]+"|'[^']+'|\S+)\s/)
    out.push({ text, dir: c ? resolvePath(dir, unquote(c[1]!), homeDir) : dir })
  }
  return out
}

function actionOf(text: string): Action | undefined {
  const t = text.replace(/^git\s+(?:(?:-C|-c)\s+(?:"[^"]+"|'[^']+'|\S+)\s+)*/, 'git ')
  if (/^git commit\b/.test(t) && !/--dry-run/.test(t)) return 'commit'
  if (/^git push\b/.test(t) && !/--dry-run|--delete|\s-d\b|\s:\S/.test(t)) return 'push'
  if (/^gh pr create\b/.test(t)) return 'pr'
  return undefined
}

// ---------- review by risk ----------

function riskOf(sv: Survey, cfg: Config) {
  const risky = new RegExp(cfg.review.riskyPaths, 'i')
  const areas = [
    ...new Set(
      Object.keys(sv.files)
        .filter(p => risky.test(p))
        .map(p => (p.match(risky)?.[0] ?? '').replace(/^\W+|\W+$/g, '').toLowerCase()),
    ),
  ].filter(Boolean)
  const isLarge = sv.lines >= cfg.review.largeLines
  const route = isLarge || areas.length > 0 ? cfg.review.large : cfg.review.small
  const why = [
    isLarge ? `large change: ${sv.lines} lines` : `small change: ${sv.lines} lines`,
    areas.length > 0 ? `touches ${listWords(areas.slice(0, 3))}` : undefined,
  ]
    .filter(Boolean)
    .join(', ')
  return { route, why, isLarge: isLarge || areas.length > 0 }
}

const LEVEL = /\b(low|medium|high|xhigh|max|ultra)\b/

// ---------- the gate ----------

function instruction(v: Verdict, sv: Survey, cfg: Config) {
  const d = v.step.done
  if ('skill' in d) {
    const skill = skillsOf(d)[0]!
    if (v.step.id === 'review' || skillTail(skill) === 'code-review') {
      const risk = riskOf(sv, cfg)
      return `run the ${skill} skill with "${risk.route.effort}" (${risk.why})`
    }
    return `run the ${skill} skill${v.step.copy ? ' on the changed copy' : ''}`
  }
  if ('sent' in d) return 'send the user a screenshot or a video of the change with SendUserFile (one continuous video for a flow)'
  if ('command' in d) return `run \`${d.command}\` until it passes`
  return `ask the user to approve it: they press Approve in the Ship gate pane, or run /ship-gate approve ${v.step.id}`
}

function holdMessage(action: Action, sv: Survey, cfg: Config, missing: Verdict[], done: Verdict[]) {
  const lines = [
    `Ship gate held this ${ACTION_WORD[action]} in ${repoName(sv.root)}.`,
    done.length > 0 ? `Done for this code: ${listWords(done.map(v => v.step.name))}.` : 'Nothing is done for this code yet.',
    'Still needed:',
    ...missing.map(v => {
      const reason = v.status === 'stale' ? `code changed since then: ${fileList(v.changed, 3)}` : v.why
      return `- ${v.step.name} (${reason}): ${instruction(v, sv, cfg)}.`
    }),
    'Do only these steps, then run the command again. Steps already done stay done unless the code they covered changes.',
    "Don't work around the gate. If the user wants to skip a step, they can run /ship-gate pass.",
  ]
  return lines.join('\n')
}

async function check($: E, action: Action, root: string): Promise<string | undefined> {
  const { sv, cfg, verdicts } = await serial(() => look($, root))
  currentRoot = root
  const gated = verdicts.filter(v => v.step.gates.includes(action))
  const missing = gated.filter(v => v.status === 'needed' || v.status === 'stale')
  if (missing.length === 0) return undefined
  if (passOnce === root) {
    passOnce = undefined
    await log($, 'pass', `Let one ${ACTION_WORD[action]} through without ${listWords(missing.map(v => v.step.name))}.`)
    return undefined
  }
  const now = await $.clock.now()
  const names = missing.map(v => v.step.name)
  await update($, harborAtom, (h): Harbor => ({ ...h, held: { at: now, action, missing: names } }))
  await log($, 'hold', `Held a ${ACTION_WORD[action]}: ${listWords(names)} still needed.`)
  $.clock.after(4_000, () => void update($, tickAtom, t => t + 1))
  return holdMessage(action, sv, cfg, missing, gated.filter(v => v.status === 'done'))
}

async function lockfileDenial($: E, seg: Segment): Promise<string | undefined> {
  if (!/^(?:npx\s+|corepack\s+)?(?:yarn|pnpm)(?:\s|$)/.test(seg.text)) return undefined
  const root = (await repoRoot($, seg.dir)) ?? seg.dir
  for (const dir of [...new Set([seg.dir, root])]) {
    const has = async (f: string) => $.fs.exists(`${dir}/${f}`)
    if (!(await has('package-lock.json'))) continue
    if ((await has('yarn.lock')) || (await has('pnpm-lock.yaml'))) return undefined
    const tool = seg.text.match(/yarn|pnpm/)?.[0] ?? 'yarn'
    await log($, 'guard', `Blocked ${tool} in ${repoName(root)}: it uses npm.`)
    return `Ship gate: ${repoName(root)} uses npm (its lockfile is package-lock.json), so ${tool} is blocked here. Use npm instead: npm ci or npm install, npm run <script>, npm test, npx. A "packageManager" field or a script that mentions yarn doesn't change this.`
  }
  return undefined
}

async function routePr($: E, seg: Segment, root: string, cfg: Config): Promise<{ deny?: string; text?: string }> {
  if (!cfg.prBase) return {}
  const { branch, except } = cfg.prBase
  const head = seg.text.match(/--head[=\s]+("?)([^\s"]+)\1/)?.[2] ?? (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (new RegExp(except ?? '^hotfix').test(head)) return {}
  const exists = await git($, root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
  if (exists.exitCode !== 0) return {}
  const given = seg.text.match(/(?:--base|-B)[=\s]+("?)([^\s"]+)\1/)?.[2]
  if (given === undefined) {
    await log($, 'route', `Pull request from ${head} sent to ${branch}.`)
    return { text: seg.text.replace(/^gh pr create\b/, `gh pr create --base ${branch}`) }
  }
  if (given === branch) return {}
  return {
    deny: `Ship gate: pull requests in ${repoName(root)} go to ${branch}, not ${given}. Use --base ${branch}. Only branches matching ${except ?? '^hotfix'} (hotfixes) go elsewhere.`,
  }
}

// Proof: a screenshot or a video sent to the person counts for steps that ask for one.
async function proof($: E, files: string[] | string | undefined) {
  if (!(await read($, onAtom))) return
  const list = Array.isArray(files) ? files : files ? [files] : []
  const image = list.find(f => /\.(png|jpe?g|gif|webp|heic)$/i.test(f))
  const video = list.find(f => /\.(mov|mp4|m4v|webm)$/i.test(f))
  const root = currentRoot ?? (await repoRoot($, await $.session.cwd()))
  if (!root) return
  const cfg = await loadConfig($, root)
  for (const s of cfg.steps) {
    if (!('sent' in s.done)) continue
    const kind = s.done.sent
    const file = kind === 'image' ? image : kind === 'video' ? video : kind === 'any' ? list[0] : (image ?? video)
    if (file) await record($, root, s.id, `${video && file === video ? 'Video' : 'Screenshot'} sent: ${file.split('/').pop()}`)
  }
}

// ---------- drawing ----------

const FLAG_COLORS = { r: '#c8102e', b: '#0b3d91', y: '#ffcd00', k: '#151515', w: '#ffffff' }

// The International Code of Signals flag for a letter, in a w × h box.
function flagShapes(letter: string, w: number, h: number): string {
  const { r, b, y, k, w: wh } = FLAG_COLORS
  const rect = (x: number, yy: number, ww: number, hh: number, fill: string) =>
    `<rect x="${x.toFixed(2)}" y="${yy.toFixed(2)}" width="${ww.toFixed(2)}" height="${hh.toFixed(2)}" fill="${fill}"/>`
  const poly = (pts: number[][], fill: string) => `<polygon points="${pts.map(p => p.map(n => n.toFixed(2)).join(',')).join(' ')}" fill="${fill}"/>`
  const hStripes = (cols: string[], weights = cols.map(() => 1)) => {
    const total = weights.reduce((a, c) => a + c, 0)
    let at = 0
    return cols.map((c, i) => {
      const hh = (h * weights[i]!) / total
      const s = rect(0, at, w, hh, c)
      at += hh
      return s
    }).join('')
  }
  const vStripes = (cols: string[]) => cols.map((c, i) => rect((w * i) / cols.length, 0, w / cols.length, h, c)).join('')
  const quarters = (a: string, c: string) => rect(0, 0, w / 2, h / 2, a) + rect(w / 2, 0, w / 2, h / 2, c) + rect(0, h / 2, w / 2, h / 2, c) + rect(w / 2, h / 2, w / 2, h / 2, a)
  const saltire = (bg: string, fg: string) =>
    rect(0, 0, w, h, bg) + `<path d="M0 0L${w} ${h}M${w} 0L0 ${h}" stroke="${fg}" stroke-width="${(h * 0.2).toFixed(2)}"/>`
  const cross = (bg: string, fg: string) => rect(0, 0, w, h, bg) + rect(w * 0.4, 0, w * 0.2, h, fg) + rect(0, h * 0.37, w, h * 0.26, fg)
  const square = (bg: string, fg: string) => rect(0, 0, w, h, bg) + rect(w * 0.3, h * 0.3, w * 0.4, h * 0.4, fg)
  const tail = (fill: string, from = 0) => poly([[from, 0], [w, 0], [w * 0.72, h / 2], [w, h], [from, h]], fill)
  switch (letter) {
    case 'A': return rect(0, 0, w / 2, h, wh) + tail(b, w / 2)
    case 'B': return tail(r)
    case 'C': return hStripes([b, wh, r, wh, b])
    case 'D': return hStripes([y, b, y], [1, 2, 1])
    case 'E': return hStripes([b, r])
    case 'F': return rect(0, 0, w, h, wh) + poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]], r)
    case 'G': return vStripes([y, b, y, b, y, b])
    case 'H': return rect(0, 0, w / 2, h, wh) + rect(w / 2, 0, w / 2, h, r)
    case 'I': return rect(0, 0, w, h, y) + `<circle cx="${w / 2}" cy="${h / 2}" r="${(h * 0.28).toFixed(2)}" fill="${k}"/>`
    case 'J': return hStripes([b, wh, b])
    case 'K': return rect(0, 0, w / 2, h, y) + rect(w / 2, 0, w / 2, h, b)
    case 'L': return quarters(y, k)
    case 'M': return saltire(b, wh)
    case 'N': {
      let s = ''
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s += rect((w * i) / 4, (h * j) / 4, w / 4, h / 4, (i + j) % 2 ? wh : b)
      return s
    }
    case 'O': return rect(0, 0, w, h, y) + poly([[0, 0], [w, 0], [w, h]], r)
    case 'P': return square(b, wh)
    case 'Q': return rect(0, 0, w, h, y)
    case 'R': return cross(r, y)
    case 'S': return square(wh, b)
    case 'T': return vStripes([r, wh, b])
    case 'U': return quarters(r, wh)
    case 'V': return saltire(wh, r)
    case 'W': return rect(0, 0, w, h, b) + rect(w * 0.17, h * 0.17, w * 0.66, h * 0.66, wh) + rect(w * 0.34, h * 0.34, w * 0.32, h * 0.32, r)
    case 'X': return cross(wh, b)
    case 'Y': {
      let s = rect(0, 0, w, h, y)
      for (let i = -2; i < 6; i += 2) s += poly([[(w * i) / 5, h], [(w * (i + 1)) / 5, h], [(w * (i + 2)) / 5, 0], [(w * (i + 1)) / 5, 0]], r)
      return s
    }
    case 'Z': return poly([[0, 0], [w, 0], [w / 2, h / 2]], y) + poly([[w, 0], [w, h], [w / 2, h / 2]], b) + poly([[0, h], [w, h], [w / 2, h / 2]], r) + poly([[0, 0], [0, h], [w / 2, h / 2]], k)
    default: return rect(0, 0, w, h, y)
  }
}

function flagSvg(letter: string, w: number, h: number, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${w + 2} ${h + 2}" width="${w + 2}" height="${h + 2}">
    <clipPath id="c"><rect width="${w}" height="${h}" rx="1"/></clipPath>
    <g clip-path="url(#c)">${flagShapes(letter, w, h)}</g>
    <rect width="${w}" height="${h}" rx="1" fill="none" stroke="rgba(0,0,0,.25)" stroke-width=".6"/>${extra}</svg>`
}

const PALETTE = `
  :root { --sky:#e6eef5; --sky2:#cfdeea; --sea:#2c6a99; --sea2:#3e83b6; --foam:#f3f8fc; --hull:#1f2d3d; --boot:#c8102e; --deck:#e7d8bb; --cabin:#fbfaf6; --stone:#b8b0a1; --stone2:#9c937f; --gate:#3a4a5c; --ink:#1f2d3d; --muted:#647487; --sun:#f2b84b; --star:0; --window:#1f2d3d; --glow:0; --ok:#1d9a68; --wait:#e0a020; --held:#d7263d; }
  @media (prefers-color-scheme: dark) {
    :root { --sky:#0c1825; --sky2:#132538; --sea:#0d3657; --sea2:#174d77; --foam:#9cc2df; --hull:#3a5068; --boot:#d23a4f; --deck:#a5937a; --cabin:#d8dde3; --stone:#4b5058; --stone2:#3b4048; --gate:#8193a6; --ink:#e4ecf3; --muted:#8fa1b4; --sun:#e9e3cf; --star:.85; --window:#ffd36b; --glow:.55; --ok:#34c48a; --wait:#f0b43c; --held:#ff5468; }
  }
  text { font-family: "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", ui-sans-serif, sans-serif; fill: var(--ink); }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .stars { opacity: var(--star); }
  .glow { opacity: var(--glow); }
`

type Motion = { now: number; isClear: boolean; clearedAt?: number }

const loopBegin = (now: number, dur: number) => `-${((now / 1000) % dur).toFixed(2)}s`
const sinceBegin = (now: number, at: number) => `-${Math.max(0, (now - at) / 1000).toFixed(2)}s`
const EASE = 'calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"'
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

// Flag slots along the dressing lines, masthead to bow, then masthead to stern.
const MAST = { x: 182, top: 22, deck: 100 }
const BOW = { x: 238, y: 101 }
const STERN = { x: 84, y: 100 }
function slot(i: number) {
  if (i < 4) {
    const t = 0.13 + i * 0.215
    return { x: MAST.x + (BOW.x - MAST.x) * t, y: MAST.top + (BOW.y - MAST.top) * t }
  }
  const t = 0.2 + (i - 4) * 0.2
  return { x: MAST.x + (STERN.x - MAST.x) * t, y: MAST.top + (STERN.y - MAST.top) * t }
}

function hangingFlag(s: StepView, i: number, now: number) {
  const p = slot(i)
  const W = 19
  const H = 13
  const x = p.x - W / 2
  const y = p.y + 1.5
  const wave = `<animateTransform attributeName="transform" type="skewY" values="0;6;0;-5;0" dur="${(2.2 + (i % 3) * 0.35).toFixed(2)}s" begin="${loopBegin(now + i * 410, 2.2 + (i % 3) * 0.35)}" repeatCount="indefinite"/>`
  const tip = `<title>${esc(`${s.name}: ${s.note}`)}</title>`
  const body = `<g clip-path="url(#flagclip)">${flagShapes(s.flag, W, H)}</g><rect width="${W}" height="${H}" fill="none" stroke="rgba(0,0,0,.22)" stroke-width=".5"/>`
  const fresh = s.changedAt !== undefined && now - s.changedAt < 1_600
  // The deck under this slot, where a flag starts its climb or ends its drop.
  const dropY = BOW.y - y - 8

  if (s.status === 'done') {
    const hoist = fresh
      ? `<animateTransform attributeName="transform" type="translate" from="0 ${dropY.toFixed(1)}" to="0 0" dur="1.1s" begin="${sinceBegin(now, s.changedAt!)}" fill="freeze" ${EASE}/>`
      : ''
    return `<g>${tip}<g>${hoist}<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><g>${wave}${body}</g></g></g></g>`
  }
  if (s.status === 'running') {
    return `<g>${tip}<g transform="translate(${x.toFixed(1)} ${(y + dropY * 0.45).toFixed(1)})"><g>${wave}${body}</g>
      <animate attributeName="opacity" values="1;.45;1" dur="1.2s" begin="${loopBegin(now, 1.2)}" repeatCount="indefinite"/></g></g>`
  }
  const ghost = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${W}" height="${H}" rx="1" fill="none" stroke="var(--muted)" stroke-width=".9" stroke-dasharray="2 2" opacity=".8"/>`
  if (s.status === 'stale') {
    const drop = fresh
      ? `<animateTransform attributeName="transform" type="translate" from="0 ${(-dropY).toFixed(1)}" to="0 0" dur=".9s" begin="${sinceBegin(now, s.changedAt!)}" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".5 0 .9 .6"/>`
      : ''
    return `<g>${tip}${ghost}<g>${drop}<g transform="translate(${x.toFixed(1)} ${(y + dropY).toFixed(1)}) rotate(-8)" opacity=".55">${body}</g>
      <circle cx="${(x + W + 2).toFixed(1)}" cy="${(y + dropY - 1).toFixed(1)}" r="2.2" style="fill:var(--wait)"/></g></g>`
  }
  return `<g>${tip}${ghost}</g>`
}

function harborSvg(h: Harbor, isOn: boolean, motion: Motion) {
  const { now } = motion
  const live = h.steps.filter(s => s.status !== 'skipped')
  const toGo = live.filter(s => s.status !== 'done').length
  const held = h.held && now - h.held.at < 20_000 && toGo > 0 ? h.held : undefined
  const sail = h.shipped && now - h.shipped.at < 8_400 ? h.shipped : undefined
  const isOpen = motion.isClear || sail !== undefined || !isOn

  const sky = `<rect width="400" height="122" style="fill:var(--sky)"/>
    <path d="M250 122 Q300 96 350 108 T400 104 V122 Z" style="fill:var(--sky2)"/>
    <circle cx="252" cy="26" r="10" style="fill:var(--sun)"/>
    <g class="stars">${[[40, 20], [92, 12], [128, 34], [232, 18], [300, 40], [388, 58], [262, 62]]
      .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 2 ? 0.9 : 1.3}" style="fill:var(--foam)"><animate attributeName="opacity" values="1;.3;1" dur="${3 + i * 0.7}s" begin="${loopBegin(now, 3 + i * 0.7)}" repeatCount="indefinite"/></circle>`)
      .join('')}</g>`

  const gull = `<g><animateTransform attributeName="transform" type="translate" values="-30 44;430 22" dur="26s" begin="${loopBegin(now, 26)}" repeatCount="indefinite"/>
    <path d="M0 0 q4 -4 8 0 q4 -4 8 0" fill="none" style="stroke:var(--ink)" stroke-width="1.3" stroke-linecap="round">
      <animateTransform attributeName="transform" type="scale" values="1 1;1 .35;1 1" dur=".7s" begin="${loopBegin(now, 0.7)}" repeatCount="indefinite"/></path></g>`

  const wavePath = (y: number, amp: number) => {
    let d = `M-40 ${y}`
    for (let x = -40; x < 440; x += 20) d += ` q5 ${-amp} 10 0 t10 0`
    return `${d} V160 H-40 Z`
  }
  const shimmer = [0, 1, 2]
    .map(i => `<rect x="${244 - i * 4}" y="${126 + i * 7}" width="${16 + i * 8}" height="1.6" rx=".8" style="fill:var(--sun)" opacity=".5"><animate attributeName="width" values="${16 + i * 8};${10 + i * 6};${16 + i * 8}" dur="${2.6 + i * 0.5}s" begin="${loopBegin(now, 2.6 + i * 0.5)}" repeatCount="indefinite"/></rect>`)
    .join('')
  const sea = `<rect y="120" width="400" height="40" style="fill:var(--sea)"/>${shimmer}
    <g><animateTransform attributeName="transform" type="translate" from="0 0" to="-20 0" dur="3.2s" begin="${loopBegin(now, 3.2)}" repeatCount="indefinite"/>
      <path d="${wavePath(121, 2.4)}" style="fill:var(--sea2)" opacity=".75"/></g>
    <g><animateTransform attributeName="transform" type="translate" from="-20 0" to="0 0" dur="4.6s" begin="${loopBegin(now, 4.6)}" repeatCount="indefinite"/>
      <path d="${wavePath(132, 1.6)}" fill="none" style="stroke:var(--foam)" stroke-width=".8" opacity=".45"/></g>`

  const quay = `<rect x="0" y="98" width="30" height="62" style="fill:var(--stone)"/>
    ${[104, 116, 128, 140, 152].map((y, i) => `<line x1="0" y1="${y}" x2="30" y2="${y}" style="stroke:var(--stone2)" stroke-width=".8"/><line x1="${i % 2 ? 10 : 20}" y1="${y - 12}" x2="${i % 2 ? 10 : 20}" y2="${y}" style="stroke:var(--stone2)" stroke-width=".8"/>`).join('')}
    <rect x="18" y="90" width="7" height="8" rx="2" style="fill:var(--gate)"/>`

  // The gate: two posts and a pair of doors, a lamp on top and a sign above.
  const doorW = isOpen ? 3.5 : 18
  const fromW = isOpen ? 18 : 3.5
  const swing =
    motion.clearedAt !== undefined && now - motion.clearedAt < 1_400
      ? `<animate attributeName="width" from="${fromW}" to="${doorW}" dur="1s" begin="${sinceBegin(now, motion.clearedAt)}" fill="freeze" ${EASE}/>`
      : ''
  const shake =
    held && now - held.at < 2_400
      ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 0;2 0;-2 0;1 0;0 0" keyTimes="0;.3;.4;.5;.6;1" dur="2s" begin="${sinceBegin(now, held.at)}" fill="freeze"/>`
      : ''
  const lampColor = !isOn ? 'var(--muted)' : held ? 'var(--held)' : motion.isClear ? 'var(--ok)' : h.changed > 0 ? 'var(--wait)' : 'var(--muted)'
  const blink = held
    ? `<animate attributeName="opacity" values="1;.25;1" dur=".8s" begin="${loopBegin(now, 0.8)}" repeatCount="indefinite"/>`
    : ''
  const signText = !isOn ? 'GATE OFF' : sail ? 'BON VOYAGE' : held ? 'HELD' : h.changed === 0 ? 'MOORED' : motion.isClear ? 'CLEAR' : `${toGo} TO GO`
  const signW = Math.max(40, signText.length * 6.4 + 12)
  const gate = `<g>
    <rect x="292" y="70" width="8" height="90" style="fill:var(--stone2)"/>
    <rect x="340" y="70" width="8" height="90" style="fill:var(--stone2)"/>
    <g>${shake}
      <rect x="300" y="88" width="${doorW}" height="50" style="fill:var(--gate)">${swing}</rect>
      <rect x="${340 - doorW}" y="88" width="${doorW}" height="50" style="fill:var(--gate)">${swing}${
        swing ? `<animate attributeName="x" from="${340 - fromW}" to="${340 - doorW}" dur="1s" begin="${sinceBegin(now, motion.clearedAt!)}" fill="freeze" ${EASE}/>` : ''
      }</rect>
      ${isOpen ? '' : `<path d="M302 92 L316 134 M316 92 L302 134 M324 92 L338 134 M338 92 L324 134" style="stroke:var(--sky)" stroke-width="1" opacity=".35"/>`}
    </g>
    <circle cx="296" cy="62" r="9" style="fill:${lampColor}" opacity=".22">${blink}</circle>
    <circle cx="296" cy="62" r="4.2" style="fill:${lampColor}">${blink}</circle>
    <rect x="294.5" y="66" width="3" height="4" style="fill:var(--stone2)"/>
    <g transform="translate(${(320 - signW / 2 + 6).toFixed(1)} 38)">
      <rect width="${signW.toFixed(1)}" height="14" rx="2" style="fill:var(--cabin);stroke:${lampColor}" stroke-width="1.2"/>
      <text x="${(signW / 2).toFixed(1)}" y="10.3" text-anchor="middle" font-size="9.5" font-weight="700" letter-spacing="1.2" style="fill:${lampColor}">${signText}</text>
    </g>
  </g>`

  // The ship: hull, cabin, mast and the flags dressed along its lines.
  const flags = live.slice(0, 7).map((s, i) => hangingFlag(s, i, now)).join('')
  const allUp = live.length > 0 && live.every(s => s.status === 'done') && h.changed > 0
  const peter = allUp
    ? `<g transform="translate(${MAST.x + 1} ${MAST.top - 6})"><g>
        ${motion.clearedAt !== undefined && now - motion.clearedAt < 1_400 ? `<animateTransform attributeName="transform" type="translate" from="0 60" to="0 0" dur="1.1s" begin="${sinceBegin(now, motion.clearedAt)}" fill="freeze" ${EASE}/>` : ''}
        <g><animateTransform attributeName="transform" type="skewY" values="0;-7;0;5;0" dur="1.8s" begin="${loopBegin(now, 1.8)}" repeatCount="indefinite"/>
          ${flagShapes('P', 20, 13)}<title>Blue Peter: every step is done, ready to sail.</title></g></g></g>`
    : ''
  const ship = `<g>
    <path d="M${STERN.x - 8} 102 H${BOW.x + 4} L${BOW.x - 10} 130 H${STERN.x + 6} Z" style="fill:var(--hull)"/>
    <path d="M${STERN.x + 3} 124 H${BOW.x - 7.5} L${BOW.x - 10} 130 H${STERN.x + 6} Z" style="fill:var(--boot)"/>
    <rect x="${STERN.x - 6}" y="98" width="${BOW.x - STERN.x + 8}" height="4.5" rx="1" style="fill:var(--deck)"/>
    <rect x="100" y="78" width="54" height="20" rx="2.5" style="fill:var(--cabin)"/>
    <rect x="108" y="66" width="13" height="12" style="fill:var(--boot)"/><rect x="108" y="70" width="13" height="3" style="fill:var(--cabin)"/>
    ${[112, 125, 138].map(x => `<circle cx="${x}" cy="88" r="5" class="glow" style="fill:var(--window)" opacity=".3"/><circle cx="${x}" cy="88" r="2.4" style="fill:var(--window)"/>`).join('')}
    <circle cx="148" cy="86" r="3.4" fill="none" style="stroke:var(--boot)" stroke-width="1.8" stroke-dasharray="2.7 2.6"/>
    <path d="M${STERN.x - 4} 92 H100 M154 92 H${BOW.x - 2}" style="stroke:var(--ink)" stroke-width=".7" opacity=".45"/>
    ${[...Array.from({ length: 3 }, (_, i) => STERN.x - 2 + i * 8), ...Array.from({ length: 10 }, (_, i) => 158 + i * 8)].map(x => `<line x1="${x}" y1="92" x2="${x}" y2="98" style="stroke:var(--ink)" stroke-width=".6" opacity=".45"/>`).join('')}
    <line x1="${MAST.x}" y1="${MAST.deck}" x2="${MAST.x}" y2="${MAST.top - 8}" style="stroke:var(--hull)" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M${STERN.x} ${STERN.y} L${MAST.x} ${MAST.top} L${BOW.x} ${BOW.y}" fill="none" style="stroke:var(--ink)" stroke-width=".7" opacity=".55"/>
    ${flags}${peter}
  </g>`

  const bob = `<animateTransform attributeName="transform" type="translate" values="0 0;0 1.6;0 0" dur="3.4s" begin="${loopBegin(now, 3.4)}" repeatCount="indefinite" additive="sum"/>
    <animateTransform attributeName="transform" type="rotate" values="-.7 160 110;.7 160 110;-.7 160 110" dur="5.2s" begin="${loopBegin(now, 5.2)}" repeatCount="indefinite" additive="sum"/>`
  // Held: the ship noses up to the closed gate and backs off. Shipped: it sails
  // out through the open gate, and a fresh voyage glides back to the quay.
  const nudge =
    held && now - held.at < 2_400
      ? `<animateTransform attributeName="transform" type="translate" values="0 0;44 0;38 0;0 0" keyTimes="0;.35;.45;1" dur="2.2s" begin="${sinceBegin(now, held.at)}" fill="freeze" additive="sum"/>`
      : ''
  const voyage = sail
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;330 0;-200 0;0 0" keyTimes="0;.58;.581;1" calcMode="spline" keySplines=".5 0 .9 .7;0 0 1 1;.2 .8 .3 1" dur="8.4s" begin="${sinceBegin(now, sail.at)}" fill="freeze" additive="sum"/>`
    : ''
  const wake = sail
    ? `<g opacity="0"><animate attributeName="opacity" values="0;.8;.8;0" keyTimes="0;.1;.5;.58" dur="8.4s" begin="${sinceBegin(now, sail.at)}" fill="freeze"/>
        ${[0, 1, 2].map(i => `<path d="M${STERN.x - 14 - i * 16} ${118 + i * 3} h-12" style="stroke:var(--foam)" stroke-width="1.4" stroke-linecap="round"/>`).join('')}</g>`
    : ''
  const rope = `<path d="M21 92 Q48 108 ${STERN.x - 4} 104" fill="none" style="stroke:var(--deck)" stroke-width="1.1">${
    sail ? `<animate attributeName="opacity" values="1;0;0;1" keyTimes="0;.04;.97;1" dur="8.4s" begin="${sinceBegin(now, sail.at)}" fill="freeze"/>` : ''
  }</path>`

  const label = h.name
    ? `<text x="10" y="17" font-size="10" font-weight="700" letter-spacing="1.6">${esc(h.name.toUpperCase())}</text>
       <text x="10" y="29" font-size="9" class="mono" style="fill:var(--muted)">${esc(h.branch ?? '')}</text>`
    : `<text x="10" y="17" font-size="10" font-weight="700" letter-spacing="1.6" style="fill:var(--muted)">NO REPOSITORY</text>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 160" width="100%">
  <style>${PALETTE}</style>
  <defs><clipPath id="flagclip"><rect width="19" height="13" rx=".8"/></clipPath></defs>
  ${sky}${gull}${label}
  ${sea}
  ${quay}${rope}
  <g>${bob}${nudge}${voyage}${wake}${ship}</g>
  ${gate}
</svg>`
}

const STATUS_WORD: Record<StepStatus, { text: string; color: string }> = {
  done: { text: 'Done', color: 'success' },
  stale: { text: 'Out of date', color: 'warning' },
  needed: { text: 'Needed', color: 'error' },
  running: { text: 'Running', color: 'claude' },
  skipped: { text: 'Not needed', color: 'subtle' },
}

const LOG_MARK: Record<LogEntry['kind'], { mark: string; color: string }> = {
  raise: { mark: '▲', color: 'success' },
  lower: { mark: '▼', color: 'warning' },
  hold: { mark: '■', color: 'error' },
  sail: { mark: '➜', color: 'success' },
  route: { mark: '↳', color: 'suggestion' },
  guard: { mark: '✕', color: 'warning' },
  pass: { mark: '○', color: 'subtle' },
}

// ---------- register ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('enabled')
    if (typeof saved === 'boolean') await update($, onAtom, () => saved)
    await $.command.register({
      name: 'ship-gate',
      description: 'Open the Ship gate pane, or: status, on, off, pass, approve <step>, add <command|skill|approval> <value>',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    const started = await next(e)
    void refresh($).catch(() => undefined)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      reviewRoute = undefined
      void refresh($).catch(() => undefined)
    }
    return done
  })

  // Which repository the pane follows: the one Claude last edited in.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    const dir = e.file_path.replace(/\/[^/]*$/, '') || '/'
    const root = await repoRoot($, dir).catch(() => undefined)
    if (root) currentRoot = root
    return ran
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    const dir = e.file_path.replace(/\/[^/]*$/, '') || '/'
    const root = await repoRoot($, dir).catch(() => undefined)
    if (root) currentRoot = root
    return ran
  })

  // A skill run counts for the step that names it, typed or called by Claude.
  on('skill.prompt', async ($, e, next) => {
    const out = await next(e)
    if (!(await read($, onAtom))) return out
    const root = currentRoot ?? (await repoRoot($, await $.session.cwd()))
    if (!root) return out
    const cfg = await loadConfig($, root)
    const hits = cfg.steps.filter(s => skillsOf(s.done).some(want => skillMatches(want, e.skill)))
    if (hits.length === 0) return out
    const level = e.text.match(LEVEL)?.[1]
    const map = pending.get(root) ?? new Map<string, string>()
    for (const s of hits) map.set(s.id, `/${e.skill}${level && skillTail(e.skill) === 'code-review' ? ` ${level}` : ''}`)
    pending.set(root, map)
    currentRoot = root
    void refresh($, root).catch(() => undefined)
    return out
  }).catch(($, e, next) => next(e))

  // Claude's own code review: the level and reviewer model follow the risk.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (!(await read($, onAtom)) || e.agentId !== undefined || skillTail(e.skill) !== 'code-review') return next(e)
    const root = currentRoot ?? (await repoRoot($, await $.session.cwd()))
    if (!root) return next(e)
    const cfg = await loadConfig($, root)
    const sv = await survey($, root)
    const risk = riskOf(sv, cfg)
    const args = e.args ?? ''
    if (LEVEL.test(args)) return next(e)
    reviewRoute = { model: risk.route.model, why: risk.why, isLogged: false }
    await log($, 'route', `Code review at ${risk.route.effort} effort (${risk.why}).`)
    return next({ ...e, args: `${risk.route.effort}${args ? ` ${args}` : ''}` })
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (!reviewRoute || e.fork || e.isTeammate || e.resume) return next(e)
    if (!reviewRoute.isLogged) {
      reviewRoute.isLogged = true
      await log($, 'route', `Review agents run on ${reviewRoute.model.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/^\w/, c => c.toUpperCase())}.`)
    }
    return next({ ...e, model: reviewRoute.model })
  }).catch(($, e, next) => next(e))

  // Proof: a screenshot or a video sent to the person.
  on('tool.call', { tool: 'SendUserFile' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await proof($, e.files)
    return ran
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await read($, onAtom))) return next(e)
    const homeDir = await home($)
    const cwd = await $.session.cwd()
    const segs = segments(e.command, cwd, homeDir)
    let command = e.command

    for (const seg of segs) {
      const lock = (await loadConfig($, (await repoRoot($, seg.dir)) ?? undefined)).lockfileGuard ? await lockfileDenial($, seg) : undefined
      if (lock) return { deny: lock }
    }

    const acted: { action: Action; root: string; seg: Segment }[] = []
    for (const seg of segs) {
      const action = actionOf(seg.text)
      if (!action) continue
      const root = await repoRoot($, seg.dir)
      if (!root) continue
      if (action === 'pr') {
        const routed = await routePr($, seg, root, await loadConfig($, root))
        if (routed.deny) return { deny: routed.deny }
        if (routed.text) command = command.replace(seg.text, routed.text)
      }
      let held: string | undefined
      try {
        held = await check($, action, root)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        await log($, 'hold', `Couldn't check a ${ACTION_WORD[action]}: ${why}`)
        return {
          deny: `Ship gate couldn't check this ${ACTION_WORD[action]} (${why}), so it held it. Tell the user; they can run /ship-gate off to ${ACTION_WORD[action] === 'commit' ? 'commit' : 'go ahead'} without the gate.`,
        }
      }
      if (held) return { deny: held }
      acted.push({ action, root, seg })
    }

    const ran = await next(command === e.command ? e : { ...e, command })
    if (ran.deny !== undefined) return ran

    // A command a step names ("npm test") counts once it passes.
    if (!ran.isError) {
      const out = ran.result as { interrupted?: boolean } | undefined
      if (!out?.interrupted) {
        for (const seg of segs) {
          const root = await repoRoot($, seg.dir)
          if (!root) continue
          const cfg = await loadConfig($, root)
          for (const s of cfg.steps) {
            if ('command' in s.done && seg.text.includes(s.done.command)) await record($, root, s.id, `\`${s.done.command}\` passed`)
          }
        }
      }
    }

    if (!ran.isError) {
      for (const { action, root } of acted) {
        if (action === 'commit') {
          const v = await loadVoyage($, root)
          // Without a remote, the next voyage starts from this commit.
          const remote = await git($, root, ['merge-base', 'HEAD', '@{u}'])
          const originHead = await git($, root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD'])
          if (remote.exitCode !== 0 && originHead.exitCode !== 0) {
            const head = (await git($, root, ['rev-parse', 'HEAD'])).stdout.trim()
            if (head) await saveVoyage($, root, { ...v, base: head })
          }
        }
        if (action === 'push' || action === 'pr') {
          const now = await $.clock.now()
          const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
          const url = action === 'pr' ? (ran.result as { stdout?: string } | undefined)?.stdout?.match(/https:\/\/\S+/)?.[0] : undefined
          const text = action === 'push' ? `${branch} pushed` : `pull request opened${url ? ` at ${url}` : ''}`
          await update($, harborAtom, (h): Harbor => ({ ...h, held: undefined, shipped: { at: now, text } }))
          await log($, 'sail', `${repoName(root)}: ${text}.`)
          $.clock.after(9_000, () => void update($, tickAtom, t => t + 1))
        }
      }
      if (acted.length > 0) void refresh($, acted[acted.length - 1]!.root).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'ship-gate' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const [word = '', ...rest] = args.split(/\s+/)
    const verb = word.toLowerCase()
    const root = currentRoot ?? (await repoRoot($, await $.session.cwd()))

    if (verb === 'on' || verb === 'off') {
      await update($, onAtom, () => verb === 'on')
      await $.store.set('enabled', verb === 'on')
      return { text: verb === 'on' ? 'Ship gate is on.' : 'Ship gate is off. Nothing is checked or blocked.' }
    }
    if (verb === 'pass') {
      if (!root) return { text: 'Not in a git repository.' }
      passOnce = root
      await log($, 'pass', 'You let the next commit, push or pull request through.')
      return { text: `The next commit, push or pull request in ${repoName(root)} goes through without the missing steps.` }
    }
    if (verb === 'approve') {
      if (!root) return { text: 'Not in a git repository.' }
      const cfg = await loadConfig($, root)
      const id = rest[0]
      const step = cfg.steps.find(s => s.id === id || s.name.toLowerCase() === rest.join(' ').toLowerCase())
      if (!step || !('approval' in step.done)) {
        const names = cfg.steps.filter(s => 'approval' in s.done).map(s => s.id)
        return { text: names.length ? `Approve one of: ${names.join(', ')}.` : 'No step here needs your approval.' }
      }
      await record($, root, step.id, 'Approved by you')
      return { text: `${step.name}: approved for the current code.` }
    }
    if (verb === 'add') {
      const kind = (rest[0] ?? '').toLowerCase()
      const value = rest.slice(1).join(' ').replace(/^["']|["']$/g, '')
      if (!['command', 'skill', 'approval'].includes(kind) || !value) {
        return {
          text: [
            'Add a step:',
            '/ship-gate add command npm test   (the command has to pass)',
            '/ship-gate add skill security-review   (the skill has to run)',
            '/ship-gate add approval Design sign-off   (you approve it)',
            'Or ask Claude to edit the steps file.',
          ].join('\n'),
        }
      }
      const file = root ? projectFile(root) : await globalFile($)
      const current = (await readJson($, file)) ?? {}
      const cfg = await loadConfig($, root)
      const name = kind === 'command' ? `${value} passes` : kind === 'skill' ? `${value} ran` : value
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
      const used = new Set(cfg.steps.map(s => s.flag))
      const flag = [...`${name.replace(/[^A-Za-z]/g, '').toUpperCase()}ABCDEFGHIJKLMNOPQRSTUVWXYZ`].find(c => !used.has(c) && c !== 'P') ?? 'Q'
      const done: Done = kind === 'command' ? { command: value } : kind === 'skill' ? { skill: value } : { approval: true }
      const step: StepConfig = { id, name, flag, gates: ACTIONS, paths: ['**'], done }
      await $.fs.write(file, `${JSON.stringify({ ...current, steps: [...(current.steps ?? []).filter(s => s.id !== id), step] }, null, 2)}\n`)
      void refresh($).catch(() => undefined)
      return { text: `Added “${name}” (flag ${flag}) to ${file}. Commits, pushes and pull requests wait for it.` }
    }
    if (verb === 'status') {
      if (!root) return { text: 'Not in a git repository.' }
      const result = await refresh($, root)
      if (!result) return { text: 'Not in a git repository.' }
      return {
        text: [
          `${repoName(root)} · ${result.sv.branch} · ${plural(Object.keys(result.sv.files).length, 'file')} changed`,
          ...result.verdicts.map(v => `[${v.step.flag}] ${v.step.name}: ${v.note}`),
        ].join('\n'),
      }
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: 'Ship gate pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const harbor = await read($, harborAtom)
    const log_ = await read($, logAtom)
    const isOn = await read($, onAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    const isPicture = 'Svg' in ui && e.surface !== 'terminal'

    const live = harbor.steps.filter(s => s.status !== 'skipped')
    const left = live.filter(s => s.status !== 'done')
    const isClear = harbor.changed > 0 && left.length === 0
    const held = harbor.held && now - harbor.held.at < 10 * 60_000 && left.length > 0 ? harbor.held : undefined
    const shipped = harbor.shipped && now - harbor.shipped.at < 2 * 60_000 ? harbor.shipped : undefined

    const [headline, color] = !isOn
      ? ['Ship gate is off. Nothing is checked or blocked.', 'subtle']
      : !harbor.root
        ? ['Not in a git repository.', 'subtle']
        : shipped
          ? [`Shipped: ${shipped.text}.`, 'success']
          : held
            ? [`Held at the gate: ${listWords(left.map(s => s.name))} still needed.`, 'error']
            : harbor.changed === 0
              ? ['No changes yet. Commits, pushes and pull requests wait here until every step is done.', 'subtle']
              : isClear
                ? ['Clear to ship. Every step is done for this code.', 'success']
                : [`${plural(left.length, 'step')} before shipping: ${listWords(left.map(s => s.name))}.`, 'warning']

    const alt = [headline, ...live.map(s => `${s.name}: ${STATUS_WORD[s.status].text}`)].join(' ')

    const chip = (s: StepView) =>
      isPicture && 'Svg' in ui ? (
        <ui.Svg source={flagSvg(s.flag, 21, 14)} alt={`Flag ${s.flag}`} width={23} height={16} />
      ) : (
        <Text backgroundColor={s.flag === 'R' || s.flag === 'B' ? FLAG_COLORS.r : s.flag === 'Q' || s.flag === 'I' ? FLAG_COLORS.y : FLAG_COLORS.b} color="#ffffff" weight="bold">
          {` ${s.flag} `}
        </Text>
      )

    const row = (s: StepView) => (
      <Box key={`step-${s.id}`} flexDirection="row" gap={1} alignItems="flex-start">
        {chip(s)}
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text weight="semibold" dimColor={s.status === 'skipped'}>{s.name}</Text>
            <Text color={STATUS_WORD[s.status].color} size="footnote" weight="medium">{STATUS_WORD[s.status].text}</Text>
          </Box>
          <Text dimColor size="footnote">{s.note}</Text>
          {s.isApproval && (s.status === 'needed' || s.status === 'stale') && harbor.root && (
            <Button
              key={`approve-${s.id}`}
              variant="primary"
              onPress={async () => {
                await record($, harbor.root!, s.id, 'Approved by you')
              }}
            >
              Approve
            </Button>
          )}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {isPicture && 'Svg' in ui ? (
          <ui.Svg source={harborSvg(harbor, isOn, { now, isClear, clearedAt })} alt={alt} isInteractive />
        ) : (
          <Text weight="semibold">
            {harbor.name ? `⚓ ${harbor.name}` : '⚓'} <Text dimColor>{harbor.branch ?? ''}</Text>
          </Text>
        )}

        <Box flexDirection="column">
          <Text color={color} weight="semibold" size="body">{headline}</Text>
          {harbor.root && harbor.changed > 0 && <Text dimColor size="footnote">{`${plural(harbor.changed, 'file')} changed on ${harbor.branch ?? 'this branch'}`}</Text>}
        </Box>

        {harbor.steps.length > 0 && (
          <Box key="manifest" flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1} paddingY={0}>
            <Text size="caption" weight="bold" dimColor>MANIFEST</Text>
            {[...live, ...harbor.steps.filter(s => s.status === 'skipped')].map(row)}
          </Box>
        )}

        <Box flexDirection="row" flexWrap="wrap" gap={2}>
          <Box key="help-pass" flexDirection="column" flexShrink={1} minWidth={18}>
            <Button
              key="pass"
              label="Let one through"
              dimColor={!harbor.root || !isOn}
              onPress={async () => {
                if (!harbor.root) return
                passOnce = harbor.root
                await log($, 'pass', 'You let the next commit, push or pull request through.')
              }}
            />
            <Text dimColor size="footnote">The next commit, push or pull request skips the missing steps.</Text>
          </Box>
          <Box key="help-onoff" flexDirection="column" flexShrink={1} minWidth={18}>
            <Button
              key="onoff"
              label={isOn ? 'Gate: On' : 'Gate: Off'}
              dimColor={!isOn}
              onPress={async () => {
                const next = !isOn
                await update($, onAtom, () => next)
                await $.store.set('enabled', next)
              }}
            >
              <Text color={isOn ? 'success' : 'subtle'}>{isOn ? '●' : '○'}</Text> Gate: {isOn ? 'On' : 'Off'}
            </Button>
            <Text dimColor size="footnote">When it's off, nothing is checked or blocked.</Text>
          </Box>
        </Box>

        <Box flexDirection="column">
          <Text size="caption" weight="bold" dimColor>SHIP'S LOG</Text>
          {log_.length === 0 && <Text dimColor size="footnote">Steps done, held commits and pushes appear here.</Text>}
          {log_
            .slice(-7)
            .reverse()
            .map(entry => (
              <Text size="footnote">
                <Text mono dimColor>{clockTime(entry.at)}</Text> <Text color={LOG_MARK[entry.kind].color}>{LOG_MARK[entry.kind].mark}</Text> {entry.text}
              </Text>
            ))}
        </Box>

        <Text dimColor size="caption">
          Steps live in ~/.claude/ship-gate.json and in .claude/ship-gate.json in each repo. Add one with /ship-gate add, or ask Claude.
        </Text>
      </Box>
    )
  })
}
