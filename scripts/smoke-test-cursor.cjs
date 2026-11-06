const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { CursorOverlayDaemon } = require('./cursor-overlay/driver.cjs')

const HELPER_BIN = path.join(__dirname, 'macos-input-helper')

function moveCursor(x, y) {
  const res = spawnSync(HELPER_BIN, ['move', String(Math.round(x)), String(Math.round(y))], { encoding: 'utf8' })
  if (res.error) throw res.error
}

function getCursor() {
  const res = spawnSync(HELPER_BIN, ['state'], { encoding: 'utf8' })
  if (res.error) throw res.error
  return JSON.parse(res.stdout)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function glideCursor(fromX, fromY, toX, toY, steps = 30, intervalMs = 15) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    // Smooth ease-in-out
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
    const curX = fromX + (toX - fromX) * ease
    const curY = fromY + (toY - fromY) * ease
    moveCursor(curX, curY)
    await sleep(intervalMs)
  }
}

async function run() {
  const initial = getCursor()
  console.log('INITIAL_STATE:', JSON.stringify(initial))

  const overlay = new CursorOverlayDaemon()
  console.log('STARTING_OVERLAY...')
  overlay.begin({ threadId: '3', threadTitle: 'Issue #3 verification' }, 'Moving mouse')
  await sleep(400) // allow window to initialize and map to screen

  const startX = initial.cursor.x
  const startY = initial.cursor.y

  // Step 1: Glide to Waypoint 1 (450, 350)
  console.log('STEP_1: Moving to (450, 350)...')
  await glideCursor(startX, startY, 450, 350)
  await sleep(1200)

  // Step 2: Glide to Waypoint 2 (960, 540)
  console.log('STEP_2: Moving to (960, 540)...')
  await glideCursor(450, 350, 960, 540)
  await sleep(1200)

  // Step 3: Glide to Waypoint 3 (1450, 650)
  console.log('STEP_3: Moving to (1450, 650)...')
  await glideCursor(960, 540, 1450, 650)
  await sleep(1200)

  // End overlay
  console.log('ENDING_OVERLAY (350ms fade-out begins)...')
  overlay.end()
  await sleep(600) // Allow 350ms fade-out to finish
  overlay.quit()

  const final = getCursor()
  console.log('FINAL_STATE:', JSON.stringify(final))
  console.log('SMOKE_TEST_COMPLETE')
}

run().catch(err => {
  console.error('ERROR:', err)
  process.exit(1)
})
