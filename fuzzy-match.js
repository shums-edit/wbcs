// Levenshtein distance for fuzzy matching
function levenshteinDistance(a, b) {
    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j; // FIX: was [j] (wrapped in array by mistake)
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

// Normalize text for comparison (remove extra spaces, lowercase)
function normalizeText(text) {
    return text.toLowerCase().trim().replace(/\s+/g, " ");
}

// Check if a term is a partial match of a rule name
function isPartialMatch(searchTerm, ruleName) {
    const normalizedSearch = normalizeText(searchTerm);
    const normalizedRule = normalizeText(ruleName);

    if (normalizedRule.includes(normalizedSearch)) return true;

    const searchWords = normalizedSearch.split(" ");
    const ruleWords = normalizedRule.split(" ");

    if (searchWords.length < ruleWords.length) {
        let matchIndex = 0;
        for (const ruleWord of ruleWords) {
            if (matchIndex < searchWords.length && ruleWord === searchWords[matchIndex]) {
                matchIndex++;
            }
        }
        if (matchIndex === searchWords.length) return true;
    }

    return false;
}

// Fuzzy match a rule based on search term
export function fuzzyMatchRule(searchTerm, rulesList) {
    if (!rulesList || rulesList.length === 0) {
        return { exactMatch: false, suggestions: [] };
    }

    const normalizedSearch = normalizeText(searchTerm);

    // Exact match (case insensitive)
    const exactMatch = rulesList.find(rule =>
        normalizeText(rule.ruleName) === normalizedSearch ||
        rule.ruleName.toLowerCase() === searchTerm.toLowerCase()
    );
    if (exactMatch) return { exactMatch: true, rule: exactMatch };

    // Partial match
    const partialMatch = rulesList.find(rule => isPartialMatch(searchTerm, rule.ruleName));
    if (partialMatch) return { exactMatch: true, rule: partialMatch };

    // Levenshtein fuzzy match
    const scoredRules = rulesList.map(rule => {
        const distance = levenshteinDistance(normalizedSearch, normalizeText(rule.ruleName));
        const maxLen = Math.max(normalizedSearch.length, normalizeText(rule.ruleName).length);
        const similarity = 1 - (distance / maxLen);
        return { rule, similarity };
    });

    scoredRules.sort((a, b) => b.similarity - a.similarity);

    const suggestions = scoredRules
        .filter(item => item.similarity > 0.5)
        .slice(0, 3)
        .map(item => item.rule);

    return suggestions.length > 0
        ? { exactMatch: false, suggestions }
        : { exactMatch: false, suggestions: [] };
}

// Get top suggestion for a search term
export function getSuggestion(searchTerm, rulesList) {
    const result = fuzzyMatchRule(searchTerm, rulesList);
    if (!result.exactMatch && result.suggestions.length > 0) {
        return result.suggestions[0];
    }
    return null;
}