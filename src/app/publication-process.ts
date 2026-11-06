/** Read-only OS process identity fencing. Never signals or kills a process based on a recyclable PID. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Linux boot/start ticks, otherwise fixed ps start-time evidence; undefined means identity is unknown. */
export function publicationProcessIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      if (!startTicks || !/^\d+$/.test(startTicks) || !boot) return undefined
      return `linux:${boot}:${startTicks}`
    }
    const start = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
    }).trim().replace(/\s+/g, ' ')
    return start ? `ps-lstart:${start}` : undefined
  } catch { return undefined }
}

/** Unknown identity is fail-closed; a different observed identity proves the PID is not the original owner. */
export function publicationProcessState(pid: number | undefined, expectedIdentity: string | undefined,
  inspect: (pid: number) => string | undefined = publicationProcessIdentity,
  exists: (pid: number) => boolean = pid => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' } },
): 'same' | 'different' | 'absent' | 'unknown' {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return 'absent'
  if (!exists(pid)) return 'absent'
  if (!expectedIdentity) return 'unknown'
  const actual = inspect(pid)
  return actual === undefined ? 'unknown' : actual === expectedIdentity ? 'same' : 'different'
}
