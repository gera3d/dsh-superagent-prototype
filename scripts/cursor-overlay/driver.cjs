const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

class CursorOverlayDaemon {
  constructor({ spawnProcess = spawn, compile = execFileSync } = {}) {
    this.process = null
    this.spawnProcess = spawnProcess
    this.compile = compile
  }
  ensureRunning() {
    if (this.process && !this.process.killed) return
    const source = path.join(__dirname, 'main.swift')
    const binary = path.join(__dirname, 'overlay')
    if (!fs.existsSync(binary) || fs.statSync(source).mtimeMs > fs.statSync(binary).mtimeMs) {
      this.compile('swiftc', ['-O', source, '-o', binary], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 })
    }
    const child = this.spawnProcess(binary, ['--ipc'], { stdio: ['pipe', 'ignore', 'inherit'] })
    this.process = child
    child.on('exit', () => { if (this.process === child) this.process = null })
    child.on('error', () => { if (this.process === child) this.process = null })
    child.stdin.on('error', () => {})
  }
  send(command) {
    this.ensureRunning()
    this.process.stdin.write(JSON.stringify(command) + '\n')
  }
  begin(identity, status) { this.send({ action: 'begin', ...identity, status }) }
  end() { if (this.process) this.send({ action: 'end' }) }
  quit() { if (this.process) { this.process.stdin.end(); this.process = null } }
}

// Per-call identity, never process-global or supplied in model tool arguments.
function identityFromMeta(meta) {
  const caller = meta?.['dev.dsh/computer-caller']
  const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180) : undefined
  return { threadId: clean(caller?.threadId), threadTitle: clean(caller?.threadTitle) }
}

// FIFO for the shared desktop. Failure must release the next queued request.
function serializeActions() {
  let tail = Promise.resolve()
  return action => {
    const result = tail.then(action)
    tail = result.catch(() => {})
    return result
  }
}
module.exports = { CursorOverlayDaemon, identityFromMeta, serializeActions }
