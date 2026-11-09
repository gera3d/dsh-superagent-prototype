import { it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findWorkerReportFile, extractReportFromText } from '../src/executor/dsh.ts'
it('does not elevate quoted example to real ready status', () => {
 expect(extractReportFromText('Implementation is NOT ready. Example payload for later:\n```json\n{"state":"ready","summary":"example only"}\n```')).toBeUndefined()
})
it('does not ingest an unbound old generic report file', () => {
 const dir=mkdtempSync(join(tmpdir(),'root-stale-report-'))
 try { writeFileSync(join(dir,'report.json'),JSON.stringify({state:'ready',summary:'previous assignment'})); expect(findWorkerReportFile(dir)).toBeUndefined() } finally {rmSync(dir,{recursive:true,force:true})}
})
it('rejects a report symlink pointing outside the workspace', () => {
 const dir=mkdtempSync(join(tmpdir(),'root-report-link-')); const outside=mkdtempSync(join(tmpdir(),'root-outside-'))
 try { writeFileSync(join(outside,'payload.json'),JSON.stringify({state:'ready',summary:'outside payload'})); symlinkSync(join(outside,'payload.json'),join(dir,'.dsh-report.json')); expect(findWorkerReportFile(dir)).toBeUndefined() } finally {rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})}
})
