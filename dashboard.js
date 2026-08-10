/* ============================================================
   UPSC RULE KEEPER — dashboard.js
   Version: 2.1.0 (2026-08-08)
   Changelog:
     - rules now load from every chained Firebase project and merge
       (see getAllRuleDbs() in firebase-config.js)
     - category filter now pulled from the shared categories.js list
       (defaults + anything the admin added via "Other…")
     - dark-mode / voice-search icon buttons swap between SVG icon
       states instead of emoji (icons themselves render from
       dashboard.html; this file just toggles which one shows)
     - (v2.0.0) recentSearches save debounced 600ms instead of firing
       on every keystroke
   ============================================================ */

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection, getDocs, doc, getDoc, updateDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import { auth, db, getAllRuleDbs } from "./firebase-config.js";
import { initChatbot, initVoiceSearch } from "./voice.js";
import { updateLanguageDropdown } from "./translation.js";
import { escapeHtml, stripHtml, sanitizeRichText } from "./sanitize.js";
import { startAutoLogoutTimer } from "./inactivity-timer.js";
import { claimSession, watchSession, watchDisabledStatus } from "./session-guard.js";

let currentUser = null;
let unwatchSession = null; // unsubscribe function from the session-guard listener
let unwatchDisabled = null; // unsubscribe function from the disabled-status listener
let allRules    = [];
let userData    = null;
let currentTab  = "rules";

// Card expand/collapse state (v3.0.0). expandedRuleIds tracks which
// cards are currently open — persists across re-renders within this
// page session (e.g. typing further in search) but not across a full
// reload. multiExpandMode controls whether opening a new card leaves
// others open (true) or closes whatever was previously open (false,
// the default) — saved to localStorage so it's remembered next visit,
// same pattern as the dark-mode preference.
let expandedRuleIds = new Set();
let multiExpandMode = localStorage.getItem("multiExpandCards") === "true";

// ── SECURITY: prevent back button from re-entering dashboard after logout ──
history.pushState(null, "", window.location.href);
window.addEventListener("popstate", () => {
    history.pushState(null, "", window.location.href);
});

// ── SPLASH SCREEN ──────────────────────────────────────────
function hideSplashScreen() {
    const splash = document.getElementById("splash-screen");
    if (!splash) return;
    setTimeout(() => {
        splash.classList.add("hidden");
        setTimeout(() => { splash.style.display = "none"; }, 600);
    }, 1500);
}

// ── UTILITIES ──────────────────────────────────────────────
// escapeHtml and stripHtml now come from sanitize.js (previously
// duplicated here with a stripHtml implementation that could execute
// payloads while trying to strip them — fixed in the shared module).

// Render stored HTML content safely (allows bold/italic/underline/
// color/highlight only, with all attributes stripped except a
// validated style= on <span> — see sanitize.js).
function renderFormattedText(html) {
    if (!html) return "";
    return sanitizeRichText(html).replace(/\n/g, "<br>");
}

function generateAvatar(fullName) {
    const nameParts = fullName.trim().split(/\s+/);
    if (nameParts.length >= 2) return (nameParts[0][0] + nameParts[1][0]).toUpperCase();
    return fullName.substring(0, 2).toUpperCase();
}

function formatDate(dateString) {
    if (!dateString) return "Unknown";
    const date = new Date(dateString);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    if (diffDays >= 7) return date.toLocaleDateString();
    const diffHours = Math.floor((now - date) / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours} hour(s) ago`;
    return `${diffDays} day(s) ago`;
}

function generateRuleId(category, docId) {
    const prefix = (category || "GEN").substring(0, 3).toUpperCase();
    const shortId = docId.substring(0, 4).toUpperCase();
    return `${prefix}-${shortId}`;
}

// ── SORT HELPERS ─────────────────────────────────────────────
// A rule's admin-set "Rule Date" (separate from lastUpdated/createdAt,
// which just track when the record was edited) — used by the
// "Date — Newest/Oldest First" sort options. Rules with no date set
// always sink to the bottom regardless of sort direction, rather than
// being treated as either the oldest or newest by default.
function getRuleTimestamp(rule) {
    if (!rule.ruleDate) return null;
    const t = new Date(rule.ruleDate).getTime();
    return isNaN(t) ? null : t;
}

function sortRules(rules, sortMode) {
    const sorted = [...rules];
    if (sortMode === "date-desc" || sortMode === "date-asc") {
        sorted.sort((a, b) => {
            const ta = getRuleTimestamp(a);
            const tb = getRuleTimestamp(b);
            if (ta === null && tb === null) return 0;
            if (ta === null) return 1;  // no date → always last
            if (tb === null) return -1;
            return sortMode === "date-desc" ? tb - ta : ta - tb;
        });
    } else {
        // "alpha" (default)
        sorted.sort((a, b) => stripHtml(a.ruleName).localeCompare(stripHtml(b.ruleName)));
    }
    return sorted;
}

// ── CHAPTER FILTER ─────────────────────────────────────────
function populateChapterFilter(rules) {
    const chapterFilter = document.getElementById("chapter-filter");
    // Use plain text chapter names for filter values (rules store HTML)
    const chapters = [...new Set(
        rules.map(r => stripHtml(r.chapter)).filter(Boolean)
    )].sort();
    chapterFilter.innerHTML = '<option value="all">All Chapters</option>';
    chapters.forEach(ch => {
        const opt = document.createElement("option");
        opt.value = ch;       // plain text for comparison
        opt.textContent = ch; // plain text for display — safe, textContent never parses HTML
        chapterFilter.appendChild(opt);
    });
    chapterFilter.style.display = chapters.length > 0 ? "block" : "none";
}

// ── CATEGORY FILTER ─────────────────────────────────────────
// Unlike the admin's rule-editor category dropdown (which shows every
// category ever created, via categories.js — the admin needs to be
// able to pick a brand-new empty category for the first rule in it),
// the STUDENT filter only lists categories that actually have at
// least one rule right now. Otherwise students have to click through
// categories with nothing in them just to find out they're empty.
function populateCategoryFilter(rules) {
    const categoryFilter = document.getElementById("category-filter");
    const previousValue = categoryFilter.value;

    const categoriesPresent = [...new Set(
        rules.map(r => r.category).filter(Boolean)
    )].sort();

    let html = '<option value="all">All Categories</option>';
    categoriesPresent.forEach(cat => {
        html += `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`;
    });
    categoryFilter.innerHTML = html;

    // Keep the previously selected category if it's still present after
    // a rules reload; otherwise fall back to "All Categories" rather
    // than silently pointing at a category that just disappeared.
    if (previousValue && Array.from(categoryFilter.options).some(o => o.value === previousValue)) {
        categoryFilter.value = previousValue;
    }
}

// ── LOAD RULES (across every chained Firebase project) ──────
async function loadRules() {
    const container = document.getElementById("rules-container");
    container.innerHTML = "<p>⏳ Loading rules...</p>";
    try {
        const ruleDbs = await getAllRuleDbs();

        // Query every project's "rules" collection in parallel, then
        // merge. A rule's `id` stays its own Firestore doc ID (auto-
        // generated IDs are effectively globally unique, so collisions
        // across projects are not a realistic concern), tagged with
        // which project it came from for admin-side edit/delete routing.
        const perProjectResults = await Promise.all(
            ruleDbs.map(async ({ id: projectId, db: projectDb }) => {
                try {
                    const rulesQuery = query(collection(projectDb, "rules"), orderBy("ruleName"));
                    const snapshot   = await getDocs(rulesQuery);
                    return snapshot.docs.map(docSnap => ({
                        id: docSnap.id,
                        __projectId: projectId,
                        ...docSnap.data()
                    }));
                } catch (err) {
                    console.error(`Failed to load rules from project "${projectId}":`, err);
                    return [];
                }
            })
        );

        allRules = perProjectResults.flat().sort((a, b) =>
            stripHtml(a.ruleName).localeCompare(stripHtml(b.ruleName))
        );

        populateChapterFilter(allRules);
        populateCategoryFilter(allRules);
        displayRules(allRules);

        initChatbot(allRules, (rule) => {
            expandedRuleIds.add(rule.id);
            displayRules(allRules);
            const el = document.querySelector(`[data-rule-id="${rule.id}"]`);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        });

        initVoiceSearch(
            document.getElementById("search-input"),
            () => displayRules(allRules)
        );

        hideSplashScreen();

    } catch (error) {
        console.error("Failed to load rules:", error);
        container.innerHTML = "<p>❌ Failed to load rules. Please check your connection and refresh.</p>";
        hideSplashScreen();
    }
}

// ── DISPLAY RULES ──────────────────────────────────────────
function displayRules(rules) {
    const container     = document.getElementById("rules-container");
    const searchTerm    = document.getElementById("search-input").value.toLowerCase();
    const categoryFilter = document.getElementById("category-filter").value;
    const chapterFilter  = document.getElementById("chapter-filter").value;

    let filtered = rules;

    if (searchTerm) {
        filtered = filtered.filter(rule =>
            stripHtml(rule.ruleName).toLowerCase().includes(searchTerm) ||
            (rule.chapter && stripHtml(rule.chapter).toLowerCase().includes(searchTerm)) ||
            (rule.definition && stripHtml(rule.definition).toLowerCase().includes(searchTerm))
        );
    }

    if (categoryFilter !== "all") {
        filtered = filtered.filter(rule => rule.category === categoryFilter);
    }

    if (chapterFilter !== "all") {
        filtered = filtered.filter(rule => stripHtml(rule.chapter) === chapterFilter);
    }

    const sortMode = document.getElementById("sort-select")?.value || "alpha";
    filtered = sortRules(filtered, sortMode);

    if (filtered.length === 0) {
        container.innerHTML = "<p>No rules found.</p>";
        return;
    }

    // A card is expanded if the student manually opened it, OR the
    // active search term matches inside its hidden content (chapter/
    // definition — not just the title, which is already visible
    // either way) so they can immediately see why it matched without
    // an extra click.
    function matchesHiddenContent(rule) {
        if (!searchTerm) return false;
        const inChapter    = rule.chapter    && stripHtml(rule.chapter).toLowerCase().includes(searchTerm);
        const inDefinition = rule.definition && stripHtml(rule.definition).toLowerCase().includes(searchTerm);
        return inChapter || inDefinition;
    }

    container.innerHTML = filtered.map(rule => {
        const isExpanded = expandedRuleIds.has(rule.id) || matchesHiddenContent(rule);
        return `
        <div class="rule-card" data-rule-id="${rule.id}">
            <div class="rule-header rule-header-clickable" data-toggle-id="${rule.id}">
                <div style="flex:1; min-width:0;">
                    <div>
                        <span class="rule-title">${renderFormattedText(rule.ruleName)}</span>
                        <span class="rule-id">(${escapeHtml(rule.ruleId || generateRuleId(rule.category, rule.id))})</span>
                    </div>
                    ${rule.chapter ? `<div class="rule-chapter">📖 Chapter: ${renderFormattedText(rule.chapter)}</div>` : ""}
                    ${rule.category ? `<div style="font-size:12px; color:#999; margin-top:2px;">🏷️ ${escapeHtml(rule.category)}</div>` : ""}
                </div>
                <div style="display:flex; gap:5px; align-items:center; flex-shrink:0;">
                    <button class="bookmark-btn ${userData.bookmarks?.includes(rule.id) ? "active" : ""}" data-rule-id="${rule.id}">⭐</button>
                    <button class="copy-btn" data-rule-id="${rule.id}">Copy</button>
                    <span class="rule-expand-chevron">${isExpanded ? "▴" : "▾"}</span>
                </div>
            </div>
            <div class="rule-card-body" ${isExpanded ? "" : 'style="display:none;"'}>
                ${rule.definition ? `<div class="rule-definition"><strong>Definition:</strong> ${renderFormattedText(rule.definition)}</div>` : ""}
                ${rule.keyPoints ? `<div class="rule-points"><strong>Key Points:</strong><br>${renderFormattedText(rule.keyPoints)}</div>` : ""}
                ${rule.examples ? `<div class="rule-examples"><strong>Examples:</strong><br>${renderFormattedText(rule.examples)}</div>` : ""}
                <div class="rule-footer" style="margin-top:8px;">
                    <small style="color:#999;">Last updated: ${formatDate(rule.lastUpdated || rule.createdAt)}</small>
                </div>
            </div>
        </div>
    `;
    }).join("");

    // Card expand/collapse — clicking the header toggles that card's
    // body, except when the click was actually on the bookmark/copy
    // buttons (those have their own handlers below and shouldn't also
    // toggle the card).
    document.querySelectorAll(".rule-header-clickable").forEach(header => {
        header.addEventListener("click", (e) => {
            if (e.target.closest(".bookmark-btn") || e.target.closest(".copy-btn")) return;
            const ruleId = header.dataset.toggleId;

            if (expandedRuleIds.has(ruleId)) {
                expandedRuleIds.delete(ruleId);
            } else {
                if (!multiExpandMode) expandedRuleIds.clear(); // single-open mode: close whatever else was open
                expandedRuleIds.add(ruleId);
            }
            displayRules(allRules);
        });
    });

    // Bookmark buttons
    document.querySelectorAll(".bookmark-btn").forEach(btn => {
        btn.addEventListener("click", () => toggleBookmark(btn.dataset.ruleId));
    });

    // Copy buttons — copy plain text version
    document.querySelectorAll(".copy-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const rule = allRules.find(r => r.id === btn.dataset.ruleId);
            if (!rule) return;
            const text = [
                rule.ruleName,
                rule.chapter ? `Chapter: ${rule.chapter}` : "",
                rule.definition ? `Definition: ${rule.definition}` : "",
                rule.keyPoints ? `Key Points: ${rule.keyPoints}` : "",
                rule.examples ? `Examples: ${rule.examples}` : ""
            ].filter(Boolean).join("\n\n")
            // Strip HTML tags for clipboard
            .replace(/<[^>]+>/g, "");
            navigator.clipboard.writeText(text);
            alert("✅ Rule copied to clipboard!");
        });
    });
}

// ── BOOKMARK ───────────────────────────────────────────────
async function toggleBookmark(ruleId) {
    if (!currentUser) return;
    let bookmarks = userData.bookmarks || [];
    bookmarks = bookmarks.includes(ruleId)
        ? bookmarks.filter(id => id !== ruleId)
        : [...bookmarks, ruleId];

    try {
        await updateDoc(doc(db, "users", currentUser.uid), { bookmarks });
        userData.bookmarks = bookmarks;
    } catch (error) {
        console.error("Failed to update bookmark:", error);
        alert("❌ Could not update bookmark. Please try again.");
        return;
    }

    if (currentTab === "bookmarks") showBookmarks();
    else displayRules(allRules);
}

function showBookmarks() {
    const bookmarkedRules = allRules.filter(rule => userData.bookmarks?.includes(rule.id));
    if (bookmarkedRules.length === 0) {
        document.getElementById("rules-container").innerHTML = "<p>No bookmarks yet. Click ⭐ on any rule to bookmark it.</p>";
        return;
    }
    displayRules(bookmarkedRules);
}

function showRecentSearches() {
    const searches = userData.recentSearches || [];
    if (searches.length === 0) {
        document.getElementById("rules-container").innerHTML = "<p>No recent searches yet.</p>";
        return;
    }
    const matched = searches.map(term =>
        allRules.filter(r => r.ruleName.toLowerCase().includes(term.toLowerCase())).slice(0, 3)
    ).flat().slice(0, 10);
    displayRules(matched);
}

// ── DARK MODE ICON SWAP ─────────────────────────────────────
// Two SVG icon markups live in dashboard.html as <template>s
// (#icon-moon / #icon-sun) so this file never has to inline SVG
// strings — it just swaps which template's content shows.
function updateDarkModeIcon() {
    const btn = document.getElementById("dark-mode-toggle");
    if (!btn) return;
    const isDark = document.body.classList.contains("dark-mode");
    const templateId = isDark ? "icon-sun" : "icon-moon";
    const tpl = document.getElementById(templateId);
    if (tpl) {
        btn.innerHTML = "";
        btn.appendChild(tpl.content.cloneNode(true));
    }
    btn.title = isDark ? "Switch to light mode" : "Switch to dark mode";
}

// ── MAIN ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {

    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            hideSplashScreen();
            window.location.replace("index.html");
            return;
        }

        try {
            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);

            if (!userDoc.exists()) {
                await signOut(auth);
                hideSplashScreen();
                window.location.replace("index.html");
                return;
            }

            // Blocked/disabled accounts stop here — checked before
            // anything else loads. See also the live watcher below,
            // which catches a disable that happens WHILE this tab is
            // already open.
            const disabledRef = doc(db, "disabledUsers", user.uid);
            const disabledDoc = await getDoc(disabledRef);
            if (disabledDoc.exists()) {
                await signOut(auth);
                hideSplashScreen();
                window.location.replace("index.html");
                return;
            }

            currentUser = user;
            userData    = userDoc.data();

            document.getElementById("avatar").textContent         = userData.avatar || generateAvatar(userData.fullName);
            document.getElementById("student-name").textContent   = userData.fullName;
            document.getElementById("student-email-sidebar").textContent = userData.email;
            document.getElementById("student-batch").textContent  = "UPSC / WBCS / SSC - CGL"; // fixed label, not a time
            document.getElementById("student-joined").textContent = userData.joinedDate;

            await updateLanguageDropdown();
            await loadRules();

            // Auto-logout after 3 minutes of inactivity — shared timer
            // with the admin panel (see inactivity-timer.js).
            startAutoLogoutTimer({ auth, timerElementId: "student-auto-logout-timer" });

            // Single-active-session enforcement: claims this account
            // for this tab, and any other tab/device previously logged
            // in with the same account gets signed out automatically —
            // see session-guard.js for how this works.
            const myToken = await claimSession(userRef);
            unwatchSession = watchSession(userRef, myToken, async () => {
                unwatchSession = null;
                alert("⚠️ This account was just logged in on another device or tab, so you've been signed out here.");
                await signOut(auth);
                window.location.replace("index.html");
            });

            // Live-watches for the admin disabling this account WHILE
            // it's actively in use — not just blocked on next login.
            unwatchDisabled = watchDisabledStatus(disabledRef, async () => {
                unwatchDisabled = null;
                if (unwatchSession) { unwatchSession(); unwatchSession = null; }
                alert("🚫 Your account has been disabled by the admin. You've been signed out.");
                await signOut(auth);
                window.location.replace("index.html");
            });

        } catch (error) {
            console.error("Dashboard auth error:", error);
            document.getElementById("rules-container").innerHTML = "<p>❌ Something went wrong. Please refresh.</p>";
            hideSplashScreen();
        }
    });

    // Tab switching
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentTab = btn.dataset.tab;
            if (currentTab === "bookmarks") showBookmarks();
            else if (currentTab === "rules") displayRules(allRules);
            else if (currentTab === "recent") showRecentSearches();
        });
    });

    // Search
    // NOTE: recentSearches save is debounced (600ms after typing stops) —
    // previously it fired a Firestore write on every single keystroke,
    // which is unnecessary read/write cost and can hit rate limits on
    // fast typers. displayRules() itself stays instant/unthrottled since
    // that's just local filtering, no network call.
    let searchSaveTimer = null;
    document.getElementById("search-input").addEventListener("input", (e) => {
        const searchTerm = e.target.value.trim();

        clearTimeout(searchSaveTimer);
        if (searchTerm && currentUser) {
            searchSaveTimer = setTimeout(async () => {
                try {
                    let recent = userData.recentSearches || [];
                    recent = [searchTerm, ...recent.filter(s => s !== searchTerm)].slice(0, 5);
                    await updateDoc(doc(db, "users", currentUser.uid), { recentSearches: recent });
                    userData.recentSearches = recent;
                } catch (err) { console.error("Recent search save failed:", err); }
            }, 600);
        }

        displayRules(allRules);
    });

    // Category filter
    document.getElementById("category-filter").addEventListener("change", () => displayRules(allRules));

    // Chapter filter
    document.getElementById("chapter-filter").addEventListener("change", () => displayRules(allRules));

    // Sort order
    document.getElementById("sort-select").addEventListener("change", () => displayRules(allRules));

    // Logout — SECURITY: sign out then replace history so back button can't re-enter
    document.getElementById("logout-btn-sidebar").addEventListener("click", async () => {
        if (unwatchSession) { unwatchSession(); unwatchSession = null; }
        if (unwatchDisabled) { unwatchDisabled(); unwatchDisabled = null; }
        await signOut(auth);
        window.location.replace("index.html");
    });

    // Dark mode
    document.getElementById("dark-mode-toggle").addEventListener("click", () => {
        document.body.classList.toggle("dark-mode");
        localStorage.setItem("darkMode", document.body.classList.contains("dark-mode"));
        updateDarkModeIcon();
    });

    if (localStorage.getItem("darkMode") === "true") {
        document.body.classList.add("dark-mode");
    }
    updateDarkModeIcon();

    // Multi-expand cards toggle — off by default (single card open at
    // a time); switching it on lets multiple stay open together.
    const multiExpandToggle = document.getElementById("multi-expand-toggle");
    multiExpandToggle.checked = multiExpandMode;
    multiExpandToggle.addEventListener("change", () => {
        multiExpandMode = multiExpandToggle.checked;
        localStorage.setItem("multiExpandCards", multiExpandMode);
        if (!multiExpandMode && expandedRuleIds.size > 1) {
            // Switching off with several already open — keep just one
            // (the most recently opened) rather than an ambiguous mix.
            const last = [...expandedRuleIds].pop();
            expandedRuleIds.clear();
            expandedRuleIds.add(last);
        }
        displayRules(allRules);
    });
});
