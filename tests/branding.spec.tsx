// @vitest-environment jsdom
/** Unit tests for custom branding schema, HTTP endpoints, fail-safe fallback, and mark rendering. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrandingConfigSchema, SettingsSchema } from '../src/policy.ts'
import { BrandLogoMark, DefaultFishLogo } from '../src/client/branding-mark.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  container?.remove()
  container = undefined
  vi.restoreAllMocks()
})

describe('BrandingConfigSchema', () => {
  it('defaults to empty strings for all logo variants', () => {
    const config = BrandingConfigSchema.parse({})
    expect(config).toEqual({
      logo: '',
      logoDark: '',
      logoLight: '',
    })
  })

  it('parses valid local file paths and remote URLs', () => {
    const config = BrandingConfigSchema.parse({
      logo: '/Users/test/logo.png',
      logoDark: '/Users/test/logo-dark.png',
      logoLight: 'https://why57.com/images/57_wht_notext.png',
    })
    expect(config.logo).toBe('/Users/test/logo.png')
    expect(config.logoDark).toBe('/Users/test/logo-dark.png')
    expect(config.logoLight).toBe('https://why57.com/images/57_wht_notext.png')
  })

  it('is integrated into SettingsSchema with defaults', () => {
    const settings = SettingsSchema.parse({})
    expect(settings.branding).toEqual({
      logo: '',
      logoDark: '',
      logoLight: '',
    })
  })
})

describe('BrandLogoMark Component', () => {
  it('shows DeepSeek default FishLogo when override is missing', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<BrandLogoMark size={24} branding={{ logo: '', logoDark: '', logoLight: '' }} />)
    })

    const svg = container.querySelector('svg[data-testid="default-fish-logo"]')
    const img = container.querySelector('img[data-testid="custom-brand-logo"]')
    expect(svg).not.toBeNull()
    expect(img).toBeNull()
  })

  it('renders custom brand image when logo is configured', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<BrandLogoMark size={24} branding={{ logo: '/images/57_wht_notext.png', logoDark: '', logoLight: '' }} />)
    })

    const svg = container.querySelector('svg[data-testid="default-fish-logo"]')
    const img = container.querySelector('img[data-testid="custom-brand-logo"]') as HTMLImageElement
    expect(svg).toBeNull()
    expect(img).not.toBeNull()
    expect(img.style.maxHeight).toBe('24px')
    expect(img.style.maxWidth).toBe('24px')
    expect(img.style.objectFit).toBe('contain')
  })

  it('fails safe and falls back to DeepSeek default FishLogo if image fails to load', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(<BrandLogoMark size={24} branding={{ logo: '/nonexistent/broken.png', logoDark: '', logoLight: '' }} />)
    })

    const img = container.querySelector('img[data-testid="custom-brand-logo"]') as HTMLImageElement
    expect(img).not.toBeNull()

    // Trigger image error (e.g. 404 or corrupted asset)
    await act(async () => {
      img.dispatchEvent(new Event('error'))
    })

    // Fail safe: DeepSeek default fish logo is rendered instead of a blank element
    const svg = container.querySelector('svg[data-testid="default-fish-logo"]')
    expect(svg).not.toBeNull()
    expect(container.querySelector('img[data-testid="custom-brand-logo"]')).toBeNull()
  })
})

describe('Branding Settings and API integration', () => {
  it('saves branding block and returns it in GET branding and GET settings', async () => {
    let h: Host | undefined
    try {
      h = await startRuntime()
      const { settings, store } = h.runtime

      // Initially empty
      expect(store.settings().branding).toEqual({ logo: '', logoDark: '', logoLight: '' })

      // Save branding configuration
      const rev = store.blockRevision('branding')
      await settings.save(
        'branding',
        { logo: '/images/57_wht_notext.png', logoDark: '/images/57_wht_notext.png', logoLight: '' },
        rev,
        'panel'
      )

      expect(store.settings().branding.logo).toBe('/images/57_wht_notext.png')
      expect(store.settings().branding.logoDark).toBe('/images/57_wht_notext.png')

      // API route returns updated branding
      const brandingRes = await h.api('GET', 'branding')
      expect(brandingRes.status).toBe(200)
      expect((brandingRes.body as { branding: { logo: string } }).branding.logo).toBe('/images/57_wht_notext.png')

      // Reset to default
      const nextRev = store.blockRevision('branding')
      await settings.save('branding', { logo: '', logoDark: '', logoLight: '' }, nextRev, 'panel')
      expect(store.settings().branding).toEqual({ logo: '', logoDark: '', logoLight: '' })
    } finally {
      await h?.stop()
    }
  })
})
