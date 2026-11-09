import {it,expect,vi} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync,existsSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const race=vi.hoisted(()=>({path:'',next:''}))
vi.mock('node:fs',async(importOriginal)=>{const fs=await importOriginal<typeof import('node:fs')>();return {...fs,unlinkSync:(p:any)=>{if(race.path && p===race.path){fs.renameSync(race.next,race.path);race.path=''}return fs.unlinkSync(p)}}})
import {findWorkerReportFile} from '../src/executor/dsh.ts'
it('rejects missing turn on both report and runtime context rather than silently falling back to unbound acceptance',()=>{
 const dir=mkdtempSync(join(tmpdir(),'report-unknown-'))
 try{writeFileSync(join(dir,'.dsh-report.json'),JSON.stringify({state:'ready',summary:'unbound',ticket_id:'ticket',assignment_id:'assignment',at:new Date().toISOString()}));expect(findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment'})).toBeUndefined()}finally{rmSync(dir,{recursive:true,force:true})}
})
it('cannot unlink a canonical newer report replaced after the final identity check',()=>{
 const dir=mkdtempSync(join(tmpdir(),'report-final-race-'))
 try{const path=join(dir,'.dsh-report.json');const data={state:'ready',summary:'current',ticket_id:'ticket',assignment_id:'assignment',turn_id:1,at:new Date().toISOString()};writeFileSync(path,JSON.stringify(data));const r=findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1});expect(r).toBeDefined();const next=join(dir,'next.json');writeFileSync(next,JSON.stringify({...data,turn_id:2}));race.path=path;race.next=next;r!.consume();expect(existsSync(path)).toBe(true)}finally{race.path='';rmSync(dir,{recursive:true,force:true})}
})
