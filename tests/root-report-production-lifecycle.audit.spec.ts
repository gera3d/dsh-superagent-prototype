import {it,expect,vi} from 'vitest'
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {Store} from '../src/app/store.ts'
import {Engine} from '../src/core/engine.ts'
import {DshExecutor,currentTurnOf} from '../src/executor/dsh.ts'
import {writeEnvironment,workerBin} from '../src/infra/environment.ts'
import {ticketEnvironment} from '../src/app/execution-environment.ts'
import {testDeployment} from './fixtures/deployment.ts'
const exec=promisify(execFile)
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'native-report-life-'));const work=join(dir,'work');mkdirSync(work)
 const deployment=testDeployment({stateDir:dir});await writeEnvironment(deployment,[])
 let store:Store;let engine:Engine;let executor:DshExecutor;let report:any;let crash=false
 const assignmentInput={jobId:'finding:root:r1',findingId:'root',title:'Bounded report test',scope:'Report-only isolated test',repository:'org/repo',text:'Isolated approved test'}
 const agent={id:'worker',status:'idle',whenIdle:async()=>{},session:{snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}]}}
 function open(){
  store=new Store(join(dir,'state.sqlite'));store.saveSettings({executor:{model:{provider:'configured',model:'executor'},maxWorkers:1}})
  engine=new Engine({repo:store,policy:()=>({version:'p1',paused:false}),executor:{start:vi.fn(),deliver:vi.fn(),stop:vi.fn()}} as any)
  let ticket=engine.dispatchFinding(assignmentInput)
  if(!ticket.execution?.directory){ticket={...ticket,execution:{name:'root',directory:work,text:'Bounded test'}} as any;store.tickets.save(ticket)}
  if(ticket.assignments.at(-1)?.state!=='running')engine.assignmentStarted(ticket.id,ticket.assignments.at(-1)!.id)
  report=vi.spyOn(engine,'report')
  const hostStore={tickets:store.tickets,triggers:store.triggers,settings:()=>store.settings(),set:store.set.bind(store),afterCommit:store.afterCommit.bind(store),atomic:(fn:any)=>{const result=store.atomic(fn);if(crash&&store.tickets.get(ticket.id)?.assignments.at(-1)?.report?.summary==='partialcrash'){crash=false;throw new Error('simulated crash after durable native commit, before cleanup')}return result}}
  executor=new DshExecutor({store:hostStore,engine,context:{get:()=>undefined},effects:{handle:()=>{},enqueue:()=>{}},sessions:{relay:()=>{},prompt:async()=>{}},health:{get:()=>undefined,set:()=>{}},machine:{stateDir:dir},lifetime:new AbortController().signal,closing:()=>false,paused:()=>false,environment:()=>[]} as any)
  return ticket.id
 }
 const ticketId=open()
 async function produce(state:string,summary:string){const ticket=store.tickets.get(ticketId)!;const vars=ticketEnvironment({deployment,sources:{environments:()=>[]} as any,settings:store.settings(),ticket,turn:currentTurnOf(agent as any)});const env={PATH:process.env.PATH,...Object.fromEntries(vars.map(v=>[v.key,v.value]))};await exec(join(workerBin(dir),'orchestrator_report'),['--state',state,'--summary',summary],{env})}
 async function idle(){const t=store.tickets.get(ticketId)!;await (executor as any).workerIdle(t,t.assignments.at(-1),agent)}
 return {produce,idle,report:()=>report,ticket:()=>store.tickets.get(ticketId)!,work,crashAfterCommit:()=>{crash=true},reopen:()=>{executor.dispose();store.close();open()},close:()=>{executor.dispose();store.close();rmSync(dir,{recursive:true,force:true})}}
}
it('actual generated shim and idle consumer persist native progress then ready on the same current turn',async()=>{
 const h=await fixture();try{await h.produce('progress','partial');await h.idle();expect(h.ticket().assignments.at(-1)?.report?.state).toBe('progress');await h.produce('ready','complete');await h.idle();expect(h.ticket().assignments.at(-1)?.report?.state).toBe('ready');expect(h.ticket().ended).toBeDefined()}finally{h.close()}
})
it('actual native transaction failure retains report for retry and does not hand off',async()=>{
 const h=await fixture();try{await h.produce('ready','retryable');h.report().mockImplementationOnce(()=>{throw new Error('native record failed')});await expect(h.idle()).rejects.toThrow('native record failed');expect(h.ticket().ended).toBeUndefined();await h.idle();expect(h.ticket().assignments.at(-1)?.report?.summary).toBe('retryable');expect(h.ticket().ended).toBeDefined()}finally{h.close()}
})
it('reopened durable native state does not redeliver a committed snapshot after a postcommit-before-cleanup crash',async()=>{
 const h=await fixture();try{await h.produce('progress','partialcrash');h.crashAfterCommit();await expect(h.idle()).rejects.toThrow('simulated crash');expect(h.ticket().assignments.at(-1)?.report?.summary).toBe('partialcrash');h.reopen();await h.idle();expect(h.report().mock.calls.filter((c:any)=>c[1].summary==='partialcrash')).toHaveLength(0)}finally{h.close()}
})
it('a new current-turn snapshot with identical progress text is still a legitimate native update',async()=>{
 const h=await fixture();try{await h.produce('progress','same text');await h.idle();await h.produce('progress','same text');await h.idle();expect(h.report().mock.calls.filter((c:any)=>c[1].summary==='same text')).toHaveLength(2)}finally{h.close()}
})
