import {it,expect,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Store} from '../src/app/store.ts'
import {FindingRuntime} from '../src/app/finding-runtime.ts'
import {Engine} from '../src/core/engine.ts'
import {key} from '../src/core/index.ts'
it('real delegated retry dispatch preserves coordinator identity and never becomes a fresh human approval',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'headless-provenance-'));const store=new Store(join(dir,'db.sqlite'))
 const engine=new Engine({repo:store,policy:()=>({version:'p1',paused:false}),executor:{start:vi.fn(),deliver:vi.fn(),stop:vi.fn()}} as any)
 store.saveSettings({executor:{model:{provider:'configured',model:'executor'},maxWorkers:1}})
 const runtime=new FindingRuntime({store,engine,ctx:{get:vi.fn(),llm:{}} as any,commands:{gh:vi.fn()} as any,lifetime:new AbortController().signal})
 try{
 const f=runtime.store.observe({dedupKey:'delegated',title:'Bounded repair',problem:'Audit provenance',scope:'Same approved repair only',owner:'coordinator',kind:'fix',requirements:['Preserve exact identity'],repository:'org/repo',occurrence:{id:'one',reference:'test',evidence:'isolated'}})
 runtime.store.confirm(f.id,{revision:f.revision,choiceId:'fix_now'},'local-operator');await runtime.request()
 const running=runtime.store.get(f.id)!;runtime.store.markReview(f.id,{reference:'isolated-review',summary:'Needs correction',recordedAt:new Date().toISOString(),state:'blocked'})
 const blocked=runtime.store.get(f.id)!;const reopened=runtime.review(f.id,{revision:blocked.revision,decision:'retry_scope'},'codex-coordinator')
 runtime.store.confirm(f.id,{revision:reopened.revision,choiceId:'fix_now'},'codex-coordinator',true);await runtime.request()
 const next=runtime.store.get(f.id)!;const ticket=store.tickets.get(next.job!.ticketId!)!;const trigger=store.triggers.get(key('finding-trigger',next.job!.id))!
 expect({confirmActor:next.confirmation?.actor,dispatchActor:next.audit.filter(x=>x.event==='dispatched').at(-1)?.actor,mandateActor:ticket.mandate.actor.id,triggerActor:trigger.actor.id,human:trigger.human}).toEqual({confirmActor:'codex-coordinator',dispatchActor:'codex-coordinator',mandateActor:'codex-coordinator',triggerActor:'codex-coordinator',human:false})
 }finally{await runtime.stop();store.close();rmSync(dir,{recursive:true,force:true})}
})
