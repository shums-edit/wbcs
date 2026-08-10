/* ============================================================
   UPSC RULE KEEPER — categories.js (NEW FILE)
   Version: 2.1.0 (2026-08-08)
   Shared category list — single source of truth for both the admin
   rule editor's dropdown and the student dashboard's filter dropdown,
   so a category added in admin always shows up for students too.
   Custom categories are stored in the PRIMARY project's Firestore
   only (collection "categories") — categories are just labels, not
   bulky data, so there's no need to chain this across projects.
   ============================================================ */

import { collection, getDocs, doc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from "./firebase-config.js";
import { escapeHtml } from "./sanitize.js";

export const DEFAULT_CATEGORIES = [
    "English", "Polity", "Geography", "History", "Economy",
    "Science", "Environment", "Current Affairs"
];

let categoryCache = null;

/**
 * Returns the full category list: defaults + any custom ones added via
 * "Other…", deduplicated case-insensitively, defaults first (in their
 * original order) then custom ones alphabetically.
 */
export async function getAllCategories() {
    if (categoryCache) return categoryCache;

    let custom = [];
    try {
        const snapshot = await getDocs(collection(db, "categories"));
        custom = snapshot.docs.map(d => d.data().name).filter(Boolean);
    } catch (err) {
        console.error("Failed to load custom categories:", err);
    }

    const seen = new Set(DEFAULT_CATEGORIES.map(c => c.toLowerCase()));
    const extra = custom
        .filter(c => {
            const key = c.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => a.localeCompare(b));

    categoryCache = [...DEFAULT_CATEGORIES, ...extra];
    return categoryCache;
}

/** Call after adding a new category so the next getAllCategories() re-reads it. */
export function resetCategoryCache() {
    categoryCache = null;
}

/**
 * Adds a new custom category. Returns the trimmed name that was saved.
 * Throws if the name is empty or already exists (case-insensitive).
 */
export async function addCategory(rawName) {
    const name = (rawName || "").trim();
    if (!name) throw new Error("Category name can't be empty.");
    if (name.length > 40) throw new Error("Category name is too long.");

    const existing = await getAllCategories();
    if (existing.some(c => c.toLowerCase() === name.toLowerCase())) {
        throw new Error(`"${name}" already exists.`);
    }

    // Doc ID from the name keeps it naturally unique/idempotent; strip
    // characters Firestore doc IDs don't like.
    const docId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || `cat_${Date.now()}`;
    await setDoc(doc(db, "categories", docId), {
        name,
        addedAt: new Date().toISOString()
    });

    resetCategoryCache();
    return name;
}

/**
 * Populates a <select> element with the full category list. Preserves
 * the element's currently selected value if it's still in the list
 * after refresh (used when re-populating after adding a new one).
 * Always appends an "＋ Other…" option at the end when includeOther
 * is true (used by the admin rule editor, not the student filter).
 */
export async function populateCategorySelect(selectEl, { includeOther = false, includeAllOption = false } = {}) {
    if (!selectEl) return;
    const categories = await getAllCategories();
    const previousValue = selectEl.value;

    let html = "";
    if (includeAllOption) html += `<option value="all">All Categories</option>`;
    categories.forEach(cat => {
        html += `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`;
    });
    if (includeOther) html += `<option value="__other__">＋ Other…</option>`;

    selectEl.innerHTML = html;

    if (previousValue && Array.from(selectEl.options).some(o => o.value === previousValue)) {
        selectEl.value = previousValue;
    }
}
