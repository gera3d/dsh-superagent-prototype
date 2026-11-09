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

it('positive valid-set publication succeeds with in-scope choices and correct recommendation', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const inbox = new DecisionInbox(db), fs = new FindingStore(db)
    let f = fs.observe({ dedupKey: 'review', title: 'Verify reporting', problem: 'Report', scope: 'Verify the installed reporting bridge only. No new issue or unrelated work.', owner: 'Harness implements; Codex reviews', kind: 'verification', requirements: ['Verify reporting'], repository: 'org/repo', occurrence: { id: 'o', reference: 'ref', evidence: 'scope' } })
    f = fs.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' }); f = fs.markDispatched(f.id, 'ticket-audit', 'assignment-audit')
    fs.markReview(f.id, { reference: 'report', summary: 'Ready; coordinator review required', state: 'ready', recordedAt: new Date().toISOString() })
    const time = Date.now(), source = { sessionId: 'worker-ticket-audit', sourceMessageId: 'message', sourceSeq: 2, sourceTurn: 1, draftRevision: 'draft' }
    const events: any[] = [{ type: 'user/message', seq: 0, time: time - 300, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please verify the installed reporting bridge only.' }] } }, { type: 'turn/start', seq: 1, time: time - 200, data: { turn: 1 } }, { type: 'assistant/message', seq: 2, time: time - 100, data: { turn: 1, message: { id: 'message', content: [{ type: 'text', text: 'Reporting verification complete; evidence awaits independent coordinator review.' }] } } }, { type: 'turn/end', seq: 3, time: time - 50, data: { turn: 1, reason: { kind: 'completed' } } }]
    const claim = inbox.claimCanonical({ ...source, owner: 'native-fallback' }, events)
    const validOptions = [
      { id: 'review', label: 'Hand evidence to Codex reviewer', prompt: 'Operator: hand the recorded evidence to the independent Codex reviewer.', why: 'Review evidence', recommended: true },
      { id: 'diff-check', label: 'Targeted diff scope check', prompt: 'Read-only: review the diff against finding scope. Confirm no unauthorized files or secrets modified.', why: 'Diff audit', recommended: false },
    ]
    const res = inbox.publishCanonical({ ...source, leaseToken: claim.leaseToken!, model: 'native-fallback', options: validOptions }, events)
    expect(res.item.choices).toHaveLength(2)
    expect(res.item.choices.map(c => c.id)).toEqual(['review', 'diff-check'])
    expect(res.item.recommendation.recommendedValue).toBe('review')
    expect(inbox.list().filter(x => x.status === 'pending')).toHaveLength(1)
  } finally { db.close() }
})

it('ordinary unowned conversation publishes valid conversational choices', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const inbox = new DecisionInbox(db)
    const time = Date.now(), source = { sessionId: 'chat-session-123', sourceMessageId: 'msg-1', sourceSeq: 2, sourceTurn: 1, draftRevision: 'draft-chat' }
    const events: any[] = [{ type: 'user/message', seq: 0, time: time - 200, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'How should we architect the caching layer?' }] } }, { type: 'turn/start', seq: 1, time: time - 100, data: { turn: 1 } }, { type: 'assistant/message', seq: 2, time: time - 50, data: { turn: 1, message: { id: 'msg-1', content: [{ type: 'text', text: 'Redis or SQLite can serve as in-memory cache.' }] } } }, { type: 'turn/end', seq: 3, time: time - 10, data: { turn: 1, reason: { kind: 'completed' } } }]
    const claim = inbox.claimCanonical({ ...source, owner: 'native-fallback' }, events)
    const chatOptions = [
      { id: 'clarify', label: 'Clarify throughput needs', prompt: 'Ask user for expected requests per second and latency requirements.', why: 'Clarify requirements', recommended: true },
      { id: 'sqlite', label: 'Explore SQLite in-memory option', prompt: 'Discuss zero-network SQLite in-memory caching trade-offs.', why: 'Architectural option', recommended: false },
    ]
    const res = inbox.publishCanonical({ ...source, leaseToken: claim.leaseToken!, model: 'native-fallback', options: chatOptions }, events)
    expect(res.item.choices).toHaveLength(2)
    expect(res.item.choices[0]!.id).toBe('clarify')
  } finally { db.close() }
})

it('explicitly authorized new issue work passes validation and publishes successfully', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const inbox = new DecisionInbox(db), fs = new FindingStore(db)
    let f = fs.observe({ dedupKey: 'native-gap-task', title: 'File native tool gap issue', problem: 'Tool gap', scope: 'User explicitly requested opening a new issue for the native-tool gap.', owner: 'Harness implements; Codex reviews', kind: 'fix', requirements: ['Open new issue'], repository: 'org/repo', occurrence: { id: 'o', reference: 'ref', evidence: 'gap' } })
    f = fs.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' }); f = fs.markDispatched(f.id, 'ticket-gap', 'assignment-gap')
    const time = Date.now(), source = { sessionId: 'worker-ticket-gap', sourceMessageId: 'msg-gap', sourceSeq: 2, sourceTurn: 1, draftRevision: 'draft-gap' }
    const events: any[] = [{ type: 'user/message', seq: 0, time: time - 200, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please open a new issue for the native-tool gap.' }] } }, { type: 'turn/start', seq: 1, time: time - 100, data: { turn: 1 } }, { type: 'assistant/message', seq: 2, time: time - 50, data: { turn: 1, message: { id: 'msg-gap', content: [{ type: 'text', text: 'Identified gap in native tool execution.' }] } } }, { type: 'turn/end', seq: 3, time: time - 10, data: { turn: 1, reason: { kind: 'completed' } } }]
    const claim = inbox.claimCanonical({ ...source, owner: 'native-fallback' }, events)
    const options = [
      { id: 'create-issue', label: 'Log the native-tool gap separately', prompt: 'Open a separate finding for the native-tool gap as requested.', why: 'Authorized work', recommended: true },
      { id: 'clarify', label: 'Clarify gap details', prompt: 'Ask user if additional logs should be included in the issue description.', why: 'Clarify details', recommended: false },
    ]
    const res = inbox.publishCanonical({ ...source, leaseToken: claim.leaseToken!, model: 'native-fallback', options }, events)
    expect(res.item.choices).toHaveLength(2)
    expect(res.item.choices[0]!.id).toBe('create-issue')
  } finally { db.close() }
})

it('accepted finding with no newer user ask rejects claiming or publishing pending advice', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const inbox = new DecisionInbox(db), fs = new FindingStore(db)
    let f = fs.observe({ dedupKey: 'accepted-task', title: 'Reporting', problem: 'Report', scope: 'Verify reporting', owner: 'operator', kind: 'verification', repository: 'org/repo', requirements: ['Verified'], occurrence: { id: 'o', reference: 'ref', evidence: 'evidence' } })
    f = fs.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' }); f = fs.markDispatched(f.id, 'ticket-acc', 'assignment-acc')
    fs.markReview(f.id, { reference: 'report', summary: 'Ready report', recordedAt: new Date().toISOString(), state: 'ready' })
    fs.reportEvidence(f.id, { reference: 'proof', evidence: 'Verified', nextDecision: 'Accept', verified: true })
    f = fs.resolve(f.id, 'proof', ['Verified']); const at = Date.parse(f.resolution!.at)
    const events: any[] = [{ type: 'user/message', seq: 0, time: at - 300, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please verify reporting' }] } }, { type: 'turn/start', seq: 1, time: at - 200, data: { turn: 1 } }, { type: 'assistant/message', seq: 2, time: at - 100, data: { turn: 1, message: { id: 'message', content: [{ type: 'text', text: 'Done.' }] } } }, { type: 'turn/end', seq: 3, time: at - 50, data: { turn: 1, reason: { kind: 'completed' } } }]
    const source = { sessionId: 'worker-ticket-acc', sourceMessageId: 'message', sourceSeq: 2, sourceTurn: 1, draftRevision: 'draft' }
    expect(() => inbox.claimCanonical({ ...source, owner: 'native-fallback' }, events)).toThrow('Scope is completed and resolved; pending advice cannot be claimed or published')
    expect(inbox.list().filter(x => x.status === 'pending')).toHaveLength(0)
  } finally { db.close() }
})

it('new explicit human request after finding resolution permits fresh advice publication', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const inbox = new DecisionInbox(db), fs = new FindingStore(db)
    let f = fs.observe({ dedupKey: 'resolved-reasked', title: 'Reporting', problem: 'Report', scope: 'Verify reporting', owner: 'operator', kind: 'verification', repository: 'org/repo', requirements: ['Verified'], occurrence: { id: 'o', reference: 'ref', evidence: 'evidence' } })
    f = fs.confirm(f.id, { revision: f.revision, choiceId: 'fix_now' }); f = fs.markDispatched(f.id, 'ticket-reask', 'assignment-reask')
    fs.markReview(f.id, { reference: 'report', summary: 'Ready report', recordedAt: new Date().toISOString(), state: 'ready' })
    fs.reportEvidence(f.id, { reference: 'proof', evidence: 'Verified', nextDecision: 'Accept', verified: true })
    f = fs.resolve(f.id, 'proof', ['Verified']); const at = Date.parse(f.resolution!.at)
    const newTime = at + 5000
    const events: any[] = [
      { type: 'user/message', seq: 0, time: at - 300, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please verify reporting' }] } },
      { type: 'turn/end', seq: 1, time: at - 50, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'user/message', seq: 2, time: newTime, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Now please check the export latency.' }] } },
      { type: 'turn/start', seq: 3, time: newTime + 10, data: { turn: 2 } },
      { type: 'assistant/message', seq: 4, time: newTime + 50, data: { turn: 2, message: { id: 'msg-latency', content: [{ type: 'text', text: 'Export latency measured at 45ms.' }] } } },
      { type: 'turn/end', seq: 5, time: newTime + 100, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const source = { sessionId: 'worker-ticket-reask', sourceMessageId: 'msg-latency', sourceSeq: 4, sourceTurn: 2, draftRevision: 'draft-latency' }
    const claim = inbox.claimCanonical({ ...source, owner: 'native-fallback' }, events)
    expect(claim.claimed).toBe(true)
    const options = [
      { id: 'benchmark', label: 'Run multi-run benchmark', prompt: 'Execute 10-run latency benchmark to check p99.', why: 'Latency check', recommended: true },
      { id: 'summary', label: 'Summarize results', prompt: 'Report the 45ms measurement to user.', why: 'Summary', recommended: false },
    ]
    const res = inbox.publishCanonical({ ...source, leaseToken: claim.leaseToken!, model: 'native-fallback', options }, events)
    expect(res.item.choices).toHaveLength(2)
    expect(res.item.status).toBe('pending')
  } finally { db.close() }
})
