/**
 * Isolated component visual fixture for the Google and Anthropic account allowance display,
 * matching DeepSeek Harness viewport and theme. Never loaded in production.
 */
import { createRoot } from 'react-dom/client'
import { en } from '../../src/client/locales.ts'
import { PanelProvider } from '../../src/client/provider.tsx'
import {
  AllowanceHeaderBadge,
  AllowanceSidebarBody,
  AllowanceIcon,
  type AllowanceClientContext,
} from '../../src/client/account-allowance.tsx'
import type { AccountAllowanceReport } from '../../src/app/account-allowance.ts'
import type { T } from '../../src/client/text.ts'

const translator = (dictionary: Record<string, string>): T => ((key: string, params?: Record<string, unknown>) => {
  const template = dictionary[key] ?? key
  return params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
    : template
}) as T

const sampleAllowanceReport: AccountAllowanceReport = {
  accountId: 'acc_primary',
  accountAlias: 'Primary account (system sign-in)',
  accountEmail: 'gera3d@gmail.com',
  isPrimary: true,
  source: 'antigravity',
  sourceLabel: 'Google Antigravity',
  updatedAt: 1794161036386,
  stale: false,
  providers: [
    {
      provider: 'google',
      family: 'google',
      source: 'antigravity',
      label: 'Google (Gemini)',
      accountProvenance: 'Google Antigravity (gera3d@gmail.com)',
      status: 'available',
      rollingWindow: { fraction: 0.6926, resetTime: '2026-11-08T20:25:42Z' },
      weeklyWindow: { fraction: 0.8699, resetTime: '2026-11-14T22:42:10Z' },
      description: 'Models within this group: Gemini Flash, Gemini Pro',
      stale: false,
    },
    {
      provider: 'antigravity-claude',
      family: 'anthropic',
      source: 'antigravity',
      label: 'Antigravity Claude',
      accountProvenance: 'Google Antigravity model pool (multi-model quota)',
      status: 'available',
      rollingWindow: { fraction: 1.0, resetTime: '2026-11-08T23:03:56Z' },
      weeklyWindow: { fraction: 0.4993, resetTime: '2026-11-12T16:11:42Z' },
      description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
      stale: false,
    },
    {
      provider: 'anthropic-direct',
      family: 'anthropic',
      source: 'direct',
      label: 'Anthropic (Direct)',
      accountProvenance: 'Direct Anthropic subscription / API',
      status: 'unavailable',
      description: 'No local authenticated quota reader configured for direct Anthropic subscription',
      stale: false,
    },
  ],
}

const mode = (globalThis as any).__fixtureMode ?? 'after'
const t = translator(en)

const dummyContext = {
  sidebarRight: {
    openTab: () => {},
    isExpanded: () => true,
    toggleExpanded: () => {},
  },
} as unknown as AllowanceClientContext

const page = (
  <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0d1117', color: '#c9d1d9', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
    {/* Watermark / Scope Banner */}
    <header style={{ borderBottom: '1px solid #30363d', padding: '10px 16px', background: '#161b22', color: '#d29922', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <strong>ISOLATED COMPONENT FIXTURE · {mode.toUpperCase()}</strong>
        <span style={{ marginLeft: 12, color: '#8b949e' }}>Finding #f9335259: Native Account Allowance Display (Google & Anthropic)</span>
      </div>
      <span style={{ fontSize: 11, color: '#8b949e' }}>Viewport: 1200×900 · Host Theme</span>
    </header>

    {/* Top App Bar & Navigation */}
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Mini Left Sidebar */}
      <div style={{ width: 56, background: '#010409', borderRight: '1px solid #30363d', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0', gap: 16 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: '#21262d', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <AllowanceIcon size={18} />
        </div>
      </div>

      {/* Main Chat Column */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Chat Header Bar */}
        <div style={{ height: 48, borderBottom: '1px solid #30363d', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#0d1117' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: '#f0f6fc' }}>SuperAgent Session #f5084b7d</span>
            <span style={{ padding: '2px 8px', borderRadius: 12, background: 'rgba(56, 139, 253, 0.15)', color: '#58a6ff', fontSize: 11, fontWeight: 500 }}>
              Active
            </span>
          </div>

          {/* Action slots beside chat */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {mode === 'after' && (
              <AllowanceHeaderBadge ctx={dummyContext} report={sampleAllowanceReport} t={t} />
            )}
            <button type="button" style={{ height: 28, padding: '0 10px', borderRadius: 6, border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: 12, cursor: 'pointer' }}>
              Logs
            </button>
            <button type="button" style={{ height: 28, padding: '0 10px', borderRadius: 6, border: '1px solid #30363d', background: '#21262d', color: '#c9d1d9', fontSize: 12, cursor: 'pointer' }}>
              Clear
            </button>
          </div>
        </div>

        {/* Chat Transcript Area */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16, maxWidth: 640 }}>
            <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 6 }}>Operator · 10:14 AM</div>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>
              Show Google and Anthropic remaining subscription allowance and reset windows directly on the chat screen beside conversation.
            </div>
          </div>

          <div style={{ background: '#161b22', border: '1px solid rgba(56, 139, 253, 0.3)', borderRadius: 8, padding: 16, maxWidth: 640, alignSelf: 'flex-start' }}>
            <div style={{ fontSize: 12, color: '#58a6ff', marginBottom: 6 }}>DeepSeek Harness Agent · 10:15 AM</div>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>
              Mounted compact native allowance indicator in the session header action slot, with full breakdown in the Right Sidebar tab. Reading live local authenticated Antigravity pool.
            </div>
          </div>
        </div>

        {/* Composer Area at bottom */}
        <div style={{ borderTop: '1px solid #30363d', padding: 14, background: '#161b22' }}>
          <div style={{ height: 40, borderRadius: 6, border: '1px solid #30363d', background: '#0d1117', display: 'flex', alignItems: 'center', padding: '0 12px', color: '#8b949e', fontSize: 13 }}>
            Type a message to SuperAgent...
          </div>
        </div>
      </div>

      {/* Right Sidebar Area beside Chat (Documented DeepSeek Harness Right Sidebar Slot) */}
      {mode === 'after' && (
        <div style={{ width: 340, borderLeft: '1px solid #30363d', background: '#0d1117', display: 'flex', flexDirection: 'column' }}>
          {/* Sidebar Tab Header */}
          <div style={{ height: 40, borderBottom: '1px solid #30363d', padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8, background: '#161b22' }}>
            <AllowanceIcon size={14} />
            <span style={{ fontSize: 12, fontWeight: 600, color: '#f0f6fc' }}>Allowance</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: '#8b949e' }}>Docked Right</span>
          </div>

          {/* Sidebar Tab Body */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <AllowanceSidebarBody report={sampleAllowanceReport} t={t} />
          </div>
        </div>
      )}
    </div>
  </div>
)

createRoot(document.getElementById('root')!).render(
  <PanelProvider t={t}>
    {page}
  </PanelProvider>
)
