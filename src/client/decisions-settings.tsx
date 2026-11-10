/** Decisions section in Superagent settings: which ranker picks the recommended option, and where its key comes from. */
import { Button, Input, SegmentedControl } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Section } from './widgets.tsx'
import type { DecisionsConfig } from '../policy.ts'

const PROVIDERS = ['auto', 'typesafe-jev', 'openai-luna', 'deepseek'] as const
/** OpenRouter serves Jev on its own Decisions API; this fills the endpoint and model so the operator only names the key variable. */
export const JEV_OPENROUTER = { provider: 'typesafe-jev', model: 'typesafe/jev-1.13', endpoint: 'https://openrouter.ai/api/alpha/decisions',
  apiKeyEnv: 'OPENROUTER_API_KEY' } as const satisfies Partial<DecisionsConfig>

export function DecisionsSettings() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.decisions
  const draft = useBlockDraft('decisions', { ...block.value, timeoutMs: String(block.value.timeoutMs) }, block.revision,
    value => ({ ...value, timeoutMs: numberOf(value.timeoutMs) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  return <form className="dt-form dt-block" data-testid="decisions-settings" onSubmit={event => { void draft.submit(event) }}>
    <Section title={t('decisionsSettings.title')} hint={t('decisionsSettings.hint')}>
      <Fields disabled={draft.busy}>
        <Field label={t('decisionsSettings.provider')} hint={t('decisionsSettings.providerHint')}>
          <div><SegmentedControl label={t('decisionsSettings.provider')} value={value.provider} disabled={draft.busy}
            options={PROVIDERS.map(item => ({ value: item, label: t(`decisionsSettings.provider.${item}`) }))}
            onChange={provider => edit({ provider })} /></div>
        </Field>
        <Field label={t('decisionsSettings.model')} hint={t('decisionsSettings.modelHint')}>
          <Input value={value.model} placeholder="typesafe/jev-1.13" onChange={event => edit({ model: event.target.value })} />
        </Field>
        <Field label={t('decisionsSettings.endpoint')} hint={t('decisionsSettings.endpointHint')}>
          <Input value={value.endpoint} placeholder="https://openrouter.ai/api/alpha/decisions"
            onChange={event => edit({ endpoint: event.target.value })} />
        </Field>
        <Field label={t('decisionsSettings.apiKeyEnv')} hint={t('decisionsSettings.apiKeyEnvHint')}>
          <Input value={value.apiKeyEnv} placeholder="OPENROUTER_API_KEY" autoComplete="off"
            onChange={event => edit({ apiKeyEnv: event.target.value })} />
        </Field>
        <Field label={t('decisionsSettings.timeout')} hint={t('decisionsSettings.timeoutHint')}>
          <Input type="number" min={1000} max={120000} required value={value.timeoutMs}
            onChange={event => edit({ timeoutMs: event.target.value })} />
        </Field>
        <div className="dt-actions">
          <Button type="button" variant="outline" data-testid="decisions-use-jev"
            onClick={() => edit({ ...JEV_OPENROUTER })}>{t('decisionsSettings.useJev')}</Button>
        </div>
      </Fields>
    </Section>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}
