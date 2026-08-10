import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { auth, db, MYMEMORY_API_URL } from "./firebase-config.js";

// FIX: import auth and db from firebase-config instead of re-initializing

// Cache for translations
const translationCache = new Map();

// Check if user is allowed to use a specific language
export async function isLanguageAllowed(languageCode) {
    const user = auth.currentUser;
    if (!user) return false;

    try {
        const userRef = doc(db, "users", user.uid);
        const userDoc = await getDoc(userRef);
        if (userDoc.exists()) {
            const allowedLanguages = userDoc.data().allowedLanguages || [];
            return allowedLanguages.includes(languageCode);
        }
    } catch (error) {
        console.error("Error checking language permission:", error);
    }
    return false;
}

// Translate text using MyMemory API
export async function translateText(text, targetLang) {
    if (targetLang === "en") return text;

    const cacheKey = `${text}_${targetLang}`;
    if (translationCache.has(cacheKey)) {
        return translationCache.get(cacheKey);
    }

    try {
        const url = `${MYMEMORY_API_URL}?q=${encodeURIComponent(text)}&langpair=en|${targetLang}&de=upsc-rule-keeper@app.com`;
        const response = await fetch(url);
        const data = await response.json();

        let translatedText = data.responseData.translatedText;
        translatedText = translatedText.replace(/&#39;/g, "'").replace(/&quot;/g, '"');

        translationCache.set(cacheKey, translatedText);
        return translatedText;
    } catch (error) {
        console.error("Translation error:", error);
        return text;
    }
}

// Translate an entire rule object
export async function translateRule(rule, targetLang) {
    if (targetLang === "en") return rule;

    const translatedRule = { ...rule };
    if (rule.definition) translatedRule.definition = await translateText(rule.definition, targetLang);
    if (rule.keyPoints) translatedRule.keyPoints = await translateText(rule.keyPoints, targetLang);
    if (rule.examples) translatedRule.examples = await translateText(rule.examples, targetLang);

    return translatedRule;
}

// Get user's allowed languages
export async function getUserAllowedLanguages() {
    const user = auth.currentUser;
    if (!user) return [];

    try {
        const userRef = doc(db, "users", user.uid);
        const userDoc = await getDoc(userRef);
        if (userDoc.exists()) {
            return userDoc.data().allowedLanguages || [];
        }
    } catch (error) {
        console.error("Error fetching allowed languages:", error);
    }
    return [];
}

// Update language dropdown based on user's allowed languages
export async function updateLanguageDropdown() {
    const allowedLanguages = await getUserAllowedLanguages();
    const languageSelect = document.getElementById("language-select");
    if (!languageSelect) return;

    languageSelect.innerHTML = '<option value="en">English</option>';

    const languageNames = {
        bn: "বাংলা (Bengali)",
        hi: "हिंदी (Hindi)",
        ur: "اردو (Urdu)"
    };

    allowedLanguages.forEach(lang => {
        if (languageNames[lang]) {
            const option = document.createElement("option");
            option.value = lang;
            option.textContent = languageNames[lang];
            languageSelect.appendChild(option);
        }
    });

    const savedLang = localStorage.getItem("preferredLanguage") || "en";
    if (Array.from(languageSelect.options).some(opt => opt.value === savedLang)) {
        languageSelect.value = savedLang;
    } else {
        languageSelect.value = "en";
    }

    // Show dropdown only if user has extra languages
    languageSelect.style.display = allowedLanguages.length > 0 ? "block" : "none";
}

// Batch translate multiple rules — uses Promise.all for parallel speed
export async function translateRulesBatch(rules, targetLang) {
    if (targetLang === "en") return rules;
    return Promise.all(rules.map(rule => translateRule(rule, targetLang)));
}