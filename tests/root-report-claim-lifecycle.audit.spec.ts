import {it,expect} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {findWorkerReportFile} from '../src/executor/dsh.ts'
const data=(state:string,summary:string)=>({state,summary,ticket_id:'ticket',assignment_id:'assignment',turn_id:1,at:new Date().toISOString()})
it('preserves later progress-to-ready reporting in the same current turn',()=>{
 const dir=mkdtempSync(join(tmpdir(),'report-lifecycle-'))
 try{const path=join(dir,'.dsh-report.json');writeFileSync(path,JSON.stringify(data('progress','partial')));const first=findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1});expect(first).toBeDefined();first!.consume();writeFileSync(path,JSON.stringify(data('ready','complete')));const next=findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1});expect(next?.state).toBe('ready')}finally{rmSync(dir,{recursive:true,force:true})}
})
it('must never follow a dangling claim symlink and create an out-of-workspace file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'report-claim-link-'));const outside=mkdtempSync(join(tmpdir(),'report-outside-'))
 try{const target=join(outside,'must-not-create.json');symlinkSync(target,join(dir,'.dsh-report.claim.ticket.assignment.1.json'));writeFileSync(join(dir,'.dsh-report.json'),JSON.stringify(data('ready','valid')));const r=findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1});expect({reportAccepted:!!r,outsideCreated:existsSync(target)}).toEqual({reportAccepted:false,outsideCreated:false})}finally{rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})}
})
it('retains claimed report for safe retry when delivery is not consumed', () => {
 const dir=mkdtempSync(join(tmpdir(),'report-retry-'))
 try {
   const path=join(dir,'.dsh-report.json');
   writeFileSync(path,JSON.stringify(data('ready','retryable')));
   const first=findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1});
   expect(first).toBeDefined();
   rmSync(path);
   const retry=findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1});
   expect(retry?.state).toBe('ready');
   expect(retry?.summary).toBe('retryable');
   retry!.consume();
   expect(findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1})).toBeUndefined();
 } finally { rmSync(dir,{recursive:true,force:true}) }
})
it('supersedes unconsumed claim with newer canonical payload', () => {
 const dir=mkdtempSync(join(tmpdir(),'report-supersede-'))
 try {
   const path=join(dir,'.dsh-report.json');
   writeFileSync(path,JSON.stringify(data('progress','old-claim')));
   const first=findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1});
   expect(first).toBeDefined();
   writeFileSync(path,JSON.stringify(data('ready','newer-canonical')));
   const updated=findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1});
   expect(updated?.state).toBe('ready');
   expect(updated?.summary).toBe('newer-canonical');
   updated!.consume();
   expect(findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1})).toBeUndefined();
 } finally { rmSync(dir,{recursive:true,force:true}) }
})
