#!/usr/bin/env node
/**
 * Interactive OAuth Subscription Login for DeepSeek Harness (DSH).
 * Logs in with Anthropic (Claude Pro/Max) or OpenAI (ChatGPT Plus/Pro)
 * and saves the resulting token directly into $DSH_HOME/.credentials.yaml.
 */

const { exec } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

const YAML = require('/Users/gerayeremin/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml')
const { loadAnthropicOAuth, loadOpenAICodexOAuth } = require('/Users/gerayeremin/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/auth/oauth/load.js')

const CREDENTIALS_PATH = path.resolve(
  process.env.DSH_HOME || path.join(process.env.HOME, 'Library/Application Support/dsh-desktop/harness'),
  '.credentials.yaml'
)

function saveGrant(recordKey, grant) {
  let doc = { version: 1, records: {}, refs: {} }
  if (fs.existsSync(CREDENTIALS_PATH)) {
    try {
      doc = YAML.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')) || doc
      doc.records = doc.records || {}
      doc.refs = doc.refs || {}
    } catch (err) {
      console.warn('Warning: could not parse existing credentials.yaml, creating new structure:', err.message)
    }
  }

  doc.records[recordKey] = {
    kind: 'grant',
    payload: grant,
  }

  fs.writeFileSync(CREDENTIALS_PATH, YAML.stringify(doc), 'utf8')
  console.log(`\n✓ Saved subscription grant for "${recordKey}" to:`)
  console.log(`  ${CREDENTIALS_PATH}`)
}

async function runLogin(providerName) {
  let oauthHandler
  let recordKey
  let title

  if (providerName === 'anthropic' || providerName === 'claude') {
    oauthHandler = await loadAnthropicOAuth()
    recordKey = 'llm-pi-ai/anthropic'
    title = 'Anthropic (Claude Pro/Max)'
  } else if (providerName === 'openai' || providerName === 'chatgpt' || providerName === 'codex') {
    oauthHandler = await loadOpenAICodexOAuth()
    recordKey = 'llm-pi-ai/openai-codex'
    title = 'OpenAI (ChatGPT Plus/Pro)'
  } else {
    console.error('Usage: node scripts/dsh-login.cjs [anthropic|openai]')
    process.exit(1)
  }

  console.log(`\n======================================================`)
  console.log(`🚀 ${title} Subscription OAuth Login`)
  console.log(`======================================================`)

  const controller = new AbortController()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  const interaction = {
    signal: controller.signal,
    notify(event) {
      if (event.type === 'auth_url') {
        console.log(`\n1. Launching login authorization URL in your default browser:`)
        console.log(`   ${event.url}\n`)
        exec(`open "${event.url}"`, err => {
          if (err) console.log('   (Could not auto-open browser, please click the link above)')
        })
        console.log('2. In your browser, log in and click "Authorize" / "Allow".')
        console.log('   Listening on local callback server for authorization response...\n')
      } else if (event.type === 'progress') {
        console.log(`⚡ ${event.message}`)
      } else if (event.message) {
        console.log(event.message)
      }
    },
    async prompt(request) {
      if (request.type === 'select') {
        // Auto-select browser login
        return 'browser'
      }
      return new Promise(resolve => {
        rl.question(`(Optional) Paste callback redirect URL or code here if browser did not auto-return: `, answer => {
          resolve(answer.trim())
        })
      })
    },
  }

  try {
    const grant = await oauthHandler.login(interaction)
    rl.close()
    if (grant) {
      saveGrant(recordKey, grant)
      console.log(`\n🎉 Success! Logged in with your ${title} subscription.`)
      console.log(`   Tokens are stored locally and will auto-refresh.\n`)
      process.exit(0)
    } else {
      console.error('\n❌ No grant returned from login.')
      process.exit(1)
    }
  } catch (err) {
    rl.close()
    console.error(`\n❌ Login failed:`, err.message)
    process.exit(1)
  }
}

const target = (process.argv[2] || '').toLowerCase()
if (!target) {
  console.log('Usage: node scripts/dsh-login.cjs [anthropic|openai]')
  process.exit(1)
}

runLogin(target)
