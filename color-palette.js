/* ============================================================
   UPSC RULE KEEPER — color-palette.js (NEW FILE)
   Version: 2.6.0 (2026-08-09)
   Saved text-color / highlight-color swatches for the admin's rich-
   text toolbar — synced via Firestore (settings/colorPalette) so the
   same palette follows the admin across any device/browser, not just
   the one they saved a color on. Text and highlight colors are kept
   as two separate lists, since they're typically used for different
   purposes (e.g. dark readable colors for text vs. light colors for
   highlighting).
   ============================================================ */

import { doc, getDoc, setDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from "./firebase-config.js";

const PALETTE_DOC_REF = () => doc(db, "settings", "colorPalette");
const MAX_SWATCHES_PER_TYPE = 16; // keeps the swatch row from growing unbounded

let cache = null;

/** Returns { textColors: [...], highlightColors: [...] } — cached per page load. */
export async function getSavedColors() {
    if (cache) return cache;
    try {
        const snap = await getDoc(PALETTE_DOC_REF());
        cache = snap.exists()
            ? { textColors: snap.data().textColors || [], highlightColors: snap.data().highlightColors || [] }
            : { textColors: [], highlightColors: [] };
    } catch (err) {
        console.error("Failed to load saved colors:", err);
        cache = { textColors: [], highlightColors: [] };
    }
    return cache;
}

function resetCache() {
    cache = null;
}

/**
 * Saves a color into the palette (type: "text" or "highlight").
 * Uses arrayUnion so it's safe even if two admins/tabs save at once —
 * no read-then-write race, and it's a no-op if that exact color is
 * already saved.
 */
export async function saveColor(type, colorHex) {
    const existing = await getSavedColors();
    const field = type === "highlight" ? "highlightColors" : "textColors";
    if (existing[field].includes(colorHex)) return; // already saved, nothing to do
    if (existing[field].length >= MAX_SWATCHES_PER_TYPE) {
        throw new Error(`You can save up to ${MAX_SWATCHES_PER_TYPE} ${type} colors — remove one first.`);
    }
    await setDoc(PALETTE_DOC_REF(), { [field]: arrayUnion(colorHex) }, { merge: true });
    resetCache();
}

/** Removes a saved color (right-click / long-press on a swatch to remove it). */
export async function removeColor(type, colorHex) {
    const field = type === "highlight" ? "highlightColors" : "textColors";
    await setDoc(PALETTE_DOC_REF(), { [field]: arrayRemove(colorHex) }, { merge: true });
    resetCache();
}
