const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const { CursorOverlayDaemon, identityFromMeta, serializeActions } = require('./driver.cjs')

test('identity comes only from namespaced caller metadata', () => {
  assert.deepEqual(identityFromMeta({ threadTitle: 'fake' }), { threadId: undefined, threadTitle: undefined })
  assert.deepEqual(identityFromMeta({ 'dev.dsh/computer-caller': { threadId: '123', threadTitle: 'Gmail\nTest' } }), { threadId: '123', threadTitle: 'Gmail Test' })
  assert.equal(identityFromMeta({ 'dev.dsh/computer-caller': { threadTitle: 5 } }).threadTitle, undefined)
})

test('desktop queue is FIFO and releases after failure', async () => {
  const enqueue = serializeActions()
  const events = []
  let release
  const wait = new Promise(resolve => { release = resolve })
  const a = enqueue(async () => { events.push('a'); await wait; throw new Error('expected') })
  const b = enqueue(async () => { events.push('b'); return 2 })
  await Promise.resolve()
  assert.deepEqual(events, ['a'])
  release()
  await assert.rejects(a, /expected/)
  assert.equal(await b, 2)
  assert.deepEqual(events, ['a', 'b'])
})

test('driver sends action ownership and completion, and closes stdin', () => {
  const child = new EventEmitter()
  const messages = []
  child.stdin = new EventEmitter()
  child.stdin.write = line => messages.push(JSON.parse(line))
  let closed = false
  child.stdin.end = () => { closed = true }
  const driver = new CursorOverlayDaemon()
  driver.ensureRunning = () => { driver.process = child }
  driver.begin({ threadId: 'abc', threadTitle: 'Gmail test' }, 'Clicking')
  driver.end()
  driver.quit()
  assert.deepEqual(messages, [{ action: 'begin', threadId: 'abc', threadTitle: 'Gmail test', status: 'Clicking' }, { action: 'end' }])
  assert.ok(closed)
})

test('native view tracks real logical cursor, starts hidden and fades', () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, 'main.swift'), 'utf8')
  assert.match(source, /NSEvent.mouseLocation/)
  assert.match(source, /panel.alphaValue = 0/)
  assert.match(source, /remaining \/ 0.35/)
  assert.match(source, /Thread unavailable/)
  assert.match(source, /NSApp.terminate\(nil\)/)
  assert.doesNotMatch(source, /CGEvent\(|NSCursor.hide|post\(tap:/)
})
