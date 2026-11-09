import { expect,it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DecisionInbox } from '../src/app/decision-inbox.ts'
import { FindingStore } from '../src/app/finding.ts'
it('native publication does not leave a known out-of-scope alternate selectable for a real finding',()=>{
 const db=new DatabaseSync(':memory:');try {
 const inbox=new DecisionInbox(db),fs=new FindingStore(db)
 let f=fs.observe({dedupKey:'review',title:'Verify reporting',problem:'Report',scope:'Verify the installed reporting bridge only. No new issue or unrelated work.',owner:'Harness implements; Codex reviews',kind:'verification',requirements:['Verify reporting'],repository:'org/repo',occurrence:{id:'o',reference:'ref',evidence:'scope'}})
 f=fs.confirm(f.id,{revision:f.revision,choiceId:'fix_now'});f=fs.markDispatched(f.id,'ticket-audit','assignment-audit')
 fs.markReview(f.id,{reference:'report',summary:'Ready; coordinator review required',state:'ready',recordedAt:new Date().toISOString()})
 const time=Date.now(),source={sessionId:'worker-ticket-audit',sourceMessageId:'message',sourceSeq:2,sourceTurn:1,draftRevision:'draft'}
 const events:any[]=[{type:'user/message',seq:0,time:time-300,data:{source:{kind:'user'},content:[{type:'text',text:'Please verify the installed reporting bridge only.'}]}},{type:'turn/start',seq:1,time:time-200,data:{turn:1}},{type:'assistant/message',seq:2,time:time-100,data:{turn:1,message:{id:'message',content:[{type:'text',text:'Reporting verification complete; evidence awaits independent coordinator review.'}]}}},{type:'turn/end',seq:3,time:time-50,data:{turn:1,reason:{kind:'completed'}}}]
 const claim=inbox.claimCanonical({...source,owner:'native-fallback'},events)
 try{inbox.publishCanonical({...source,leaseToken:claim.leaseToken!,model:'native-fallback',options:[{id:'review',label:'Hand evidence to Codex reviewer',prompt:'Operator: hand the recorded evidence to the independent Codex reviewer.',why:'Review evidence',recommended:true},{id:'detour',label:'Log the native-tool gap separately',prompt:'Open a separate finding for the native-tool gap.',why:'New unrelated work',recommended:false}]},events)}catch(e){if((e as any).status!==409 && (e as any).status!==400)throw e}
 expect(inbox.list().filter(x=>x.status==='pending').some(x=>x.choices.some(c=>c.id==='detour'))).toBe(false)
 }finally{db.close()}
})
