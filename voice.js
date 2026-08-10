/* ============================================================
   UPSC RULE KEEPER — voice.js
   Version: 4.0.0 (2026-08-10)
   Changelog: chatbot logic delegated to the new chatbot-engine.js
   (rule-based dialogue engine — intent classification, conversation
   memory, template responses) instead of the simple inline
   prefix-stripping + single "yes" flow this used to have. This file
   is now just UI wiring (voice input, chat window, message rendering)
   plus translation — the "brain" lives in chatbot-engine.js.
   ============================================================ */

import { translateText, isLanguageAllowed } from "./translation.js";
import { createChatbotEngine } from "./chatbot-engine.js";

let recognition = null;
let isListening = false;

// Initialize speech recognition
function initSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        console.warn("Speech recognition not supported in this browser");
        return null;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const instance = new SpeechRecognition();
    instance.continuous = false;
    instance.interimResults = false;
    instance.lang = "en-US";
    return instance;
}

// Voice search on dashboard
export function initVoiceSearch(inputElement, onResult) {
    const voiceBtn = document.getElementById("voice-search-btn");
    if (!voiceBtn || !inputElement) return;

    voiceBtn.addEventListener("click", () => {
        if (!recognition) {
            recognition = initSpeechRecognition();
            if (!recognition) {
                alert("Voice search not supported in your browser. Please use Chrome, Edge, or Safari.");
                return;
            }
        }

        if (isListening) {
            recognition.stop();
            isListening = false;
            voiceBtn.classList.remove("listening");
            return;
        }

        recognition.lang = "en-US";
        recognition.start();
        isListening = true;
        voiceBtn.classList.add("listening");

        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            inputElement.value = transcript;
            if (onResult) onResult(transcript);
            isListening = false;
            voiceBtn.classList.remove("listening");
        };

        recognition.onerror = () => {
            isListening = false;
            voiceBtn.classList.remove("listening");
        };

        recognition.onend = () => {
            isListening = false;
            voiceBtn.classList.remove("listening");
        };
    });
}

// Chatbot voice input
function initChatbotVoice(chatInput, onSend) {
    const voiceBtn = document.getElementById("chat-voice-btn");
    if (!voiceBtn) return;

    voiceBtn.addEventListener("click", () => {
        if (!recognition) {
            recognition = initSpeechRecognition();
            if (!recognition) {
                alert("Voice input not supported in your browser.");
                return;
            }
        }

        const preferredLang = localStorage.getItem("preferredLanguage") || "en";
        const langMap = { bn: "bn-IN", hi: "hi-IN", ur: "ur-PK", en: "en-US" };
        recognition.lang = langMap[preferredLang] || "en-US";

        recognition.start();
        voiceBtn.classList.add("listening");

        recognition.onresult = async (event) => {
            let transcript = event.results[0][0].transcript;

            if (preferredLang !== "en") {
                const isAllowed = await isLanguageAllowed(preferredLang);
                if (isAllowed) {
                    transcript = await translateText(transcript, "en");
                }
            }

            chatInput.value = transcript;
            if (onSend) onSend(transcript);
            voiceBtn.classList.remove("listening");
        };

        recognition.onerror = () => { voiceBtn.classList.remove("listening"); };
        recognition.onend = () => { voiceBtn.classList.remove("listening"); };
    });
}

// Render chat message — supports **bold** markdown
function renderMessage(text) {
    // FIX: convert **bold** to <strong> so it renders properly
    return text
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
}

// Main chatbot initializer — called from dashboard.js after rules load
export function initChatbot(rulesList, onRuleFound) {
    const chatToggle = document.getElementById("chatbot-toggle");
    const chatWindow = document.getElementById("chatbot-window");
    const chatClose = document.getElementById("chatbot-close");
    const chatInput = document.getElementById("chat-input");
    const chatSend = document.getElementById("chat-send-btn");
    const chatMessages = document.getElementById("chat-messages");

    if (!chatToggle || !chatWindow || !chatInput || !chatSend || !chatMessages) {
        console.warn("Chatbot elements not found in DOM.");
        return;
    }

    const engine = createChatbotEngine();

    // Toggle chatbot window
    chatToggle.addEventListener("click", () => {
        chatWindow.style.display = chatWindow.style.display === "none" ? "flex" : "none";
    });

    if (chatClose) {
        chatClose.addEventListener("click", () => {
            chatWindow.style.display = "none";
            engine.reset(); // clear any pending disambiguation question
        });
    }

    function addMessage(text, isUser) {
        const messageDiv = document.createElement("div");
        messageDiv.className = isUser ? "user-message" : "bot-message";
        // FIX: use innerHTML with rendered markdown for bot, textContent for user
        if (isUser) {
            messageDiv.textContent = text;
        } else {
            messageDiv.innerHTML = renderMessage(text);
        }
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    async function processQuery(query) {
        addMessage(query, true);

        const { text, matchedRules } = engine.respond(query, rulesList);
        let response = text;

        const selectedLang = document.getElementById("language-select")?.value;
        if (selectedLang && selectedLang !== "en") {
            const isAllowed = await isLanguageAllowed(selectedLang);
            if (isAllowed) {
                response = await translateText(response, selectedLang);
            }
        }

        addMessage(response, false);

        // Scroll to (and expand, per dashboard.js) the first matched
        // rule, if any. If the engine matched several ("all"), only
        // the first one gets scrolled to — no meaningful way to
        // scroll to more than one place at once.
        if (matchedRules.length > 0 && onRuleFound) {
            onRuleFound(matchedRules[0]);
        }
    }

    async function sendMessage() {
        const query = chatInput.value.trim();
        if (!query) return;
        chatInput.value = "";
        await processQuery(query);
    }

    chatSend.addEventListener("click", sendMessage);
    chatInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") sendMessage();
    });

    // Initialize voice input for chatbot
    initChatbotVoice(chatInput, sendMessage);
}
