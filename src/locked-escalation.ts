// Browser-safe: no server imports. The client imports this directly; policy.ts re-exports it.
export interface LockedEscalationItem {
  id: string
  name: string
  description: string
  scope: string
}

export const LOCKED_ESCALATION_LIST: readonly LockedEscalationItem[] = [
  {
    id: 'financial_operations',
    name: 'Financial actions & billing',
    description: 'Money transfers, billing adjustments, cloud compute tier changes, and paid API quota expansion.',
    scope: 'Mandatory human approval before any transaction or payment instrument invocation.',
  },
  {
    id: 'destructive_operations',
    name: 'Destructive modifications & deletions',
    description: 'Deleting git repositories/branches, dropping database tables, unrecoverable workspace wipes.',
    scope: 'Permanent data removal operations must be explicitly confirmed by an operator.',
  },
  {
    id: 'secrets_credentials',
    name: 'Secrets & credentials access',
    description: 'Reading, exporting, or writing raw API keys, private tokens, certificates, or OAuth client secrets.',
    scope: 'Settings reference environment variables only; raw secrets are never touched or automated.',
  },
  {
    id: 'identity_impersonation',
    name: 'Identity impersonation & external broadcast',
    description: 'Sending external messages directly as the user, publishing public releases, external email broadcasts.',
    scope: 'External communication to human recipients requires human review.',
  },
  {
    id: 'undecided_tradeoffs',
    name: 'Genuinely undecided tradeoffs',
    description: 'Strategic architectural choices or policy ambiguity with multiple competing valid outcomes.',
    scope: 'Cannot be decided by character or autopilot; requires human intent guidance.',
  },
] as const
