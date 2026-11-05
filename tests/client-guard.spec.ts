import { describe, expect, it } from 'vitest'
import { builtinModules } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const testDir = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(testDir, '..')
const CLIENT_DIR = join(ROOT, 'src', 'client')

/** Extract runtime (non-type-only) imported/exported module specifiers. */
function runtimeDependencies(source: string, filePath: string): string[] {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const dependencies: string[] = []

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (!specifier || !ts.isStringLiteral(specifier)) continue

    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause?.isTypeOnly) continue
      const bindings = clause?.namedBindings
      if (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length && bindings.elements.every(element => element.isTypeOnly)) {
        continue
      }
    } else {
      if (statement.isTypeOnly) continue
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause) && clause.elements.length && clause.elements.every(element => element.isTypeOnly)) {
        continue
      }
    }
    dependencies.push(specifier.text)
  }
  return dependencies
}

function resolveDependency(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const dir = dirname(importer)
  const target = resolve(dir, specifier)
  const candidates = [
    target,
    target + '.ts',
    target + '.tsx',
    join(target, 'index.ts'),
    join(target, 'index.tsx'),
  ]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

function getClientFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...getClientFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

const SERVER_ONLY_PATTERNS = [
  /src\/infra\/(?!text\.ts)/, // server infra files except text.ts
  /src\/executor\//,          // backend executor
  /src\/policy\.ts$/,         // pulls in server-only environment
  /src\/index\.ts$/,          // server entry point
]

describe('client bundle safety guard', () => {
  it('prevents any client file from importing node: modules or server-only files via runtime imports', () => {
    const clientFiles = getClientFiles(CLIENT_DIR)
    expect(clientFiles.length).toBeGreaterThan(0)

    const visited = new Set<string>()
    const queue = clientFiles.map(f => ({ file: f, chain: [relative(ROOT, f)] }))
    const violations: { chain: string; reason: string }[] = []

    while (queue.length > 0) {
      const { file, chain } = queue.shift()!
      if (visited.has(file)) continue
      visited.add(file)

      const source = readFileSync(file, 'utf8')
      const dependencies = runtimeDependencies(source, file)

      for (const specifier of dependencies) {
        if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
          violations.push({
            chain: [...chain, specifier].join(' → '),
            reason: `Direct or indirect runtime import of Node built-in module "${specifier}"`,
          })
          continue
        }

        const resolved = resolveDependency(file, specifier)
        if (resolved) {
          const relPath = relative(ROOT, resolved)
          for (const pattern of SERVER_ONLY_PATTERNS) {
            if (pattern.test(relPath)) {
              violations.push({
                chain: [...chain, relPath].join(' → '),
                reason: `Reached server-only file "${relPath}"`,
              })
            }
          }
          if (!visited.has(resolved)) {
            queue.push({ file: resolved, chain: [...chain, relPath] })
          }
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('verifies built lib/client.js contains 0 node:child_process references', () => {
    const clientDist = join(ROOT, 'lib', 'client.js')
    if (existsSync(clientDist)) {
      const content = readFileSync(clientDist, 'utf8')
      const matches = content.match(/node:child_process/g) || []
      expect(matches.length).toBe(0)
    }
  })

  it('fails if policy.ts is imported as a runtime value rather than type-only', () => {
    const dummyClientSource = `
      import { LOCKED_ESCALATION_LIST } from '../policy.ts'
      export const list = LOCKED_ESCALATION_LIST
    `
    const deps = runtimeDependencies(dummyClientSource, join(CLIENT_DIR, 'dummy.ts'))
    expect(deps).toContain('../policy.ts')
    const resolved = resolveDependency(join(CLIENT_DIR, 'dummy.ts'), '../policy.ts')
    expect(resolved).not.toBeNull()
    const rel = relative(ROOT, resolved!)
    expect(SERVER_ONLY_PATTERNS.some(p => p.test(rel))).toBe(true)
  })
})
