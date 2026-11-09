import {it,expect,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Store} from '../src/app/store.ts'
import {Engine} from '../src/core/engine.ts'
it('legacy persisted native finding dispatch remains idempotent when equivalent native origin fields are made explicit',()=>{
 const dir=mkdtempSync(join(tmpdir(),'headless-native-legacy-'));const store=new Store(join(dir,'db.sqlite'))
 try{const engine=new Engine({repo:store,policy:()=>({version:'p1',paused:false}),executor:{start:vi.fn(),deliver:vi.fn(),stop:vi.fn()}} as any);const input={jobId:'finding:legacy:r1',findingId:'legacy',title:'Legacy native finding',scope:'Same approved scope',repository:'org/repo',text:'Native approved task'};const initial=engine.dispatchFinding(input);const explicit={jobId:input.jobId,findingId:input.findingId,title:input.title,scope:input.scope,repository:input.repository,actorId:'local-operator',actorSource:'local',human:true,text:input.text};expect(engine.dispatchFinding(explicit).id).toBe(initial.id);expect(()=>engine.dispatchFinding({...explicit,actorId:'codex-coordinator',actorSource:'coordinator',human:false})).toThrow('scope mismatch')}finally{store.close();rmSync(dir,{recursive:true,force:true})}
})
