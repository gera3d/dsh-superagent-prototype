/** Characters settings group: response characters, Decisions API ranker configuration, and locked escalation boundaries. */
import { useState } from 'react'
import { LIMITS } from '../limits.ts'
import { LOCKED_ESCALATION_LIST, type Character, type CharactersConfig, type DecisionsConfig } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Pill, SegmentedControl, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Field, Fields, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Hint, LabelValue, Section } from './widgets.tsx'

function CharacterCard({
  character,
  isActive,
  expanded,
  onToggle,
  onChange,
  onSetActive,
  onDuplicate,
  onRemove,
  canRemove,
}: {
  character: Character
  isActive: boolean
  expanded: boolean
  onToggle: () => void
  onChange: (next: Character) => void
  onSetActive: () => void
  onDuplicate: () => void
  onRemove: () => void
  canRemove: boolean
}) {
  const { t } = usePanel()
  const name = character.name.trim() || t('addCharacter')
  const toolsText = character.tools.join(', ')

  return (
    <li className="dt-character-card">
      <DisclosureRow
        icon={<Icon name="user" size={16} />}
        title={
          <span className="dt-character-title">
            <strong className="dt-character-name">{name}</strong>
            <span className="dt-character-specialty">{character.specialty}</span>
            {isActive && <span className="dt-character-badge dt-character-badge-active">{t('characterActive')}</span>}
            <span className="dt-character-badge dt-character-badge-mode">
              {character.mode === 'auto' ? t('characterMode.auto') : t('characterMode.suggest')}
            </span>
          </span>
        }
        open={expanded}
        onToggle={onToggle}
        collapsedContent={<span className="dt-character-preview">{character.brief}</span>}
      >
        <div className="dt-character-body">
          <Field label={t('characterName')}>
            <Input
              value={character.name}
              required
              maxLength={LIMITS.characterName}
              onChange={event => onChange({ ...character, name: event.target.value })}
            />
          </Field>
          <Field label={t('characterSpecialty')}>
            <Input
              value={character.specialty}
              required
              maxLength={LIMITS.characterSpecialty}
              onChange={event => onChange({ ...character, specialty: event.target.value })}
            />
          </Field>
          <Field label={t('characterBrief')}>
            <textarea
              className="dt-textarea"
              rows={3}
              required
              maxLength={LIMITS.characterBrief}
              value={character.brief}
              placeholder={t('characterBriefPlaceholder')}
              onChange={event => onChange({ ...character, brief: event.target.value })}
            />
          </Field>
          <Field label={t('characterTools')} hint={t('characterToolsHint')}>
            <Input
              value={toolsText}
              onChange={event =>
                onChange({
                  ...character,
                  tools: event.target.value
                    .split(',')
                    .map(item => item.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Section title={t('characterMode')} hint={character.mode === 'auto' ? t('characterMode.auto') : t('characterMode.suggest')}>
            <SegmentedControl
              className="dt-segmented"
              label={t('characterMode')}
              value={character.mode}
              onChange={mode => onChange({ ...character, mode })}
              options={[
                { value: 'suggest', label: t('characterMode.suggest'), title: t('characterMode.suggest') },
                { value: 'auto', label: t('characterMode.auto'), title: t('characterMode.auto') },
              ]}
            />
          </Section>
          <div className="dt-actions">
            {!isActive && (
              <Button variant="outline" size="sm" icon={<Icon name="shield" />} onClick={onSetActive}>
                {t('characterActive')}
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={onDuplicate}>
              {t('duplicate')}
            </Button>
            {canRemove && (
              <Button variant="ghost" size="sm" icon={<Icon name="trash" />} onClick={onRemove}>
                {t('remove')}
              </Button>
            )}
          </div>
        </div>
      </DisclosureRow>
      <Switch
        className="dt-character-switch"
        checked={character.enabled}
        onChange={enabled => onChange({ ...character, enabled })}
        label={character.name}
      />
    </li>
  )
}

function CharactersBlock() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.characters
  const draft = useBlockDraft<CharactersConfig>('characters', block.value, block.revision)
  const value = draft.value
  const [expanded, setExpanded] = useState<Set<string>>(new Set([value.activeCharacterId]))

  const toggle = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  const add = () => {
    const id = `char-${crypto.randomUUID().slice(0, 8)}`
    const newChar: Character = {
      id,
      name: '',
      specialty: '',
      brief: '',
      tools: [],
      mode: 'suggest',
      enabled: true,
    }
    setExpanded(new Set([...expanded, id]))
    draft.edit({ ...value, items: [...value.items, newChar] })
  }

  const duplicate = (char: Character, index: number) => {
    const copyId = `char-${crypto.randomUUID().slice(0, 8)}`
    const copy: Character = {
      ...char,
      id: copyId,
      name: `${char.name} (${t('copySuffix') || 'copy'})`,
    }
    setExpanded(new Set([...expanded, copyId]))
    draft.edit({
      ...value,
      items: [...value.items.slice(0, index + 1), copy, ...value.items.slice(index + 1)],
    })
  }

  const remove = (index: number) => {
    const nextItems = value.items.filter((_, i) => i !== index)
    const nextActive = value.activeCharacterId === value.items[index]?.id ? (nextItems[0]?.id ?? '') : value.activeCharacterId
    draft.edit({ ...value, items: nextItems, activeCharacterId: nextActive })
  }

  return (
    <form
      className="dt-form dt-block"
      onSubmit={event => {
        void draft.submit(event)
      }}
    >
      <Fields disabled={draft.busy}>
        <h2 className="dt-block-title">
          {t('term.characters')}
          <InfoTip text={t('charactersIntro')} />
        </h2>
        <Section title={t('term.characters')} hint={t('charactersHint')} action={
          <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={add}>
            {t('addCharacter')}
          </Button>
        }>
          <ul className="dt-characters-list">
            {value.items.map((char, index) => (
              <CharacterCard
                key={char.id}
                character={char}
                isActive={char.id === value.activeCharacterId}
                expanded={expanded.has(char.id)}
                onToggle={() => toggle(char.id)}
                onChange={next =>
                  draft.edit({
                    ...value,
                    items: value.items.map((item, i) => (i === index ? next : item)),
                  })
                }
                onSetActive={() => draft.edit({ ...value, activeCharacterId: char.id })}
                onDuplicate={() => duplicate(char, index)}
                onRemove={() => remove(index)}
                canRemove={value.items.length > 1}
              />
            ))}
          </ul>
        </Section>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  )
}

function DecisionsRankerBlock() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.decisions
  const saved = { ...block.value, timeoutMs: String(block.value.timeoutMs) }
  const draft = useBlockDraft<typeof saved>('decisions', saved, block.revision, value => ({
    ...value,
    timeoutMs: numberOf(value.timeoutMs) ?? 15000,
  }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })

  return (
    <form
      className="dt-form dt-block"
      onSubmit={event => {
        void draft.submit(event)
      }}
    >
      <Fields disabled={draft.busy}>
        <h2 className="dt-block-title">
          {t('decisionsRanker')}
          <InfoTip text={t('decisionsRankerIntro')} />
        </h2>
        <Section title={t('decisionsProvider')} hint={t('decisionsRankerIntro')}>
          <SegmentedControl
            className="dt-segmented"
            label={t('decisionsProvider')}
            value={value.provider}
            onChange={provider => edit({ provider })}
            options={[
              { value: 'auto', label: 'auto (configured LLM)', title: 'Uses host configured model' },
              { value: 'openai-luna', label: 'openai-luna (Chat/Decisions)', title: 'OpenAI structured decision ranker' },
              { value: 'typesafe-jev', label: 'typesafe-jev (System One)', title: 'TypeSafe Jev System One' },
              { value: 'deepseek', label: 'deepseek', title: 'DeepSeek evaluator' },
            ]}
          />
        </Section>
        <Field label={t('decisionsModel')}>
          <Input
            value={value.model}
            placeholder="gpt-6-luna (or leave empty for default)"
            onChange={event => edit({ model: event.target.value })}
          />
        </Field>
        <Field label={t('decisionsEndpoint')} hint={t('decisionsEndpointHint')}>
          <Input
            value={value.endpoint}
            placeholder="https://api.openai.com/v1/chat/completions"
            onChange={event => edit({ endpoint: event.target.value })}
          />
        </Field>
        <Field label={t('decisionsApiKeyEnv')} hint={t('decisionsApiKeyEnvHint')}>
          <Input
            className="dt-mono"
            value={value.apiKeyEnv}
            placeholder="OPENAI_API_KEY"
            pattern="^[A-Za-z_][A-Za-z0-9_]*$"
            onChange={event => edit({ apiKeyEnv: event.target.value })}
          />
        </Field>
        <Field label={t('decisionsTimeout')}>
          <Input
            type="number"
            min={1000}
            max={120000}
            value={value.timeoutMs}
            onChange={event => edit({ timeoutMs: event.target.value })}
          />
        </Field>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  )
}

function LockedEscalationBlock() {
  const { t } = usePanel()

  return (
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">
        {t('lockedEscalationTitle')}
        <InfoTip text={t('lockedEscalationHint')} />
      </h2>
      <Hint>{t('lockedEscalationHint')}</Hint>
      <ul className="dt-locked-list">
        {LOCKED_ESCALATION_LIST.map(item => (
          <li key={item.id} className="dt-locked-item">
            <div className="dt-locked-header">
              <span className="dt-locked-icon">🔒</span>
              <strong className="dt-locked-name">{item.name}</strong>
              <span className="dt-locked-badge">{t('lockedEscalationReadOnly')}</span>
            </div>
            <p className="dt-locked-desc">{item.description}</p>
            <small className="dt-locked-scope">{item.scope}</small>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function CharactersSettings() {
  return (
    <div className="dt-form">
      <CharactersBlock />
      <DecisionsRankerBlock />
      <LockedEscalationBlock />
      <ConfigHistory blocks={['characters', 'decisions']} />
    </div>
  )
}
