import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { recordLiveAttestation } from '../src/app/delivery-evidence.ts'
const dbs: DatabaseSync[]=[]
afterEach(()=>{for(const db of dbs.splice(0))db.close()})
function setup(){
 const db=new DatabaseSync(':memory:');dbs.push(db);const store=new DeliveryStore(db)
 const bindings={repository:'org/repo',sourceIssue:1,baseSha:'b'.repeat(40),headSha:'a'.repeat(40)}
 const d=store.create({id:'live',title:'Live',owner:'operator',workers:[],authorities:['local-operator'],requirements:['a','b'],bindings})
 store.compareAndSwap(d.id,d.revision,v=>{v.stage='verifying';v.state='awaiting_decision';v.evidence.push({id:'pub',kind:'publication',bindings,recordedAt:'2026-11-09T00:00:00Z',reference:'publication:x',outcome:'passed',generation:0},{id:'publication:x:verify',kind:'verification',bindings,recordedAt:'2026-11-09T00:00:00Z',reference:'publication:x#verify',outcome:'passed',generation:0})})
 let n=0
 const check=(requirements:string[],outcome:'passed'|'failed'='passed')=>recordLiveAttestation(store,'live',{revision:store.get('live')!.revision,requirements,reference:`https://example.test/check/${++n}`,outcome},'local-operator')
 return{store,check}
}
it('does not clear failed b with unrelated passing a or resurrect old b coverage',()=>{
 const{check}=setup();check(['a','b']);check(['b'],'failed');const d=check(['a'])
 expect(d.state).toBe('blocked');expect(d.nextAction?.kind).not.toBe('accept')
})
it('keeps the real failed requirement actionable in the native evidence form',()=>{
 const{check}=setup();check(['a','b']);const d=check(['b'],'failed')
 expect(d.awaitingOperatorEvidence).toEqual(['b'])
})
it('collects separate rechecks after a grouped failure and offers only the remaining requirement',()=>{
 const{check}=setup();check(['a','b']);const failed=check(['a','b'],'failed');const partial=check(['a'])
 expect(partial.state).toBe('blocked');expect(partial.awaitingOperatorEvidence).toEqual(['b']);expect(partial.nextAction?.kind).not.toBe('accept')
 const full=check(['b']);expect(full.nextAction?.kind).toBe('accept');expect(full.acceptance).toBeUndefined()
 expect(full.evidence.some(e=>e.supersedes?.includes(failed.evidence.at(-1)!.id))).toBe(true)
})
