import {it,expect} from 'vitest'
const fixture = { ticket: {id: 'current', title: 'Repair', ended: {outcome: 'stopped'}, mandate: {strength: 'explicit', scope: 'Codex reviews'}, assignments: [{state: 'ended', report: {state: 'waiting', summary: 'Candidate returned', at: '2026-11-08'}}]}, finding: {id: 'finding', revision: 1, state: 'blocked', blocker: 'Review / verification required', title: 'Repair', owner: 'Codex', scope: 'Bounded repair', kind: 'fix', repository: 'owner/repo', job: {id: 'job', ticketId: 'current'}, reports: []} }
import {adviceContext} from '../src/app/advice-context.ts'
it('does not prohibit independent review when blocked means ended worker needs evidence review',()=>{
 const context=adviceContext(fixture.ticket as any,undefined,undefined,fixture.finding as any)
 expect(context).not.toContain('do not recommend proceeding with review')
 expect(context).toContain('coordinator')
})
it('does not claim a waiting progress report proves completed testing',()=>{
 const ticket={...fixture.ticket,assignments:[{report:{state:'waiting',summary:'Still investigating; tests have not run',at:'2026-11-08'}}]}
 const finding={...fixture.finding,state:'running'}
 expect(adviceContext(ticket as any,undefined,undefined,finding as any)).not.toContain('has reported candidate testing complete')
})
