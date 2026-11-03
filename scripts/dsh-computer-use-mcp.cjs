#!/usr/bin/env node
/**
 * Unified OS Computer Use Model Context Protocol (MCP) Server.
 * Exposes macOS display inspection, mouse, and keyboard automation
 * to DeepSeek Harness (DSH) and vision-capable LLMs.
 */

const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

// Repo-owned activity overlay. Presentation failures never block desktop tools.
const { CursorOverlayDaemon, identityFromMeta, serializeActions } = require('./cursor-overlay/driver.cjs')
const overlay = new CursorOverlayDaemon()
const desktopQueue = serializeActions()
const activityNames = {
  computer_mouse_click: 'Clicking', computer_mouse_move: 'Moving mouse',
  computer_mouse_drag: 'Dragging', computer_mouse_scroll: 'Scrolling',
  computer_type_text: 'Typing', computer_key_press: 'Pressing key',
  computer_hotkey: 'Using shortcut', computer_focus_window: 'Focusing window',
}
async function executeTool(name, args, meta) {
  return desktopQueue(async () => {
    const status = activityNames[name] || (name === 'computer' && !['screenshot', 'cursor_position'].includes(args.action) ? 'Using computer' : null)
    if (status) {
      try { overlay.begin(identityFromMeta(meta), status) } catch (error) { console.error('Cursor overlay:', error.message) }
    }
    try { return await handleToolCall(name, args) }
    finally { if (status) { try { overlay.end() } catch {} } }
  })
}

const HELPER_BIN = path.join(__dirname, 'macos-input-helper')
const SWIFT_SRC = path.join(__dirname, 'macos-input-helper.swift')

function ensureHelper() {
  if (!fs.existsSync(HELPER_BIN) && fs.existsSync(SWIFT_SRC)) {
    try {
      execFileSync('swiftc', ['-O', SWIFT_SRC, '-o', HELPER_BIN], { stdio: 'ignore' })
    } catch (err) {
      console.error('Failed to compile macos-input-helper:', err.message)
    }
  }
}

function runHelper(args) {
  ensureHelper()
  try {
    const stdout = execFileSync(HELPER_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(stdout.trim() || '{}')
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : err.message
    throw new Error(stderr.trim() || `macos-input-helper failed with exit code ${err.status}`)
  }
}

const TOOLS = [
  {
    name: 'computer_screenshot',
    description: 'Capture a screenshot of the entire macOS desktop display, returning base64 image data and logical/physical dimension metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        scaleDown: {
          type: 'number',
          description: 'Optional factor to downsample screenshot (default: 1.0)',
          default: 1.0
        }
      }
    }
  },
  {
    name: 'computer_mouse_click',
    description: 'Move mouse cursor to logical coordinates (x, y) and click.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Logical horizontal coordinate (0 is left)' },
        y: { type: 'number', description: 'Logical vertical coordinate (0 is top)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        clickCount: { type: 'integer', description: 'Number of clicks: 1=single, 2=double, 3=triple', default: 1 }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'computer_mouse_move',
    description: 'Move mouse cursor to logical coordinates (x, y) without clicking.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Logical horizontal coordinate' },
        y: { type: 'number', description: 'Logical vertical coordinate' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'computer_mouse_drag',
    description: 'Click and drag from (startX, startY) to (endX, endY).',
    inputSchema: {
      type: 'object',
      properties: {
        startX: { type: 'number' },
        startY: { type: 'number' },
        endX: { type: 'number' },
        endY: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right'], default: 'left' }
      },
      required: ['startX', 'startY', 'endX', 'endY']
    }
  },
  {
    name: 'computer_mouse_scroll',
    description: 'Dispatch mouse scroll wheel event at coordinates (x, y).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        deltaX: { type: 'number', description: 'Horizontal scroll amount (positive is right, negative is left)', default: 0 },
        deltaY: { type: 'number', description: 'Vertical scroll amount (positive is down, negative is up)', default: 0 }
      },
      required: ['x', 'y', 'deltaY']
    }
  },
  {
    name: 'computer_type_text',
    description: 'Type text into the currently active/focused window.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text string to type' }
      },
      required: ['text']
    }
  },
  {
    name: 'computer_key_press',
    description: 'Press a single key or key chord with modifier keys (e.g. Return, Escape, Tab, Cmd+C).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name (e.g. return, enter, tab, space, escape, backspace, left, right, a..z, 0..9)' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['cmd', 'shift', 'alt', 'ctrl'] },
          description: 'Optional modifier keys'
        }
      },
      required: ['key']
    }
  },
  {
    name: 'computer_hotkey',
    description: 'Execute a hotkey combination (e.g. ["cmd", "shift", "p"]).',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keys in sequence or chord, e.g. ["cmd", "space"]'
        }
      },
      required: ['keys']
    }
  },
  {
    name: 'computer_list_windows',
    description: 'List visible desktop application windows with window ID, title, app name, and bounds.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'computer_focus_window',
    description: 'Bring an application window to the foreground by app name.',
    inputSchema: {
      type: 'object',
      properties: {
        appName: { type: 'string', description: 'Application name (e.g. "Google Chrome", "Visual Studio Code", "Finder")' }
      },
      required: ['appName']
    }
  },
  {
    name: 'computer_get_cursor',
    description: 'Get current mouse cursor position and display metrics.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'computer_check_permissions',
    description: 'Check macOS Accessibility and Screen Recording permissions status.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // Vendor-compatibility: Anthropic "computer" tool definition
  {
    name: 'computer',
    description: 'Anthropic Computer Use API compatible tool interface.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'screenshot', 'mouse_move', 'left_click', 'right_click', 'middle_click',
            'double_click', 'triple_click', 'left_click_drag', 'mouse_scroll',
            'type', 'key', 'cursor_position'
          ]
        },
        coordinate: { type: 'array', items: { type: 'number' } },
        text: { type: 'string' },
        delta_x: { type: 'number' },
        delta_y: { type: 'number' }
      },
      required: ['action']
    }
  }
]

async function handleToolCall(name, args) {
  // Map Anthropic action to standard handler
  if (name === 'computer') {
    const action = args.action
    if (action === 'screenshot') return handleToolCall('computer_screenshot', {})
    if (action === 'cursor_position') return handleToolCall('computer_get_cursor', {})
    if (action === 'type') return handleToolCall('computer_type_text', { text: args.text })
    if (action === 'key') return handleToolCall('computer_key_press', { key: args.text })
    if (action === 'mouse_move' && args.coordinate) {
      return handleToolCall('computer_mouse_move', { x: args.coordinate[0], y: args.coordinate[1] })
    }
    if (action === 'left_click' && args.coordinate) {
      return handleToolCall('computer_mouse_click', { x: args.coordinate[0], y: args.coordinate[1], button: 'left', clickCount: 1 })
    }
    if (action === 'right_click' && args.coordinate) {
      return handleToolCall('computer_mouse_click', { x: args.coordinate[0], y: args.coordinate[1], button: 'right', clickCount: 1 })
    }
    if (action === 'middle_click' && args.coordinate) {
      return handleToolCall('computer_mouse_click', { x: args.coordinate[0], y: args.coordinate[1], button: 'middle', clickCount: 1 })
    }
    if (action === 'double_click' && args.coordinate) {
      return handleToolCall('computer_mouse_click', { x: args.coordinate[0], y: args.coordinate[1], button: 'left', clickCount: 2 })
    }
    if (action === 'triple_click' && args.coordinate) {
      return handleToolCall('computer_mouse_click', { x: args.coordinate[0], y: args.coordinate[1], button: 'left', clickCount: 3 })
    }
    if (action === 'mouse_scroll' && args.coordinate) {
      return handleToolCall('computer_mouse_scroll', { x: args.coordinate[0], y: args.coordinate[1], deltaX: args.delta_x || 0, deltaY: args.delta_y || 0 })
    }
    throw new Error(`Unsupported Anthropic action: ${action}`)
  }

  switch (name) {
    case 'computer_screenshot': {
      const state = runHelper(['state'])
      const tmpFile = path.join(os.tmpdir(), `dsh_screen_${Date.now()}_${Math.random().toString(36).slice(2)}.png`)
      try {
        execFileSync('/usr/sbin/screencapture', ['-x', tmpFile])
        const buf = fs.readFileSync(tmpFile)
        const base64 = buf.toString('base64')
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                screen: state.screen,
                cursor: state.cursor,
                imageFormat: 'png',
                bytes: buf.length
              }, null, 2)
            },
            {
              type: 'image',
              data: base64,
              mimeType: 'image/png'
            }
          ]
        }
      } finally {
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile) } catch {}
      }
    }

    case 'computer_mouse_click': {
      const { x, y, button = 'left', clickCount = 1 } = args
      const res = runHelper(['click', String(x), String(y), button, String(clickCount)])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_mouse_move': {
      const { x, y } = args
      const res = runHelper(['move', String(x), String(y)])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_mouse_drag': {
      const { startX, startY, endX, endY, button = 'left' } = args
      const res = runHelper(['drag', String(startX), String(startY), String(endX), String(endY), button])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_mouse_scroll': {
      const { x, y, deltaX = 0, deltaY = 0 } = args
      const res = runHelper(['scroll', String(x), String(y), String(deltaX), String(deltaY)])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_type_text': {
      const { text } = args
      const res = runHelper(['type', text])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_key_press': {
      const { key, modifiers = [] } = args
      const modsStr = modifiers.join(',')
      const res = runHelper(['key', key, modsStr])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_hotkey': {
      const { keys } = args
      if (!keys || !keys.length) throw new Error('keys array cannot be empty')
      const mainKey = keys[keys.length - 1]
      const modifiers = keys.slice(0, keys.length - 1)
      const res = runHelper(['key', mainKey, modifiers.join(',')])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_list_windows': {
      const res = runHelper(['windows'])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_focus_window': {
      const { appName } = args
      const res = runHelper(['focus', appName])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_get_cursor': {
      const res = runHelper(['state'])
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
      }
    }

    case 'computer_check_permissions': {
      const res = runHelper(['state'])
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            accessibilityTrusted: res.accessibility,
            screenCaptureReady: true,
            display: res.screen
          }, null, 2)
        }]
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// JSON-RPC stdio protocol loop
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', async (line) => {
  line = line.trim()
  if (!line) return

  let request
  try {
    request = JSON.parse(line)
  } catch (err) {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }

  const { id, method, params } = request

  // Handle notifications (no id)
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      // client initialized notification
    }
    return
  }

  try {
    switch (method) {
      case 'initialize': {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: 'dsh-computer-use',
              version: '0.1.0'
            }
          }
        })
        break
      }

      case 'tools/list': {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS
          }
        })
        break
      }

      case 'tools/call': {
        const { name, arguments: args = {}, _meta } = params || {}
        try {
          const result = await executeTool(name, args, _meta)
          send({
            jsonrpc: '2.0',
            id,
            result
          })
        } catch (callErr) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `Tool error (${name}): ${callErr.message}` }]
            }
          })
        }
        break
      }

      default:
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        })
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: `Internal error: ${err.message}` }
    })
  }
})

process.on('SIGTERM', () => { overlay.quit(); process.exit(0) })
process.on('SIGINT', () => { overlay.quit(); process.exit(0) })
rl.on('close', () => overlay.quit())
