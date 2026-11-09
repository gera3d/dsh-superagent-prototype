import {expect,it} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {DecisionInbox} from '../src/app/decision-inbox.ts'
it('ordinary unowned current human request to draft a native-tool issue remains publishable',()=>{
 const db=new DatabaseSync(':memory:');try{
 const inbox=new DecisionInbox(db),time=Date.now()
 const source={sessionId:'ordinary-user-chat',sourceMessageId:'message',sourceSeq:2,sourceTurn:1,draftRevision:'draft'}
 const events:any[]=[{type:'user/message',seq:0,time:time-300,data:{source:{kind:'user'},content:[{type:'text',text:'Please draft a new issue for the native-tool gap. I want to review the draft before anything is filed.'}]}},{type:'turn/start',seq:1,time:time-200,data:{turn:1}},{type:'assistant/message',seq:2,time:time-100,data:{turn:1,message:{id:'message',content:[{type:'text',text:'I can draft the requested issue for your review, without creating or sending anything.'}]}}},{type:'turn/end',seq:3,time:time-50,data:{turn:1,reason:{kind:'completed'}}}]
 const claim=inbox.claimCanonical({...source,owner:'native-fallback'},events)
 const options=[{id:'draft',label:'Draft requested native-tool gap issue',prompt:'Draft the new issue for the native-tool gap requested above. Do not file or send it.',why:'User requested draft',recommended:true},{id:'clarify',label:'Clarify issue scope',prompt:'Ask which reproduction details belong in the requested issue draft.',why:'Clarify details',recommended:false}]
 const res=inbox.publishCanonical({...source,leaseToken:claim.leaseToken!,model:'native-fallback',options},events)
 expect(res.item.choices.map(c=>c.id)).toEqual(['draft','clarify'])
 }finally{db.close()}
})
