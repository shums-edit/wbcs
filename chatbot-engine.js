/* ============================================================
   UPSC RULE KEEPER — chatbot-engine.js (NEW FILE)
   Version: 4.0.0 (2026-08-10)

   The chatbot's "brain" — a rule-based dialogue engine, not a real
   AI model. Every reply is built from your actual stored rules data
   by filling in fixed sentence templates; nothing is ever generated
   freely, so it structurally cannot make something up. Four pieces:

     1. Intent classifier — sorts each message into one of a few known
        shapes: asking for a rule, asking WHERE something is, asking
        for the Nth item of a multi-part rule, or replying to a
        question the bot just asked.
     2. Entity extraction — strips question-words ("which", "is",
        "on", "rule of") to find the actual subject being asked about.
     3. Conversation memory — remembers a pending disambiguation
        question ("there are 3 rules matching X — which one?") so the
        student's next message answers THAT, not a fresh search.
     4. Template response builder — fills fixed sentence shapes with
        real rule data.

   Falls back to the existing fuzzy search (fuzzy-match.js) for
   anything that doesn't match a recognized question shape — nothing
   gets worse than before, more just gets handled well.
   ============================================================ */

import { fuzzyMatchRule } from "./fuzzy-match.js";
import { escapeHtml, sanitizeRichText, stripHtml } from "./sanitize.js";

const ORDINAL_WORDS = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10
};

// Strips ALL spaces/punctuation, not just extra whitespace — this is
// what fixes "keyword" vs "key word" being treated as different
// strings, which the existing normalizeText() in fuzzy-match.js
// (lowercase + collapse whitespace) doesn't cover.
function looseNormalize(text) {
    return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseOrdinal(text) {
    const wordMatch = text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/);
    if (wordMatch) return ORDINAL_WORDS[wordMatch[1]];
    const numMatch = text.match(/\b(\d+)(?:st|nd|rd|th)?\b/);
    if (numMatch) return parseInt(numMatch[1], 10);
    return null;
}

// Every rule whose name loosely contains `term`, sorted alphabetically
// (matches the dashboard's default sort, so "position" numbers below
// stay meaningful and predictable).
function findRulesMatchingTerm(term, rulesList) {
    const loose = looseNormalize(term);
    if (!loose) return [];
    return rulesList
        .filter(r => looseNormalize(stripHtml(r.ruleName)).includes(loose))
        .sort((a, b) => stripHtml(a.ruleName).localeCompare(stripHtml(b.ruleName)));
}

// "Position" = this rule's 1-based index among all rules in the same
// category, alphabetically — e.g. "rule #14 of 32 under English".
function getCategoryPosition(rule, rulesList) {
    const sameCategory = rulesList
        .filter(r => r.category === rule.category)
        .sort((a, b) => stripHtml(a.ruleName).localeCompare(stripHtml(b.ruleName)));
    const idx = sameCategory.findIndex(r => r.id === rule.id);
    return { position: idx + 1, total: sameCategory.length };
}

function formatRule(rule) {
    const safeName       = sanitizeRichText(rule.ruleName);
    const safeDefinition = rule.definition ? sanitizeRichText(rule.definition) : "";
    const safeKeyPoints  = rule.keyPoints  ? sanitizeRichText(rule.keyPoints)  : "";
    const safeExamples   = rule.examples   ? sanitizeRichText(rule.examples)   : "";
    let response = `**${safeName}**`;
    if (safeDefinition) response += `\n\n📖 Definition:\n${safeDefinition}`;
    if (safeKeyPoints)  response += `\n\n📌 Key Points:\n${safeKeyPoints}`;
    if (safeExamples)   response += `\n\n💡 Examples:\n${safeExamples}`;
    return response;
}

function formatPositionAnswer(rule, rulesList) {
    const { position, total } = getCategoryPosition(rule, rulesList);
    const chapterPart = rule.chapter ? ` → ${sanitizeRichText(rule.chapter)}` : "";
    return `**${sanitizeRichText(rule.ruleName)}** is rule #${position} of ${total} under ${escapeHtml(rule.category)}${chapterPart}.`;
}

function formatDisambiguationPrompt(term, matches) {
    const names = matches.map((r, i) => `${i + 1}. ${stripHtml(r.ruleName)}`).join("\n");
    return `There are ${matches.length} rules matching "${escapeHtml(term)}":\n\n${names}\n\nReply "all", or a number/word like "first" or "2".`;
}

/**
 * Creates one chatbot engine instance with its own private
 * conversation memory (a pending disambiguation question, if any).
 * Call .respond(query, rulesList) for each message; call .reset() to
 * clear any pending context (e.g. when the chat window is closed).
 */
export function createChatbotEngine() {
    let pendingContext = null; // { matches: [...], term: "..." } | null

    function reset() {
        pendingContext = null;
    }

    function respond(query, rulesList) {
        const lower = query.toLowerCase().trim();

        // ── 1. Answering a pending disambiguation question ────────
        if (pendingContext) {
            const { matches, term } = pendingContext;
            pendingContext = null;

            if (/\ball\b/.test(lower)) {
                return {
                    text: matches.map(r => formatRule(r)).join("\n\n---\n\n"),
                    matchedRules: matches
                };
            }
            const ord = parseOrdinal(lower);
            if (ord && matches[ord - 1]) {
                return { text: formatRule(matches[ord - 1]), matchedRules: [matches[ord - 1]] };
            }
            // Didn't look like a valid answer — fall through and treat
            // this message as a fresh question instead of getting stuck.
        }

        // ── 2. Position questions — "which number is X on" AND its
        // reverse "X is in which number", plus "where is X" ─────────
        // v4.0.1 fix: the first version only handled the
        // question-word-first order. A student phrasing it the other
        // way ("preposition key word is in which number?") fell all
        // the way through to "couldn't find" — a real gap, not a
        // fluke, so this now checks both orders explicitly, plus a
        // more forgiving fallback for phrasings that don't match
        // either exact shape.
        const positionMatch =
            lower.match(/\b(?:which|what)\s+(?:line|number|position)\s+(?:is|does)\s+(.+?)\s+(?:on|at|come)\b/) ||
            lower.match(/^(.+?)\s+is\s+(?:in\s+|on\s+|at\s+)?which\s+(?:line|number|position)\b/) ||
            lower.match(/^where\s+is\s+(.+?)\s*\??$/);

        // Fallback: both a question-word (which/what) and a
        // position-word (line/number/position) appear somewhere in the
        // message, but not in either exact shape above — strip the
        // scaffolding words out and treat whatever's left as the
        // subject, rather than giving up entirely.
        const hasQuestionWord = /\b(?:which|what)\b/.test(lower);
        const hasPositionWord = /\b(?:line|number|position)\b/.test(lower);
        const fallbackTerm = (!positionMatch && hasQuestionWord && hasPositionWord)
            ? lower
                .replace(/\b(?:which|what|line|number|position|is|does|in|on|at|come)\b/g, " ")
                .replace(/\?/g, "")
                .replace(/\s+/g, " ")
                .trim()
            : null;

        if (positionMatch || fallbackTerm) {
            const term = positionMatch ? positionMatch[1].trim() : fallbackTerm;
            const matches = findRulesMatchingTerm(term, rulesList);
            if (matches.length === 0) {
                return { text: `I couldn't find anything matching "${escapeHtml(term)}".`, matchedRules: [] };
            }
            if (matches.length === 1) {
                return { text: formatPositionAnswer(matches[0], rulesList), matchedRules: [matches[0]] };
            }
            pendingContext = { matches, term };
            return { text: formatDisambiguationPrompt(term, matches), matchedRules: [] };
        }

        // ── 3. "first/second/2nd rule of X" ────────────────────────
        const nthMatch = lower.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?)\s+(?:rule|one)\s+of\s+(.+?)\??$/);
        if (nthMatch) {
            const ord = parseOrdinal(nthMatch[1]) || 1;
            const term = nthMatch[2].trim();
            const matches = findRulesMatchingTerm(term, rulesList);
            if (matches.length === 0) {
                return { text: `I couldn't find anything matching "${escapeHtml(term)}".`, matchedRules: [] };
            }
            if (matches[ord - 1]) {
                return { text: formatRule(matches[ord - 1]), matchedRules: [matches[ord - 1]] };
            }
            return {
                text: `"${escapeHtml(term)}" only has ${matches.length} matching rule(s) — there's no #${ord}.`,
                matchedRules: []
            };
        }

        // ── 4. Plain search (existing behavior, extended) ──────────
        const ruleKeywords = ["rule of", "what is", "tell me about", "explain", "define", "show me"];
        let searchTerm = query;
        for (const keyword of ruleKeywords) {
            if (lower.includes(keyword)) {
                searchTerm = query.substring(lower.indexOf(keyword) + keyword.length).trim();
                break;
            }
        }
        if (!searchTerm) {
            return { text: `Please ask me about a specific rule. Example: "What is the rule of help?"`, matchedRules: [] };
        }

        const matchResult = fuzzyMatchRule(searchTerm, rulesList);

        // Check for multiple loose matches FIRST — this is what
        // surfaces ambiguity ("there are 2 rules matching 'help'")
        // instead of silently picking whichever one fuzzyMatchRule's
        // own internal find() happens to hit first.
        const looseMatches = findRulesMatchingTerm(searchTerm, rulesList);
        if (looseMatches.length === 1) {
            return { text: formatRule(looseMatches[0]), matchedRules: [looseMatches[0]] };
        }
        if (looseMatches.length > 1) {
            pendingContext = { matches: looseMatches, term: searchTerm };
            return { text: formatDisambiguationPrompt(searchTerm, looseMatches), matchedRules: [] };
        }

        // No loose (substring) match at all — fall back to the
        // existing exact/typo-tolerant matcher as a safety net (its
        // isPartialMatch word-subsequence logic catches a few cases a
        // plain substring check doesn't).
        if (matchResult.exactMatch) {
            return { text: formatRule(matchResult.rule), matchedRules: [matchResult.rule] };
        }

        if (matchResult.suggestions && matchResult.suggestions.length > 0) {
            pendingContext = { matches: matchResult.suggestions, term: searchTerm };
            const names = matchResult.suggestions.map((r, i) => `${i + 1}. ${stripHtml(r.ruleName)}`).join("\n");
            return {
                text: `No exact match for "${escapeHtml(searchTerm)}". Did you mean:\n\n${names}\n\nReply "all", or a number/word like "first".`,
                matchedRules: []
            };
        }

        return {
            text: `I couldn't find a rule matching "${escapeHtml(searchTerm)}". Try a different keyword or check the spelling.`,
            matchedRules: []
        };
    }

    return { respond, reset };
}
