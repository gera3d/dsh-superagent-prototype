import { describe,it,expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { FindingStore } from '../src/app/finding.ts'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { ProgressStore } from '../src/app/progress.ts'
import { adviceContext } from '../src/app/advice-context.ts'
function fixture(){
 const db=new DatabaseSync(':memory:');const fs=new FindingStore(db);const inbox=new DecisionInbox(db);const ps=new ProgressStore(db)
 let f=fs.observe({dedupKey:'root-handoff-audit',title:'Handoff',problem:'Stale advice',scope:'Bounded existing task',owner:'Codex',kind:'fix',requirements:['Current stage'],repository:'gera3d/dsh-superagent-prototype',occurrence:{id:'root',reference:'audit',evidence:'native stale advice'}})
 fs.confirm(f.id,{revision:f.revision,choiceId:'fix_now'});f=fs.markDispatched(f.id,'root-ticket','assignment')
 const events:any[]=[{type:'user/message',seq:0,time:1000,data:{source:{kind:'user'},content:[{type:'text',text:'Complete the approved repair'}]}},{type:'turn/start',seq:1,time:1010,data:{turn:1}},{type:'assistant/message',seq:2,time:1050,data:{turn:1,message:{id:'message',content:[{type:'text',text:'Patch ready for coordinator review.'}]}}},{type:'turn/end',seq:3,time:1100,data:{turn:1,reason:{kind:'completed'}}}]
 const source={sessionId:'worker-root-ticket',sourceMessageId:'message',sourceSeq:2,sourceTurn:1,draftRevision:'native-unchanged-event-digest'}
 const ticket:any={id:'root-ticket',title:'Handoff',mandate:{strength:'explicit',scope:'Existing repair'},assignments:[{id:'assignment',state:'ended',report:{state:'ready',summary:'Patch ready',at:'2026-11-09T10:00:00Z'}}],channels:[],undelivered:[],ended:{}}
 function observe(kind:'merged'|'deployed',at:number){ps.observe({ticketId:'root-ticket',jobId:f.job!.id,kind,repository:'gera3d/dsh-superagent-prototype',branch:'release',commit:'a'.repeat(40),pr:77,outcome:'passed',...(kind==='deployed'?{environment:'local:3082'}:{}),evidence:'Personally checked exact release evidence',owner:'Codex',observedAt:new Date(at).toISOString()},{source:'operator',reference:'root'},at)}
 return {db,inbox,ps,f,events,source,ticket,observe}
}
describe('Root independent native handoff boundary audit',()=>{
 it('merged-only progress does not claim deployment already happened',()=>{const x=fixture();try{x.observe('merged',Date.now());const c=adviceContext(x.ticket,undefined,x.ps.current('root-ticket'),x.f);expect(c).not.toContain('deployment have already been completed');expect(c).not.toContain('The only remaining stage is native verification')}finally{x.db.close()}})
 it('progress changing during generation rejects publication based on the earlier lease',()=>{const x=fixture();try{const claim=x.inbox.claimCanonical({...x.source,owner:'native-host'},x.events);x.observe('deployed',Date.now()+1000);expect(()=>x.inbox.publishCanonical({...x.source,leaseToken:claim.leaseToken!,model:'Senior Developer',options:[{id:'review',label:'Review patch',prompt:'Codex review the saved patch',why:'Review needed',recommended:true},{id:'audit',label:'Audit caption',prompt:'Audit the caption patch',why:'Check changes',recommended:false}]},x.events)).toThrow()}finally{x.db.close()}})
})

import { DeliveryStore } from '../src/app/feature-delivery.ts'
import { reconcileInboxCurrency } from '../src/app/delivery-runtime.ts'
it('actual progress-observe inbox reconciliation still permits fresh native claim with unchanged event digest',()=>{
 const x=fixture();try{
  const claim=x.inbox.claimCanonical({...x.source,owner:'native-host'},x.events)
  const published=x.inbox.publishCanonical({...x.source,leaseToken:claim.leaseToken!,model:'Senior Developer',options:[{id:'review',label:'Verify exact-head evidence before review',prompt:'Codex review the saved patch',why:'Review needed',recommended:true},{id:'audit',label:'Audit caption',prompt:'Audit the caption patch',why:'Check changes',recommended:false}]},x.events)
  x.observe('deployed',Date.now()+1000)
  reconcileInboxCurrency(x.inbox,new DeliveryStore(x.db),undefined,new FindingStore(x.db),x.ps)
  const fresh=x.inbox.claimCanonical({...x.source,owner:'native-host'},x.events)
  expect(fresh.claimed).toBe(true)
  expect(fresh.item.supersedesDecisionId).toBe(published.item.id)
  expect(fresh.item.choices).toHaveLength(0)
 }finally{x.db.close()}
})
