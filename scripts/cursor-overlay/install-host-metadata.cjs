#!/usr/bin/env node
// Reapply after a DSH update. Fails closed when the upstream bridge shape changes.
const fs = require('node:fs')
const path = require('node:path')
const target = process.argv[2]
if (!target || !path.isAbsolute(target)) throw new Error('Pass the absolute path to dsh-mcp-client/lib/index.js')
const old = `\t\t\t\tname: tool.name,\n\t\t\t\targuments: args\n\t\t\t}, {`
const replacement = `\t\t\t\tname: tool.name,
\t\t\t\targuments: args,
\t\t\t\t// dev.dsh/computer-caller: authoritative per-execution identity, not model input.
\t\t\t\t...(opts.serverName === "computer" && execution.agent ? { _meta: {
\t\t\t\t\t"dev.dsh/computer-caller": (() => {
\t\t\t\t\t\tlet threadTitle;
\t\t\t\t\t\ttry { threadTitle = ctx.sessionTitle?.get(execution.agent.session)?.title; } catch {}
\t\t\t\t\t\treturn { threadId: execution.agent.id, ...(threadTitle ? { threadTitle } : {}) };
\t\t\t\t\t})()
\t\t\t\t} } : {})
\t\t\t}, {`
const source = fs.readFileSync(target, 'utf8')
if (source.includes('// dev.dsh/computer-caller:')) { console.log('Caller metadata patch already installed'); process.exit(0) }
if (source.split(old).length !== 2) throw new Error('Bridge changed: review upstream instead of guessing a patch')
const backup = target + '.before-cursor-metadata'
if (fs.existsSync(backup)) throw new Error('Backup exists; review before changing bridge')
fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL)
fs.writeFileSync(target, source.replace(old, replacement))
console.log('Installed per-call computer metadata; restart DSH to load it. Backup: ' + backup)
