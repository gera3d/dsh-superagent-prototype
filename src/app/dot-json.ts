const MAX_TEXT_LENGTH = 64_000
const MAX_DEPTH = 128

/** Extract the first complete, schema-valid object without repairing model output. */
export function extractJsonObject<T>(text: string, validate: (value: unknown) => T): T {
  if (text.length > MAX_TEXT_LENGTH) throw new Error('Model JSON response exceeds size limit')

  let start = -1
  let inString = false
  let escaped = false
  let sawObject = false
  const stack: string[] = []

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      if (stack.length === 0) {
        start = index
        if (char === '{') sawObject = true
      }
      stack.push(char)
      if (stack.length > MAX_DEPTH) throw new Error('Model JSON response exceeds depth limit')
      continue
    }
    if ((char !== '}' && char !== ']') || stack.length === 0) continue

    const opening = stack.pop()
    if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) {
      // A mismatched delimiter invalidates this candidate; never repair it.
      stack.length = 0
      start = -1
      continue
    }
    if (stack.length !== 0) continue
    const candidateStart = start
    start = -1
    // Arrays are not object candidates, including objects nested inside them.
    if (text[candidateStart] !== '{') continue

    let value: unknown
    try {
      value = JSON.parse(text.slice(candidateStart, index + 1))
    } catch {
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    try {
      return validate(value)
    } catch {
      // Validator errors may contain model output or secrets. Do not expose them.
    }
  }

  // Never include input snippets, JSON.parse errors, or validator errors.
  throw new Error(sawObject ? 'No complete schema-valid JSON object found' : 'No JSON object found')
}
