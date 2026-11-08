/**
 * Conversation close-out detection. Distinguishes an explicit user close-out from unresolved approved work.
 *
 * A turn is closed out only when ALL of these hold, judged from the durable event history (never from a
 * truncated title or a stored copy of the text):
 *  1. The human message contains an affirmative close-out ("take no further action", "that's all", ...).
 *     Negated phrasing ("do not treat this as final", "not done yet") is removed before matching.
 *  2. The human message asks for no other work ("keep working", "fix ...", "run tests", "then ...").
 *     Prohibitions ("do not call tools, edit files ...") are not requests and do not count as work.
 *  3. Quoted/code text never counts as an instruction.
 *  4. The assistant explicitly confirms finality, promises no further work, and asks no unanswered question.
 *  5. The turn has no failed tool or blocker, and no later turn or human message reopened it.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decisionQuestion } from './decision-inbox.ts'

/** One wording for every surface (stale item, canonical refusal) so close-out reads as complete, never as an error. */
export const CONVERSATION_CLOSED_REASON = 'Conversation complete: the user explicitly closed it out and the assistant confirmed; no further action is requested. Earlier recommendations are retained as history.'
export const CONVERSATION_CLOSED_MESSAGE = 'Conversation complete: no further action requested'

const WORD = String.raw`[\p{L}\p{N}]`

export const CLOSEOUT_USER_PATTERNS = [
  /\b(?:take\s+no\s+further\s+action|no\s+further\s+action(?:s)?(?:\s+(?:needed|required|this\s+turn|is\s+needed|is\s+required))?)\b/i,
  /\btreat\b[^.;!?\n]*?\bas\s+(?:final|done|complete|closed)\b/i,
  /\b(?:this\s+is\s+final|confirmation\s+is\s+final)\b/i,
  // "close out" closes the conversation only when it has no artifact object ("close out the investigation notes").
  /\bclose[\s-]?out(?=\s*(?:$|[.,;:!?\n])|\s+(?:here\b|now\b|for\s+now\b|this\b|(?:the\s+)?(?:conversation|thread|session|chat|discussion|loop|ticket|request|turn|topic)\b|please\b))/i,
  /\bclose\s+the\s+loop\b/i,
  /\bthat(?:'s|\s+is|\s+will\s+be)\s+all\b/i,
  /\bwe(?:'re|\s+are)\s+(?:all\s+)?done\b/i,
  /\b(?:stop\s+here|wrap\s+up\s+here|all\s+done|all\s+set)\b/i,
  /\bnothing\s+(?:more|further|else)\s+(?:needed|to\s+do|required)\b/i,
]

/** A bare "Understood"/"Confirmed" is NOT finality: it can precede more work. */
export const CLOSEOUT_ASSISTANT_PATTERNS = [
  /\b(?:final\s+confirmation\s+stands|confirmation\s+stands|(?:taking|take|takes|will\s+take|making|make)\s+no\s+further\s+action|no\s+further\s+action\s+(?:is\s+)?(?:needed|required|taken)|nothing\s+(?:was|were)\s+touched|no\s+tools[,\s]+files[,\s]+settings[,\s]+or\s+connections\s+were\s+touched|stop(?:ping)?\s+here|all\s+done|wrapping\s+up|closing\s+out|(?:conversation|thread|this)\s+is\s+(?:closed|complete)|profile\s+is\s+advice-only)\b/i,
]

/** Requests for (more) work, or markers of unfinished business, in what remains after prohibitions are removed. */
const WORK_PATTERNS = [
  /\b(?:keep\s+(?:working|going|at|on)|continue|carry\s+on|go\s+on|proceed|resume|work\s+on|follow\s+up|look\s+(?:into|at)|set\s+up)\b/i,
  /\b(?:fix|implement|re-?run|run|investigat\w*|debug|refactor|resolve|address|deploy|publish|release|merge|build|test|check|verify|review|update|add|change|edit|write|create|configure|install|draft|send|commit|push|finish|complete|finali[sz]e|start|begin|handle|explain|summari[sz]e)\b/i,
  /\b(?:regression|unresolved|outstanding|remaining|except|also|then|next|first|before|after|but|however|still|again|another|one\s+more|more\s+(?:work|changes))\b/i,
]

/** The assistant is promising or reporting more work, a failure, or unfinished state. */
const ASSISTANT_OPEN_PATTERNS = [
  /\b(?:not|n't)\s+(?:yet\s+)?(?:complete\w*|finished|done|fixed|resolved|final|ready)\b/i,
  /\b(?:still|remaining|unresolved|outstanding|in\s+progress|todo|blocked|blocker|failed|failing|failure|unable\s+to|could\s+not|couldn't|cannot|can't)\b/i,
  /\b(?:i(?:'ll|\s+will|'m\s+going\s+to|\s+am\s+going\s+to)|let\s+me|now\s+i|then\s+i|next\b|proceeding|continuing)\b(?!\s+(?:take\s+no|not\b|stop|make\s+no|do\s+nothing|refrain|leave|keep\s+it|wait))/i,
]

/** Ignore quoted, fenced and inline-code text: it is data, not an instruction. Apostrophes inside words are kept. */
export function stripQuotedText(text: string): string {
  return text
    .replace(/(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n')
    .replace(/"[^"\n]+"/g, '')
    .replace(/“[^”\n]+”/g, '')
    .replace(new RegExp(`(?<!${WORD})['‘][^'’\\n]+['’](?!${WORD})`, 'gu'), '')
}

/** The human's own words: drop the appended runtime-context snapshot and injected reminders. */
export function requestText(raw: string): string {
  return raw.split(/\n*Current runtime context\./)[0]!.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

const SENTENCE_CHAR = String.raw`(?:\.(?!\s|$)|[^.;!?\n])`

// Lookahead marking where a hypothetical clause must stop:
// contrast conjunctions, current work / blocker clauses, clause boundaries, or sentence ends.
const CONTRAST_OR_BOUNDARY = String.raw`(?=,?\s+(?:but|however|yet|instead|except|though|meanwhile|while)\b|,\s*(?:and\s+)?(?:now\b|currently\b|first\b|presently\b|i\s+(?:will|am|must|need\b)|(?:the\s+)?\w+\s+is\s+(?:blocked|failing|failed|pending|running|broken)\b)|[;!?\n]|(?:\.(?:\s+|$))|$)`

// A prohibition covers the rest of its clause, including list items ("do not call tools, edit files or connect"),
// but a clause ends at ". ; ! ? newline", at ", then/but/instead", and where a new request or close-out begins.
const PROHIBITION = new RegExp(String.raw`(?:\b(?:do\s+not|never|must\s+not|should\s+not|avoid|no\s+need\s+to)\b|\b\w+n't\b|\bnot\s+(?:yet|done|final|finished|complete\w*|over|closed|ready|resolved|fixed|stop\w*|treat|consider|mark|call)\b)[^.;!?\n]*?(?=,?\s+(?:then|but|however|instead|so)\b|,\s*(?:and\s+)?(?:please\s+)?(?:fix|implement|continue|keep|proceed|resume|investigate|debug|finish|that(?:'s|\s+is)|we(?:'re|\s+are)|this\s+is|nothing|stop|treat|take)\b|[.;!?\n]|$)`, 'gi')

/** Instructions conditional on a later/subsequent turn or message are not continuing work for this turn. */
const CONDITIONAL_FUTURE_USER = new RegExp(String.raw`(?:\b(?:if|when|should)\b${SENTENCE_CHAR}*?\b(?:later|future|subsequent(?:ly)?|another)\s+(?:message|request|turn|prompt|chat)\b${SENTENCE_CHAR}*?${CONTRAST_OR_BOUNDARY})`, 'gi')

/** Conditional statements about what the assistant would do in a later/future turn if requested. */
const CONDITIONAL_FUTURE_ASSISTANT = new RegExp(String.raw`(?:\b(?:if|when|should)\b${SENTENCE_CHAR}*?\b(?:later|future|subsequent(?:ly)?|new\s+request|another\s+turn)\b${SENTENCE_CHAR}*?(?:,\s*|\s+)i(?:'ll|\s+will|\s+would|\s+shall|\s+can)\b${SENTENCE_CHAR}*?${CONTRAST_OR_BOUNDARY}|\bi(?:'ll|\s+will|\s+would|\s+shall|\s+can)\b${SENTENCE_CHAR}*?\b(?:if|when)\b${SENTENCE_CHAR}*?\b(?:later|future|subsequent(?:ly)?|new\s+request|another\s+turn)\b${SENTENCE_CHAR}*?${CONTRAST_OR_BOUNDARY})`, 'gi')

/** Instruction text with quotes, runtime context and prohibitions removed. */
export function positiveText(raw: string): string {
  return stripQuotedText(requestText(raw)).replace(/[’]/g, "'").replace(PROHIBITION, ' ').replace(CONDITIONAL_FUTURE_USER, ' ')
}

export function hasCloseoutIntent(raw: string): boolean {
  const text = positiveText(raw)
  return text.trim().length > 0 && CLOSEOUT_USER_PATTERNS.some(p => p.test(text))
}

/** Any request for more work, a continuation, or unfinished-business marker in the human's own words. */
export function hasContinuingIntent(raw: string): boolean {
  const text = positiveText(raw)
  return WORK_PATTERNS.some(p => p.test(text))
}

export function assistantConfirmsClose(raw: string): boolean {
  if (!raw || decisionQuestion(raw)) return false
  const text = stripQuotedText(raw).replace(/[’]/g, "'")
  const cleaned = text.replace(CONDITIONAL_FUTURE_ASSISTANT, ' ')
  return CLOSEOUT_ASSISTANT_PATTERNS.some(p => p.test(cleaned)) && !ASSISTANT_OPEN_PATTERNS.some(p => p.test(cleaned))
}

/** Text-only decision for one request/reply pair. `priorRequests` are earlier human messages of the same turn. */
export function isCloseoutTexts(humanTextValue: string, assistantText: string, priorRequests: readonly string[] = []): boolean {
  if (!humanTextValue || !assistantText) return false
  if ([humanTextValue, ...priorRequests].some(hasContinuingIntent)) return false
  return hasCloseoutIntent(humanTextValue) && assistantConfirmsClose(assistantText)
}

const isUserMessage = (e: SessionEvent): boolean => e.type === 'user/message' && (e.data as any)?.source?.kind === 'user'
const textOfContent = (content: unknown): string => Array.isArray(content)
  ? content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n') : ''

/**
 * Is the (given or latest) turn an explicit, completed, un-reopened close-out? Only the durable event history decides.
 */
export function isConversationCloseoutEvents(events: readonly SessionEvent[], targetTurn?: number): boolean {
  if (!events || !events.length) return false
  const startIndex = targetTurn !== undefined
    ? events.findLastIndex(e => e.type === 'turn/start' && e.data?.turn === targetTurn)
    : events.findLastIndex(e => e.type === 'turn/start')
  if (startIndex < 0) return false
  const tail = events.slice(startIndex)
  const end = tail.find(e => e.type === 'turn/end')
  if (!end || (end.data as any)?.reason?.kind !== 'completed') return false

  // A later turn or human message reopens the conversation.
  const endIndex = startIndex + tail.indexOf(end)
  if (events.slice(endIndex + 1).some(e => e.type === 'turn/start' || isUserMessage(e))) return false

  // The request that opened the turn (after the previous turn ended) plus any human message steering it:
  // the last one decides, and none may ask for other work.
  const before = events.slice(0, startIndex)
  const previousEnd = before.findLastIndex(e => e.type === 'turn/end')
  const opener = before.slice(previousEnd + 1).findLast(isUserMessage)
  const humans = [...(opener ? [opener] : []), ...events.slice(startIndex, endIndex).filter(isUserMessage)]
    .map(e => textOfContent((e.data as any)?.content))
  if (!humans.length) return false

  const turn = events.slice(startIndex, endIndex + 1)
  const assistantEvent = turn.findLast(e => e.type === 'assistant/message')
  if (!assistantEvent || (assistantEvent.data as any)?.interrupted) return false
  if (turn.some(e => e.type === 'tool/result' && ((e.data as any)?.isError || (e.data as any)?.message?.isError))) return false

  const asstContent = (assistantEvent.data as any)?.message?.content ?? (assistantEvent.data as any)?.content
  const asstText = Array.isArray(asstContent) ? textOfContent(asstContent)
    : typeof (assistantEvent.data as any)?.text === 'string' ? (assistantEvent.data as any).text : ''

  return isCloseoutTexts(humans.at(-1)!, asstText, humans.slice(0, -1))
}
