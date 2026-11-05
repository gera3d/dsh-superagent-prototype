/** Branding section in Superagent settings: logo file/URL, light/dark variants, reset to default, and preview. */
import { useState } from 'react'
import type { BrandingConfig } from '../policy.ts'
import { BrandLogoMark } from './branding-mark.tsx'
import { Button, Input, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Section } from './widgets.tsx'

export function BrandingSettings() {
  const { t } = usePanel()
  const { settings } = useSettings()
  const brandingBlock = settings.blocks.branding ?? {
    value: { logo: '', logoDark: '', logoLight: '', hideWordmark: true } as BrandingConfig,
    revision: 1,
  }

  const draft = useBlockDraft('branding', brandingBlock.value, brandingBlock.revision)
  const value = draft.value
  const [resetMessage, setResetMessage] = useState<string | null>(null)

  const updateField = <K extends keyof BrandingConfig>(key: K, val: BrandingConfig[K]) => {
    setResetMessage(null)
    draft.edit({ ...value, [key]: val })
  }

  const resetToDefault = () => {
    draft.edit({ logo: '', logoDark: '', logoLight: '', hideWordmark: true })
    setResetMessage(t('branding.resetNotice'))
  }

  const activeDarkLogo = value.logoDark || value.logo
  const activeLightLogo = value.logoLight || value.logo
  const isDefault =
    !value.logo &&
    !value.logoDark &&
    !value.logoLight &&
    (value.hideWordmark === true || value.hideWordmark === undefined)

  return (
    <form className="dt-form dt-block dt-branding-settings" data-testid="branding-settings" onSubmit={event => { void draft.submit(event) }}>
      <Section title={t('branding.title')} hint={t('branding.subtitle')}>
        <Fields disabled={draft.busy}>
          <Field label={t('branding.logo')} hint={t('branding.logoDesc')}>
            <Input
              value={value.logo}
              placeholder="/path/to/logo.png or https://example.com/logo.png"
              onChange={e => updateField('logo', e.target.value)}
              data-testid="input-branding-logo"
            />
          </Field>

          <Field label={t('branding.logoDark')} hint={t('branding.logoDarkDesc')}>
            <Input
              value={value.logoDark}
              placeholder="/path/to/logo-dark.png (optional dark theme override)"
              onChange={e => updateField('logoDark', e.target.value)}
              data-testid="input-branding-logo-dark"
            />
          </Field>

          <Field label={t('branding.logoLight')} hint={t('branding.logoLightDesc')}>
            <Input
              value={value.logoLight}
              placeholder="/path/to/logo-light.png (optional light theme override)"
              onChange={e => updateField('logoLight', e.target.value)}
              data-testid="input-branding-logo-light"
            />
          </Field>

          <Field label={t('branding.hideWordmark')} hint={t('branding.hideWordmarkDesc')}>
            <div style={{ display: 'flex', alignItems: 'center', height: '32px' }}>
              <Switch
                checked={value.hideWordmark !== false}
                onChange={next => updateField('hideWordmark', next)}
                label={t('branding.hideWordmark')}
                className="dt-branding-hide-wordmark"
              />
            </div>
          </Field>

          <div style={{ marginTop: '16px', display: 'flex', gap: '12px', alignItems: 'center' }}>
            <Button
              type="button"
              variant="outline"
              onClick={resetToDefault}
              disabled={isDefault}
              data-testid="button-branding-reset"
            >
              {t('branding.reset')}
            </Button>
            {resetMessage && (
              <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
                {resetMessage}
              </span>
            )}
          </div>
        </Fields>
      </Section>

      <Section title={t('branding.preview')} hint={t('branding.previewSubtitle')}>
        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginTop: '12px' }}>
          {/* Dark theme preview at 24px */}
          <div
            style={{
              padding: '16px',
              borderRadius: '8px',
              background: '#18181b',
              color: '#ffffff',
              border: '1px solid #27272a',
              minWidth: '200px',
            }}
          >
            <div style={{ fontSize: '11px', color: '#a1a1aa', marginBottom: '8px' }}>
              {t('branding.previewDark')} (24px header)
            </div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '32px',
                height: '32px',
                background: '#09090b',
                borderRadius: '6px',
                border: '1px solid #27272a',
              }}
            >
              <BrandLogoMark size={24} branding={{ logo: activeDarkLogo, logoDark: activeDarkLogo, logoLight: '' }} />
            </div>
          </div>

          {/* Light theme preview at 24px */}
          <div
            style={{
              padding: '16px',
              borderRadius: '8px',
              background: '#f4f4f5',
              color: '#18181b',
              border: '1px solid #e4e4e7',
              minWidth: '200px',
            }}
          >
            <div style={{ fontSize: '11px', color: '#71717a', marginBottom: '8px' }}>
              {t('branding.previewLight')} (24px header)
            </div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '32px',
                height: '32px',
                background: '#ffffff',
                borderRadius: '6px',
                border: '1px solid #e4e4e7',
              }}
            >
              <BrandLogoMark size={24} branding={{ logo: activeLightLogo, logoDark: '', logoLight: activeLightLogo }} />
            </div>
          </div>
        </div>
      </Section>

      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  )
}
