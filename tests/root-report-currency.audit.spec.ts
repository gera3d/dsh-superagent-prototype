import {it,expect} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {findWorkerReportFile} from '../src/executor/dsh.ts'
it('rejects a report missing mandatory current identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'report-currency-'))
 try {writeFileSync(join(dir,'.dsh-report.json'),JSON.stringify({state:'ready',summary:'old output'}));expect(findWorkerReportFile(dir,{id:'current-ticket',assignmentId:'current-assignment',since:Date.now()})).toBeUndefined()}finally{rmSync(dir,{recursive:true,force:true})}
})
it('rejects an old same-ticket report at the actual production call boundary',()=>{
 const dir=mkdtempSync(join(tmpdir(),'report-currency-'))
 try {writeFileSync(join(dir,'.dsh-report.json'),JSON.stringify({state:'ready',summary:'previous turn',ticket_id:'current-ticket',assignment_id:'old-assignment',at:'2020-01-01T00:00:00Z'}));expect(findWorkerReportFile(dir,{id:'current-ticket'})).toBeUndefined()}finally{rmSync(dir,{recursive:true,force:true})}
})
