export type GuardSettings = {
  autoHandoff: boolean
  handoffAt: number
  idleHandoff: boolean
  idleHandoffAt: number
  trimOutput: boolean
  trimAt: number
  cheapSubagents: boolean
}

export type Meter = {
  tokens: number
  window: number
  usd?: number
  model: string
  ttl: '5m' | '1h'
  lastRequestAt?: number
  hits: number[]
  missUsd: number
  freedTokens: number
  handoffs: number
  /** The plan's usage windows (five_hour, seven_day), empty off a subscription. */
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  /** The weekly limit's percentUsed at the first reading, for "from this session". */
  weekAtStart?: number
}

export type Phase =
  | { kind: 'idle' }
  | { kind: 'writing'; since: number }
  | { kind: 'clearing'; since: number }

export type Moment = {
  at: number
  kind: 'handoff' | 'miss' | 'trim' | 'route' | 'skip'
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'cost-guard': {
      prefs: GuardSettings
      meter: Meter
      phase: Phase
      moments: Moment[]
      tick: number
      running: boolean
    }
  }
}
