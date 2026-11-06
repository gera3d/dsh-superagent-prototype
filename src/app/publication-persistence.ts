/** Separate fs store: atomic fsync commits and one process-wide/cross-process deployment lock. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import lockfile from 'proper-lockfile'
import { PublicationError, type PublicationDocument, type PublicationPersistence } from './publication.ts'

/** Atomically committed fsync journal protected by an exclusive heartbeat lock across processes. */
export class FilePublicationPersistence implements PublicationPersistence {
  readonly path: string
  private busy = false
  private readonly compromisedListeners = new Set<(error: Error) => void>()
  onCompromised(listener: (error: Error) => void): () => void {
    this.compromisedListeners.add(listener)
    return () => { this.compromisedListeners.delete(listener) }
  }
  constructor(path: string) {
    this.path = resolve(path)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    // The dedicated lock target is never replaced by atomic document writes.
    const fd = openSync(`${this.path}.guard`, 'a', 0o600); closeSync(fd)
  }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new PublicationError(409, 'Another publication is in progress')
    this.busy = true
    let release: (() => Promise<void>) | undefined
    let compromised: Error | undefined
    try {
      try {
        release = await lockfile.lock(`${this.path}.guard`, { retries: 0, stale: 30_000, update: 5_000, onCompromised: error => { compromised = error; for (const listener of this.compromisedListeners) listener(error) } })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw new PublicationError(409, 'Another publication is in progress; interrupted locks expire after 30 seconds')
        throw error
      }
      this.checkLock = () => { if (compromised) throw new Error('Publication lock compromised; refusing durable operation', { cause: compromised }) }
      return await work()
    } finally {
      this.checkLock = () => { throw new Error('Publication persistence used outside exclusive lock') }
      try { await release?.() } finally { this.busy = false }
    }
  }
  private checkLock: () => void = () => { throw new Error('Publication persistence used outside exclusive lock') }
  load(): PublicationDocument {
    this.checkLock()
    return this.peek()
  }
  peek(): PublicationDocument {
    if (!existsSync(this.path)) return { version: 1, publications: {}, tickets: {} }
    const document = JSON.parse(readFileSync(this.path, 'utf8')) as PublicationDocument
    if (document.version !== 1 || !document.publications || !document.tickets) throw new Error('Invalid publication document; refusing recovery')
    return document
  }
  save(document: PublicationDocument): void {
    this.checkLock()
    const temporary = `${this.path}.tmp`
    const fd = openSync(temporary, 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify(document)); fsyncSync(fd) } finally { closeSync(fd) }
    this.checkLock()
    renameSync(temporary, this.path)
    const directory = openSync(dirname(this.path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}
