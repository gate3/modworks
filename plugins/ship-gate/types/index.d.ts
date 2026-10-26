/** Where a step stands for the code as it is now. */
export type StepStatus = 'done' | 'stale' | 'needed' | 'running' | 'skipped'

export type StepView = {
  id: string
  name: string
  /** The signal flag's letter, A to Z. */
  flag: string
  status: StepStatus
  note: string
  /** When the status last changed, so the flag's hoist or drop animates once. */
  changedAt?: number
  isApproval: boolean
}

/** The repository the pane shows, and how its voyage stands. */
export type Harbor = {
  root?: string
  name?: string
  branch?: string
  steps: StepView[]
  changed: number
  held?: { at: number; action: string; missing: string[] }
  shipped?: { at: number; text: string }
}

export type LogEntry = {
  at: number
  kind: 'raise' | 'lower' | 'hold' | 'sail' | 'route' | 'guard' | 'pass'
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'ship-gate': {
      harbor: Harbor
      log: LogEntry[]
      isOn: boolean
      tick: number
    }
  }
}
