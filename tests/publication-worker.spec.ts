import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import ts from 'typescript'
import { FilePublicationPersistence } from '../src/app/publication-persistence.ts'
import { PublicationService, type PublicationAdapter, type PublicationAuthority, type PublicationSnapshot, type PublicationStage } from '../src/app/publication.ts'
import { PublicationCoordinator, runPublicationWorker } from '../src/app/publication-worker.ts'
import { publicationProcessIdentity } from '../src/app/publication-process.ts'

const directories: string[] = [], children: ChildProcess[] = [], workers = new Set<number>()
afterEach(() => {
  for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  for (const pid of workers) { try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ } }
  workers.clear()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const pins = { ticketId: 'ticket', conversationId: 'worker-ticket:decision:canonical', repository: 'owner/repo', prNumber: 159, headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64) }
const manifest = 'c'.repeat(64)
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'publication-worker-')); directories.push(stateDir)
  const store = new FilePublicationPersistence(join(stateDir, 'publication-state.json'))
  const calls: PublicationStage[] = [], launches: string[] = []
  let state: 'open' | 'merged' = 'open'
  const adapter: PublicationAdapter = {
    evidence: async () => ({ ...pins, observedAt: new Date().toISOString(), checks: 'passed', review: 'approved', mergeable: true, state }),
    perform: async stage => { calls.push(stage); if (stage === 'merge') state = 'merged'; return { detail: stage } },
  }
  const service = new PublicationService({ store, adapter })
  const coordinator = new PublicationCoordinator({ stateDir, store, service, manifestSha256: manifest, launch: async id => { launches.push(id) }, captureBinding: p => ({ conversationId: p.conversationId }) })
  const authority = (p: PublicationSnapshot, action: 'publish' | 'rollback' = 'publish'): PublicationAuthority => ({ kind: 'human_click', actorId: 'operator', authorized: true, ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, action, isCurrent: () => true })
  const input = (p: PublicationSnapshot, requestId = 'click', action: 'publish' | 'rollback' = 'publish') => ({ ticketId: p.ticketId, conversationId: p.conversationId, publicationId: p.id, requestId, action })
  const run = (grantId: string, overrides: Partial<Parameters<typeof runPublicationWorker>[0]> = {}) => runPublicationWorker({ stateDir, grantId, store, adapter, manifestSha256: manifest, isCurrent: (g, p) => (g.ticketBinding as { conversationId: string }).conversationId === p.conversationId, ...overrides })
  return { stateDir, store, adapter, service, coordinator, authority, input, run, calls, launches }
}

describe('durable detached publication handoff', () => {
  it('only queues exact explicit authority in host; consumes grant once and records every outcome', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await expect(f.coordinator.enqueue(f.input(p), { ...f.authority(p), authorized: false } as unknown as PublicationAuthority)).rejects.toMatchObject({ status: 403 })
    const queued = await f.coordinator.enqueue(f.input(p), f.authority(p))
    expect(queued.coordination?.status).toBe('queued'); expect(f.calls).toEqual([]); expect(f.launches).toHaveLength(1)
    await f.coordinator.enqueue(f.input(p), f.authority(p)); expect(f.launches).toHaveLength(1)
    await expect(f.service.act({ ...f.input(p), action: 'merge' }, { ...f.authority(p), action: 'merge' })).rejects.toMatchObject({ status: 409 })
    await f.run(f.launches[0]!)
    const result = await f.coordinator.snapshot(p.ticketId)
    expect(result?.status).toBe('published'); expect(result?.coordination?.status).toBe('completed')
    expect(f.calls).toEqual(['merge', 'apply', 'build', 'restart', 'verify'])
    await f.run(f.launches[0]!); await f.coordinator.enqueue(f.input(p), f.authority(p))
    expect(f.calls).toHaveLength(5); expect(f.launches).toHaveLength(1)
  })
  it('persists exact operator instruction proof and rejects changed proof under the same request', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    const authority: PublicationAuthority = { ...f.authority(p), kind: 'operator_instruction', sourceProof: { recordPath: '/private/instruction.json', recordSha256: 'd'.repeat(64), reference: 'trigger:explicit-human', instruction: 'Publish this exact reviewed publication under my operator instruction.' } }
    await f.coordinator.enqueue(f.input(p), authority)
    const grant = f.store.peek().workerGrants![f.launches[0]!]!
    expect(grant.sourceProof).toEqual(authority.sourceProof)
    expect(f.store.peek().publications[p.id]?.audit.at(-1)?.detail).toContain('d'.repeat(64))
    await expect(f.coordinator.enqueue(f.input(p), { ...authority, sourceProof: { ...authority.sourceProof!, recordSha256: 'e'.repeat(64) } })).rejects.toMatchObject({ status: 409 })
    expect(f.calls).toEqual([])
  })
  it('rejects changed manifest, expired queued grants and wrong canonical binding without effects', async () => {
    for (const failure of ['manifest', 'expiry', 'binding'] as const) {
      const f = fixture(), p = await f.service.prepare(pins)
      await f.coordinator.enqueue(f.input(p), f.authority(p))
      const grantId = f.launches[0]!
      if (failure === 'expiry') await f.store.exclusive(async () => { const d = f.store.load(); d.workerGrants![grantId]!.expiresAt = new Date(0).toISOString(); f.store.save(d) })
      await f.run(grantId, failure === 'manifest' ? { manifestSha256: 'd'.repeat(64) } : failure === 'binding' ? { isCurrent: () => false } : {})
      expect(f.calls).toEqual([])
      const result = await f.service.snapshot(p.ticketId)
      expect(result?.coordination?.status).toBe(failure === 'expiry' ? 'expired' : failure === 'manifest' ? 'failed' : 'completed')
      if (failure === 'binding') expect(result?.status).toBe('blocked')
    }
  })
  it('quarantines consumed interrupted grants including rollback until explicit operator settlement', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await f.coordinator.enqueue(f.input(p), f.authority(p))
    const id = f.launches[0]!
    await f.store.exclusive(async () => {
      const d = f.store.load(), g = d.workerGrants![id]!, saved = d.publications[p.id]!
      g.status = 'running'; g.ownerPid = undefined
      saved.outcomes.push({ stage: 'apply', operationId: `${p.id}:apply`, status: 'running', startedAt: new Date().toISOString() })
      f.store.save(d)
    })
    expect((await f.coordinator.snapshot(p.ticketId))?.coordination?.status).toBe('interrupted')
    await expect(f.coordinator.enqueue(f.input(p, 'rollback', 'rollback'), f.authority(p, 'rollback'))).rejects.toMatchObject({ status: 409 })
    await expect(f.service.act({ ...f.input(p, 'direct-rollback', 'rollback') }, f.authority(p, 'rollback'))).rejects.toMatchObject({ status: 409 })
    await expect(f.coordinator.acknowledgeInterruption(id, f.authority(p, 'rollback'), { processesSettled: true, detail: 'Fixture confirms no subprocesses exist' })).rejects.toMatchObject({ status: 403 })
    await f.store.exclusive(async () => { const d = f.store.load(); d.workerGrants![id]!.ownerPid = process.pid; d.workerGrants![id]!.ownerIdentity = publicationProcessIdentity(process.pid); f.store.save(d) })
    await expect(f.coordinator.acknowledgeInterruption(id, { ...f.authority(p, 'rollback'), kind: 'operator_instruction' }, { processesSettled: true, detail: 'Fixture confirms no subprocesses exist' })).rejects.toMatchObject({ status: 409 })
    await f.store.exclusive(async () => { const d = f.store.load(); d.workerGrants![id]!.ownerIdentity = 'different-start-identity'; f.store.save(d) })
    await f.coordinator.acknowledgeInterruption(id, { ...f.authority(p, 'rollback'), kind: 'operator_instruction' }, { processesSettled: true, detail: 'Fixture confirms no subprocesses exist' })
    await f.coordinator.enqueue(f.input(p, 'recovery', 'rollback'), f.authority(p, 'rollback'))
    await f.run(f.launches.at(-1)!)
    expect((await f.service.snapshot(p.ticketId))?.status).toBe('rolled_back'); expect(f.calls).toEqual(['rollback'])
  })
  it('journals subprocess groups before effects and marks them settled after adapter cleanup', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await f.coordinator.enqueue(f.input(p), f.authority(p))
    f.adapter.perform = async (stage, _pins, _id, _signal, onSpawn) => {
      onSpawn?.(process.pid)
      const d = f.store.peek(), grant = d.workerGrants![f.launches[0]!]!
      expect(grant.processGroups?.at(-1)).toMatchObject({ pid: process.pid, stage })
      expect(grant.processGroups?.at(-1)?.startIdentity).toBeTruthy()
      expect(grant.processGroups?.at(-1)?.settledAt).toBeUndefined()
      f.calls.push(stage)
      return { detail: stage }
    }
    // Start merged so the fixture's no-op merge implementation cannot affect repository state.
    f.adapter.evidence = async () => ({ ...pins, observedAt: new Date().toISOString(), checks: 'passed', review: 'approved', mergeable: true, state: 'merged' })
    await f.store.exclusive(async () => { const d = f.store.load(); d.publications[p.id]!.evidence!.state = 'merged'; f.store.save(d) })
    await f.run(f.launches[0]!)
    const grant = f.store.peek().workerGrants![f.launches[0]!]!
    expect(grant.processGroups).toHaveLength(4); expect(grant.processGroups?.every(group => !!group.settledAt)).toBe(true)
    expect(grant.settledAt).toBeTruthy()
  })
  it('settles in-flight adapter cancellation before releasing the external execution lock', async () => {
    const f = fixture(), p = await f.service.prepare(pins)
    await f.coordinator.enqueue(f.input(p), f.authority(p))
    let compromise!: (error: Error) => void, entered!: () => void, cleaned = false
    const enteredPromise = new Promise<void>(r => { entered = r })
    f.store.onCompromised = listener => { compromise = listener; return () => {} }
    f.adapter.perform = async (_stage, _pins, _id, signal) => {
      entered()
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => {
        setTimeout(() => { cleaned = true; reject(new Error('fixture process tree settled')) }, 20)
      }, { once: true }))
      return { detail: 'unreachable' }
    }
    const running = f.run(f.launches[0]!)
    await enteredPromise; compromise(new Error('fixture lock compromised'))
    await expect(running).rejects.toThrow('fixture lock compromised')
    expect(cleaned).toBe(true)
    expect((await f.service.snapshot(p.ticketId))?.coordination?.status).toBe('interrupted')
  })
  it('a real detached coordinator survives replacement of its original hosting process and verifies afterward', async () => {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'publication-host-restart-'))); directories.push(stateDir)
    const require = createRequire(import.meta.url), lockfileUrl = pathToFileURL(require.resolve('proper-lockfile')).href
    writeFileSync(join(stateDir, 'package.json'), '{"type":"module"}')
    for (const name of ['publication', 'publication-persistence', 'publication-worker', 'publication-process']) {
      const source = readFileSync(resolve(`src/app/${name}.ts`), 'utf8')
      const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true } }).outputText.replaceAll("'proper-lockfile'", JSON.stringify(lockfileUrl))
      writeFileSync(join(stateDir, `${name}.js`), output)
    }
    const shared = `
      import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      import {PublicationService} from './publication.js';
      import {FilePublicationPersistence} from './publication-persistence.js';
      const stateDir=process.argv[2]; const pins=${JSON.stringify(pins)};
      const store=new FilePublicationPersistence(join(stateDir,'publication-state.json'));
      const adapter={
        evidence:async()=>({...pins,observedAt:new Date().toISOString(),checks:'passed',review:'approved',mergeable:true,state:readFileSync(join(stateDir,'pr-state'),'utf8')}),
        perform:async(stage)=>{
          appendFileSync(join(stateDir,'stages'),stage+'\\n');
          if(stage==='merge')writeFileSync(join(stateDir,'pr-state'),'merged');
          if(stage==='restart')process.kill(Number(readFileSync(join(stateDir,'host-pid'),'utf8')),'SIGTERM');
          if(stage==='verify'){
            await new Promise(r=>setTimeout(r,100));
            try{process.kill(Number(readFileSync(join(stateDir,'host-pid'),'utf8')),0);throw new Error('original host still alive')}catch(e){if(e.code!=='ESRCH')throw e}
            writeFileSync(join(stateDir,'verified'),'verified after host exit');
          }
          return {detail:stage+' fixture only'};
        }
      };`
    writeFileSync(join(stateDir, 'fixture-worker.mjs'), `${shared}
      import {runPublicationWorker} from './publication-worker.js';
      await runPublicationWorker({stateDir,grantId:process.argv[3],store,adapter,manifestSha256:${JSON.stringify(manifest)},isCurrent:()=>true});`)
    writeFileSync(join(stateDir, 'fixture-host.mjs'), `${shared}
      import {PublicationCoordinator} from './publication-worker.js';
      writeFileSync(join(stateDir,'host-pid'),String(process.pid));
      const service=new PublicationService({store,adapter});const p=await service.prepare(pins);
      const coordinator=new PublicationCoordinator({stateDir,entryPath:join(stateDir,'fixture-worker.mjs'),store,service,manifestSha256:${JSON.stringify(manifest)},captureBinding:()=>({fixture:true})});
      await coordinator.enqueue({ticketId:p.ticketId,conversationId:p.conversationId,publicationId:p.id,requestId:'real-click',action:'publish'},
        {kind:'human_click',actorId:'fixture-operator',authorized:true,ticketId:p.ticketId,conversationId:p.conversationId,publicationId:p.id,action:'publish'});
      setInterval(()=>{},1000);`)
    writeFileSync(join(stateDir, 'pr-state'), 'open')
    const host = spawn(process.execPath, [join(stateDir, 'fixture-host.mjs'), stateDir], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(host)
    let stderr = ''; host.stderr?.on('data', data => { stderr += data })
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => host.once('exit', (code, signal) => r({ code, signal })))
    await vi.waitFor(() => {
      expect(existsSync(join(stateDir, 'publication-state.json')), stderr).toBe(true)
      const d = JSON.parse(readFileSync(join(stateDir, 'publication-state.json'), 'utf8'))
      for (const grant of Object.values(d.workerGrants ?? {}) as { ownerPid?: number }[]) if (grant.ownerPid) workers.add(grant.ownerPid)
      expect(existsSync(join(stateDir, 'verified')), stderr).toBe(true)
    }, { timeout: 15_000, interval: 50 })
    expect((await exit).signal).toBe('SIGTERM')
    // A replacement host opens the same durable store, independently of the old process and worker.
    const replacementStore = new FilePublicationPersistence(join(stateDir, 'publication-state.json'))
    await vi.waitFor(() => {
      const p = Object.values(replacementStore.peek().publications)[0]
      expect(p?.status).toBe('published'); expect(p?.coordination?.status).toBe('completed')
    }, { timeout: 5000, interval: 50 })
    expect(readFileSync(join(stateDir, 'stages'), 'utf8').trim().split('\n')).toEqual(['merge', 'apply', 'build', 'restart', 'verify'])
  }, 25_000)
})
