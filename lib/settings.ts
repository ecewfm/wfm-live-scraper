// File: lib/settings.ts
// Path: C:\Users\rodolfo.luga\Documents\Node Projects\wfm-live-dashboard\lib\settings.ts
// lib/settings.ts
// Saves and loads account settings (KPI thresholds, status thresholds, data source)
// to Supabase so ALL browsers and devices share the same configuration.
// localStorage is kept as a cache/fallback for offline use.

import { supabase } from './supabase'
import type { Thresholds, DataSourceConfig } from './types'
import type { StatusThresholds } from './utils'
import {
  DEFAULT_THRESHOLDS, DEFAULT_STATUS_THRESHOLDS, DEFAULT_DATA_SOURCE,
  loadKpiThresholds, loadStatusThresholds, loadDataSource,
  saveKpiThresholds, saveStatusThresholds, saveDataSource
} from './utils'

export interface AccountSettings {
  kpi:    Thresholds
  status: StatusThresholds
  ds:     DataSourceConfig
}

// ── Load settings for one account ─────────────────────────────────────────────
// Priority: Supabase → localStorage → hardcoded defaults
export async function loadSettings(accountId: string): Promise<AccountSettings> {
  try {
    const { data, error } = await supabase
      .from('wfm_settings')
      .select('kpi_thresholds, status_thresholds, data_source')
      .eq('id', accountId)
      .maybeSingle()

    if (!error && data) {
      const settings: AccountSettings = {
        kpi:    data.kpi_thresholds
                  ? { ...DEFAULT_THRESHOLDS,        ...data.kpi_thresholds    }
                  : loadKpiThresholds(accountId),
        status: data.status_thresholds
                  ? { ...DEFAULT_STATUS_THRESHOLDS, ...data.status_thresholds }
                  : loadStatusThresholds(accountId),
        ds:     data.data_source
                  ? { ...DEFAULT_DATA_SOURCE,       ...data.data_source       }
                  : loadDataSource(accountId),
      }
      // Refresh localStorage cache
      saveKpiThresholds(accountId, settings.kpi)
      saveStatusThresholds(accountId, settings.status)
      saveDataSource(accountId, settings.ds)
      return settings
    }
  } catch {}

  // Fallback: localStorage (works offline or if table doesn't exist yet)
  return {
    kpi:    loadKpiThresholds(accountId),
    status: loadStatusThresholds(accountId),
    ds:     loadDataSource(accountId),
  }
}

// ── Save settings for one account ─────────────────────────────────────────────
// Writes to Supabase (shared) AND localStorage (local cache).
export async function saveSettings(
  accountId: string,
  kpi:    Thresholds,
  status: StatusThresholds,
  ds:     DataSourceConfig
): Promise<boolean> {
  // 1. Always write to localStorage immediately (instant, works offline)
  saveKpiThresholds(accountId, kpi)
  saveStatusThresholds(accountId, status)
  saveDataSource(accountId, ds)

  // 2. Write to Supabase (shared across all browsers/devices)
  try {
    const { error } = await supabase
      .from('wfm_settings')
      .upsert({
        id:                accountId,
        account_id:        accountId,
        kpi_thresholds:    kpi,
        status_thresholds: status,
        data_source:       ds,
        updated_at:        new Date().toISOString(),
      })
    if (error) { console.warn('[settings] Supabase save error:', error.message); return false }
    return true
  } catch (e) {
    console.warn('[settings] Supabase save failed:', e)
    return false
  }
}

// ── Load settings for multiple accounts in parallel ───────────────────────────
export async function loadAllSettings(
  accountIds: string[]
): Promise<Record<string, AccountSettings>> {
  const results = await Promise.all(accountIds.map(id => loadSettings(id)))
  const map: Record<string, AccountSettings> = {}
  accountIds.forEach((id, i) => { map[id] = results[i] })
  return map
}

// ── Account management ─────────────────────────────────────────────────────────

export interface AccountConfig {
  id:           string
  display_name: string
  active:       boolean
  sort_order:   number
  created_at?:  string
}

/** Load all accounts from wfm_accounts, falling back to discovering from data tables */
export async function loadAccounts(): Promise<AccountConfig[]> {
  try {
    const { data, error } = await supabase
      .from('wfm_accounts')
      .select('*')
      .eq('active', true)
      .order('sort_order')
      .order('created_at')
    if (!error && data && data.length > 0) return data as AccountConfig[]
  } catch {}

  // Fallback: discover from existing data tables (backwards compat)
  try {
    const [r1, r2] = await Promise.all([
      supabase.from('wfm_kpi_snapshots').select('account_id'),
      supabase.from('talkdesk_lob_kpis').select('account_id'),
    ])
    const ids = new Set<string>()
    ;(r1.data ?? []).forEach((r: any) => ids.add(r.account_id))
    ;(r2.data ?? []).forEach((r: any) => ids.add(r.account_id))
    return [...ids].sort().map((id, i) => ({
      id, display_name: id, active: true, sort_order: i
    }))
  } catch {}
  return []
}

/** Add a new account — throws on error so the UI can show it */
export async function addAccount(id: string, displayName?: string): Promise<void> {
  const trimId = id.trim().toLowerCase().replace(/\s+/g, '-')
  if (!trimId) throw new Error('Account ID cannot be empty')
  const { error } = await supabase.from('wfm_accounts').upsert({
    id:           trimId,
    display_name: displayName?.trim() || trimId,
    active:       true,
    sort_order:   Math.floor(Date.now() / 1000),
    created_at:   new Date().toISOString(),
  })
  if (error) throw new Error(error.message || JSON.stringify(error))
}

/** Remove (deactivate) an account — throws on error */
export async function removeAccount(id: string): Promise<void> {
  const { error } = await supabase
    .from('wfm_accounts')
    .update({ active: false })
    .eq('id', id)
  if (error) throw new Error(error.message || JSON.stringify(error))
}

/** Seed existing discovered accounts into wfm_accounts (run once on first load) */
export async function seedAccountsIfEmpty(ids: string[]): Promise<void> {
  try {
    const { data } = await supabase.from('wfm_accounts').select('id').limit(1)
    if (data && data.length > 0) return  // already seeded
    await Promise.all(ids.map((id, i) =>
      supabase.from('wfm_accounts').upsert({
        id, display_name: id, active: true, sort_order: i,
        created_at: new Date().toISOString(),
      })
    ))
  } catch {}
}
