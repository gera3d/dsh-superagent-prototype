import {it,expect} from 'vitest'
import {adviceContext} from '../src/app/advice-context.ts'
it('does not treat an unverified current progress evidence row as completed testing',()=>{
 const ticket={id:'current',title:'Advisor repair',mandate:{strength:'explicit',scope:'Bounded implementation. Codex reviews.'},assignments:[{id:'assignment',state:'working',report:{state:'waiting',at:'2026-11-08T23:00:00Z',summary:'Build failed. Tests pending.'}}]}
 const finding={id:'finding',revision:1,state:'running',title:'Advisor repair',owner:'Codex',scope:'Bounded repair',kind:'fix',repository:'owner/repo',job:{id:'job',ticketId:'current',assignmentId:'assignment'},reports:[{state:'evidence',jobId:'job',at:'2026-11-08T23:00:00Z',reference:'ticket/current/report/assignment',evidence:'Unverified progress only',nextDecision:'Wait'}]}
 expect(adviceContext(ticket as any,undefined,undefined,finding as any)).not.toContain('has reported candidate testing complete')
})

it('ready status does not certify testing without exact-head evidence', () => {
 const ticket={id:'current',title:'Review candidate',mandate:{strength:'explicit',scope:'Codex reviews.'},assignments:[{id:'assignment',state:'working',report:{state:'ready',at:'2026-11-08T23:00:00Z',summary:'Patch ready. No test result attached.'}}]}
 const finding={id:'finding',revision:1,state:'running',title:'Repair',owner:'Codex',scope:'Bounded repair',kind:'fix',repository:'owner/repo',job:{id:'job',ticketId:'current',assignmentId:'assignment'},reports:[]}
 const context=adviceContext(ticket as any,undefined,undefined,finding as any)
 expect(context).not.toContain('has reported candidate testing complete')
 expect(context).toContain('Readiness is not proof that tests ran or passed')
 expect(context).toContain('independent review')
})
