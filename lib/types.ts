// File: lib/types.ts
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-dashboard\lib\types.ts
// ── Supabase table types ──────────────────────────────────────────────────────

export interface KpiSnapshot {
  id?: string
  account_id: string
  sla?: string
  total_calls?: string
  outbound?: string
  inbound?: string
  answered?: string
  unanswered?: string
  time_to_answer?: string
  longest_waiting?: string
  available_users?: string
  calls_waiting?: string
  updated_at?: string
  [key: string]: any  // allow dynamic column access
}

export interface AgentState {
  id?: string
  account_id: string
  agent_name: string
  status?: string
  duration?: string
  updated_at?: string
  [key: string]: any
}

export interface UserStatusCounts {
  id?: string
  account_id: string
  available?: number
  ringing?: number
  in_call?: number
  after_call_work?: number
  not_available?: number
  do_not_disturb?: number
  on_a_break?: number
  out_for_lunch?: number
  offline?: number
  updated_at?: string
  [key: string]: any
}

export interface ActiveCall {
  id?: string
  account_id: string
  direction?: string
  status?: string
  duration?: string
  updated_at?: string
  [key: string]: any
}

// ── Account data (generic — supports any data source) ─────────────────────────
export interface AccountData {
  kpi:     Record<string, any> | null    // single-row KPI (Aircall-style)
  kpiRows: Record<string, any>[]         // multi-row KPI (Talkdesk LOB-style)
  agents:  Record<string, any>[]
  status:  Record<string, any> | null
  calls:   Record<string, any>[]
  syncing?: boolean
}

// ── KPI threshold type ────────────────────────────────────────────────────────
export interface Thresholds {
  sla:  { warn: number; crit: number; targ: number; direction: 'asc' | 'desc' }
  wait: { warn: number; crit: number; targ: number; direction: 'asc' | 'desc' }
  aht:  { warn: number; crit: number; targ: number; direction: 'asc' | 'desc' }
  abn:  { warn: number; crit: number; targ: number; direction: 'asc' | 'desc' }
}

// ── Data source configuration (per account, stored in localStorage) ───────────
export interface DataSourceConfig {
  // KPI data
  kpiTable:      string   // e.g. "wfm_kpi_snapshots" or "talkdesk_lob_kpis"
  kpiAccountCol: string   // column that contains account_id
  kpiGroupCol:   string   // '' = single row; 'lob_name' = multi-row per LOB
  kpiSlaCol:     string   // column for SLA value
  kpiQueueCol:   string   // column for queue / calls waiting
  kpiAsaCol:     string   // column for ASA / AHT
  kpiAbnCol:     string   // column for abandon rate ('' if N/A)
  kpiAgentsCol:  string   // column for available/logged-in agent count
  kpiUpdatedAt:  string   // column for updated_at timestamp

  // Agent data
  agentTable:       string
  agentAccountCol:  string
  agentNameCol:     string
  agentStatusCol:   string
  agentDurationCol: string    // duration as string e.g. "5:23"
  agentDurationSecs:string    // duration in seconds ('' if N/A)
}
