import {it,expect} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {findWorkerReportFile,reportSnapshotHash} from '../src/executor/dsh.ts'
const ctx={id:'ticket',assignmentId:'assignment',turn:1}
const payload=(state:string,summary:string,at=Date.now())=>({state,summary,ticket_id:'ticket',assignment_id:'assignment',turn_id:1,at:new Date(at).toISOString()})
it('an older consume callback cannot delete a newer unconsumed claim',()=>{
 const dir=mkdtempSync(join(tmpdir(),'claim-identity-'))
 try{const path=join(dir,'.dsh-report.json');writeFileSync(path,JSON.stringify(payload('progress','old')));const old=findWorkerReportFile(dir,ctx)!;expect(old).toBeDefined();writeFileSync(path,JSON.stringify(payload('ready','new')));const newer=findWorkerReportFile(dir,ctx)!;expect(newer).toBeDefined();rmSync(path);old.consume();expect(findWorkerReportFile(dir,ctx)?.summary).toBe('new')}finally{rmSync(dir,{recursive:true,force:true})}
})
it('consumed markers cannot follow a symlink and truncate an external file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'marker-identity-'));const outside=mkdtempSync(join(tmpdir(),'marker-outside-'))
 try{const data=payload('ready','done');writeFileSync(join(dir,'.dsh-report.json'),JSON.stringify(data));const r=findWorkerReportFile(dir,ctx)!;expect(r).toBeDefined();const target=join(outside,'preserve.txt');writeFileSync(target,'KEEP');const hash=reportSnapshotHash(data);symlinkSync(target,join(dir,`.dsh-report.consumed.ticket.assignment.1.${hash}`));r.consume();expect(readFileSync(target,'utf8')).toBe('KEEP')}finally{rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})}
})
it('an older canonical replay must not supersede a newer retained claim',()=>{
 const dir=mkdtempSync(join(tmpdir(),'claim-order-'))
 try{const path=join(dir,'.dsh-report.json');const now=Date.now();writeFileSync(path,JSON.stringify(payload('ready','new',now)));expect(findWorkerReportFile(dir,ctx)?.summary).toBe('new');writeFileSync(path,JSON.stringify(payload('progress','old',now-1000)));expect(findWorkerReportFile(dir,ctx)?.summary).toBe('new')}finally{rmSync(dir,{recursive:true,force:true})}
})
it('exact older snapshots stay refused after bounded cache eviction',()=>{
 const dir=mkdtempSync(join(tmpdir(),'claim-replay-'))
 try{const path=join(dir,'.dsh-report.json');const now=Date.now();const first=payload('progress','original',now);writeFileSync(path,JSON.stringify(first));findWorkerReportFile(dir,ctx)!.consume();for(let i=0;i<260;i++){writeFileSync(path,JSON.stringify(payload('progress','new-'+i,now+i+1)));findWorkerReportFile(dir,ctx)!.consume()};writeFileSync(path,JSON.stringify(first));expect(findWorkerReportFile(dir,{...ctx,since:now+260})).toBeUndefined()}finally{rmSync(dir,{recursive:true,force:true})}
})
