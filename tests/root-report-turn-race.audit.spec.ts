import {it,expect} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync,existsSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {findWorkerReportFile,currentTurnOf} from '../src/executor/dsh.ts'
it('fails closed when actual session turn cannot be established',()=>{
 expect(currentTurnOf({session:{snapshotEvents:()=>[]}} as any)).not.toBe(1)
})
it('consuming a verified report cannot delete a newer atomically replaced report',()=>{
 const dir=mkdtempSync(join(tmpdir(),'report-consume-race-'))
 try {
  const path=join(dir,'.dsh-report.json');const data={state:'ready',summary:'current',ticket_id:'ticket',assignment_id:'assignment',turn_id:1,at:new Date().toISOString()}
  writeFileSync(path,JSON.stringify(data))
  const report=findWorkerReportFile(dir,{id:'ticket',assignmentId:'assignment',turn:1});expect(report).toBeDefined()
  const next=join(dir,'next.json');writeFileSync(next,JSON.stringify({...data,turn_id:2,summary:'newer'}));renameSync(next,path)
  report!.consume();expect(existsSync(path)).toBe(true)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
