'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  UserRound, Plus, Shield, ShieldAlert, ShieldOff, KeyRound,
  Copy, Check, X, Trash2, Loader2, AlertCircle,
} from 'lucide-react'

const BORDER = 'hsl(var(--border))'
const MUTED  = 'hsl(var(--muted-foreground))'
const TEXT   = 'hsl(30 10% 15%)'
const BG     = '#fff'

type Status = 'active' | 'suspended' | 'deprecated' | 'unregistered'

interface Agent {
  id: string
  org_id: string
  name?: string
  description?: string
  owner_email?: string
  declared_tools?: string[]
  max_cost_daily_usd?: number
  environments?: string[]
  status: Status
  has_secret: boolean
  has_public_key: boolean
  created_at: string
  updated_at: string
  last_seen_at?: string
}

const STATUS_STYLE: Record<Status, { bg: string; color: string; border: string; label: string }> = {
  active:       { bg: 'hsl(150 12% 95%)', color: 'hsl(150 18% 36%)', border: 'hsl(150 10% 80%)', label: 'Active' },
  suspended:    { bg: 'hsl(25 12% 95%)',  color: 'hsl(25 22% 40%)',  border: 'hsl(25 12% 82%)',  label: 'Suspended' },
  deprecated:   { bg: 'hsl(0 10% 95%)',   color: 'hsl(0 14% 44%)',   border: 'hsl(0 10% 82%)',   label: 'Deprecated' },
  unregistered: { bg: 'hsl(36 12% 95%)',  color: 'hsl(36 22% 40%)',  border: 'hsl(36 12% 82%)',  label: 'Unregistered' },
}

function fmtTs(s?: string): string {
  if (!s) return '—'
  try { return new Date(s).toLocaleString() } catch { return s }
}

function StatusBadge({ s }: { s: Status }) {
  const sty = STATUS_STYLE[s]
  return (
    <span
      className="inline-block text-[11px] font-medium px-2 py-0.5 rounded border"
      style={{ background: sty.bg, color: sty.color, borderColor: sty.border }}
    >
      {sty.label}
    </span>
  )
}

const BLANK = {
  id: '',
  name: '',
  owner_email: '',
  description: '',
  declared_tools: '',
  environments: [] as Array<'dev' | 'staging' | 'prod'>,
  issue_secret: true,
}

export function AgentsView() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [showRegister, setShowRegister] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [registering, setRegistering] = useState(false)
  const [formError, setFormError] = useState('')
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)
  const [selected, setSelected] = useState<Agent | null>(null)

  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['agents', filter],
    queryFn: async () => {
      const url = filter === 'all'
        ? '/api/gateway/agents?include_deprecated=1'
        : `/api/gateway/agents?status=${filter}&include_deprecated=1`
      const res = await fetch(url)
      if (!res.ok) throw new Error('Failed to load agents')
      const j = await res.json()
      return (j.items ?? []) as Agent[]
    },
    refetchInterval: 15000,
  })

  async function submitRegister(e: React.FormEvent) {
    e.preventDefault()
    setRegistering(true)
    setFormError('')
    try {
      const body: any = {
        issue_secret: form.issue_secret,
      }
      if (form.id.trim())          body.id = form.id.trim()
      if (form.name.trim())        body.name = form.name.trim()
      if (form.owner_email.trim()) body.owner_email = form.owner_email.trim()
      if (form.description.trim()) body.description = form.description.trim()
      if (form.declared_tools.trim()) {
        body.declared_tools = form.declared_tools
          .split(',').map(s => s.trim()).filter(Boolean)
      }
      if (form.environments.length > 0) body.environments = form.environments

      const res = await fetch('/api/gateway/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`)
      if (data.secret) setNewSecret(data.secret)
      else setShowRegister(false)
      setForm(BLANK)
      qc.invalidateQueries({ queryKey: ['agents'] })
    } catch (err) {
      setFormError((err as Error).message)
    } finally {
      setRegistering(false)
    }
  }

  async function setStatus(agent: Agent, status: 'active' | 'suspended') {
    const res = await fetch(`/api/gateway/agents/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) {
      qc.invalidateQueries({ queryKey: ['agents'] })
      if (selected?.id === agent.id) {
        const data = await res.json()
        setSelected(data.agent)
      }
    }
  }

  async function rotateSecret(agent: Agent) {
    if (!confirm(`Rotate secret for ${agent.name ?? agent.id}? The current secret will stop working immediately.`)) return
    const res = await fetch(`/api/gateway/agents/${agent.id}/rotate-secret`, { method: 'POST' })
    const data = await res.json()
    if (res.ok && data.secret) setNewSecret(data.secret)
  }

  async function deprecate(agent: Agent) {
    if (!confirm(`Deprecate ${agent.name ?? agent.id}? All calls will be blocked. (Soft delete — record stays for audit.)`)) return
    const res = await fetch(`/api/gateway/agents/${agent.id}`, { method: 'DELETE' })
    if (res.ok) {
      qc.invalidateQueries({ queryKey: ['agents'] })
      if (selected?.id === agent.id) setSelected(null)
    }
  }

  return (
    <div className="space-y-4" style={{ color: TEXT }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <UserRound className="h-5 w-5" style={{ color: 'hsl(var(--primary))' }} />
            Agents
          </h1>
        </div>
        <button
          onClick={() => { setShowRegister(true); setForm(BLANK); setFormError('') }}
          className="text-sm px-3 py-1.5 rounded-md inline-flex items-center gap-1.5"
          style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
        >
          <Plus className="h-3.5 w-3.5" /> Register agent
        </button>
      </div>

      {/* Status filter */}
      <div className="flex gap-1">
        {(['all', 'active', 'unregistered', 'suspended', 'deprecated'] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className="text-[11px] px-2 py-1 rounded border"
            style={{
              background: filter === s ? 'hsl(var(--accent))' : 'transparent',
              borderColor: filter === s ? 'hsl(var(--border))' : 'transparent',
              color: TEXT,
            }}
          >
            {s === 'all' ? 'All' : STATUS_STYLE[s].label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: BORDER, background: BG }}>
        <table className="w-full text-sm">
          <thead style={{ background: 'hsl(var(--accent))', color: MUTED }}>
            <tr className="text-[11px] uppercase tracking-wider">
              <th className="text-left px-4 py-2.5">Status</th>
              <th className="text-left px-4 py-2.5">Name / ID</th>
              <th className="text-left px-4 py-2.5">Owner</th>
              <th className="text-left px-4 py-2.5">Scope</th>
              <th className="text-left px-4 py-2.5">Secret</th>
              <th className="text-left px-4 py-2.5">Last seen</th>
              <th className="text-right px-4 py-2.5">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-xs" style={{ color: MUTED }}>
                <Loader2 className="h-4 w-4 mx-auto animate-spin" />
              </td></tr>
            )}
            {!isLoading && agents.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-xs" style={{ color: MUTED }}>
                No agents yet. Register your first one or wait for the SDK to call in.
              </td></tr>
            )}
            {agents.map(a => (
              <tr
                key={a.id}
                className="border-t cursor-pointer hover:bg-[hsl(var(--accent))]"
                style={{ borderColor: BORDER }}
                onClick={() => setSelected(a)}
              >
                <td className="px-4 py-2.5"><StatusBadge s={a.status} /></td>
                <td className="px-4 py-2.5">
                  <div className="font-medium">{a.name ?? <span style={{ color: MUTED }}>(unnamed)</span>}</div>
                  <div className="text-[10px] font-mono" style={{ color: MUTED }}>{a.id.slice(0, 18)}…</div>
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: MUTED }}>{a.owner_email ?? '—'}</td>
                <td className="px-4 py-2.5 text-xs" style={{ color: MUTED }}>
                  {a.declared_tools?.length ? `${a.declared_tools.length} tool(s)` : <em>any</em>}
                </td>
                <td className="px-4 py-2.5 text-xs">
                  {a.has_secret
                    ? <span style={{ color: 'hsl(150 18% 40%)' }}>✓</span>
                    : <span style={{ color: MUTED }}>—</span>}
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: MUTED }}>{fmtTs(a.last_seen_at)}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={(e) => { e.stopPropagation(); setSelected(a) }}
                    className="text-[11px] px-2 py-1 rounded border"
                    style={{ borderColor: BORDER, color: MUTED }}
                  >Details →</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Register modal */}
      {showRegister && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setShowRegister(false)}>
          <div
            className="w-full max-w-md rounded-xl p-5 space-y-3"
            style={{ background: BG, border: `1px solid ${BORDER}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm">Register agent</h2>
              <button onClick={() => setShowRegister(false)} style={{ color: MUTED }}><X className="h-4 w-4" /></button>
            </div>
            <form onSubmit={submitRegister} className="space-y-3">
              <Field label="Name" value={form.name} onChange={v => setForm({ ...form, name: v })} placeholder="data-bot" />
              <Field label="Owner email" value={form.owner_email} onChange={v => setForm({ ...form, owner_email: v })} placeholder="ops@acme.com" type="email" />
              <Field label="Promote existing agent_id (optional)" value={form.id} onChange={v => setForm({ ...form, id: v })} placeholder="<uuid>" mono />
              <Field label="Description" value={form.description} onChange={v => setForm({ ...form, description: v })} placeholder="What this agent does" />
              <Field
                label="Declared tools (comma-separated)"
                value={form.declared_tools}
                onChange={v => setForm({ ...form, declared_tools: v })}
                placeholder="web_search, send_email, run_query"
                mono
              />
              <div>
                <label className="text-[11px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>Environments</label>
                <div className="flex gap-1">
                  {(['dev', 'staging', 'prod'] as const).map(e => {
                    const on = form.environments.includes(e)
                    return (
                      <button
                        type="button"
                        key={e}
                        onClick={() => setForm({
                          ...form,
                          environments: on
                            ? form.environments.filter(x => x !== e)
                            : [...form.environments, e],
                        })}
                        className="text-[11px] px-2 py-1 rounded border"
                        style={{
                          background: on ? 'hsl(var(--primary))' : 'transparent',
                          color: on ? 'hsl(var(--primary-foreground))' : MUTED,
                          borderColor: on ? 'hsl(var(--primary))' : BORDER,
                        }}
                      >{e}</button>
                    )
                  })}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs" style={{ color: TEXT }}>
                <input
                  type="checkbox"
                  checked={form.issue_secret}
                  onChange={e => setForm({ ...form, issue_secret: e.target.checked })}
                />
                Issue agent secret (returned once; agent must send X-AEGIS-Agent-Secret on every call)
              </label>
              {formError && (
                <div className="text-[11px] inline-flex items-start gap-1.5" style={{ color: 'hsl(0 60% 40%)' }}>
                  <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" /> {formError}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowRegister(false)} className="text-xs px-3 py-1.5" style={{ color: MUTED }}>Cancel</button>
                <button
                  type="submit"
                  disabled={registering}
                  className="text-xs px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40"
                  style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
                >
                  {registering && <Loader2 className="h-3 w-3 animate-spin" />} Register
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Secret display modal — one-time view */}
      {newSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div
            className="w-full max-w-md rounded-xl p-5 space-y-3"
            style={{ background: BG, border: `1px solid hsl(36 24% 70%)` }}
          >
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" style={{ color: 'hsl(36 30% 45%)' }} />
              <h2 className="font-semibold text-sm">Agent secret (shown once)</h2>
            </div>
            <p className="text-xs" style={{ color: MUTED }}>
              Copy this now. AEGIS only stores the SHA-256 hash; this plaintext is unrecoverable after you close this dialog.
            </p>
            <div
              className="font-mono text-xs p-2 rounded border break-all"
              style={{ background: 'hsl(36 14% 96%)', borderColor: BORDER }}
            >{newSecret}</div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(newSecret)
                  setSecretCopied(true)
                  setTimeout(() => setSecretCopied(false), 1500)
                }}
                className="text-xs px-3 py-1.5 rounded-md inline-flex items-center gap-1.5"
                style={{ background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' }}
              >
                {secretCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {secretCopied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={() => { setNewSecret(null); setShowRegister(false); setSecretCopied(false) }}
                className="text-xs px-3 py-1.5 rounded-md"
                style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
              >I saved it</button>
            </div>
          </div>
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={() => setSelected(null)}>
          <div
            className="w-full max-w-lg rounded-xl p-5 space-y-3"
            style={{ background: BG, border: `1px solid ${BORDER}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <StatusBadge s={selected.status} />
                  <h2 className="font-semibold text-sm">{selected.name ?? '(unnamed agent)'}</h2>
                </div>
                <div className="text-[10px] font-mono mt-1" style={{ color: MUTED }}>{selected.id}</div>
              </div>
              <button onClick={() => setSelected(null)} style={{ color: MUTED }}><X className="h-4 w-4" /></button>
            </div>
            <KV k="Owner"        v={selected.owner_email ?? '—'} />
            <KV k="Description"  v={selected.description ?? '—'} />
            <KV k="Declared tools" v={selected.declared_tools?.length ? selected.declared_tools.join(', ') : <em>any (no scope declared)</em>} />
            <KV k="Environments" v={selected.environments?.join(', ') || '—'} />
            <KV k="Max cost (daily, USD)" v={selected.max_cost_daily_usd != null ? `$${selected.max_cost_daily_usd}` : <em>inherit tenant</em>} />
            <KV k="Has secret"   v={selected.has_secret ? 'yes' : 'no'} />
            <KV k="Created"      v={fmtTs(selected.created_at)} />
            <KV k="Last seen"    v={fmtTs(selected.last_seen_at)} />
            <div className="flex flex-wrap gap-2 pt-3 border-t" style={{ borderColor: BORDER }}>
              {selected.status === 'active' && (
                <button
                  onClick={() => setStatus(selected, 'suspended')}
                  className="text-[11px] px-2 py-1.5 rounded border inline-flex items-center gap-1.5"
                  style={{ color: 'hsl(25 22% 40%)', borderColor: 'hsl(25 12% 80%)' }}
                ><ShieldOff className="h-3 w-3" /> Suspend</button>
              )}
              {selected.status === 'suspended' && (
                <button
                  onClick={() => setStatus(selected, 'active')}
                  className="text-[11px] px-2 py-1.5 rounded border inline-flex items-center gap-1.5"
                  style={{ color: 'hsl(150 18% 36%)', borderColor: 'hsl(150 10% 80%)' }}
                ><Shield className="h-3 w-3" /> Reactivate</button>
              )}
              <button
                onClick={() => rotateSecret(selected)}
                className="text-[11px] px-2 py-1.5 rounded border inline-flex items-center gap-1.5"
                style={{ color: TEXT, borderColor: BORDER }}
              ><KeyRound className="h-3 w-3" /> Rotate secret</button>
              {selected.status !== 'deprecated' && (
                <button
                  onClick={() => deprecate(selected)}
                  className="text-[11px] px-2 py-1.5 rounded border inline-flex items-center gap-1.5 ml-auto"
                  style={{ color: 'hsl(0 14% 44%)', borderColor: 'hsl(0 10% 80%)' }}
                ><Trash2 className="h-3 w-3" /> Deprecate</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text', mono = false }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; mono?: boolean
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider block mb-1" style={{ color: MUTED }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full text-sm px-3 py-1.5 rounded-md border ${mono ? 'font-mono text-xs' : ''}`}
        style={{ background: BG, borderColor: BORDER, color: TEXT }}
      />
    </div>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-xs">
      <div style={{ color: MUTED }}>{k}</div>
      <div className="col-span-2" style={{ color: TEXT }}>{v}</div>
    </div>
  )
}
