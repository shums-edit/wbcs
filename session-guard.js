/* ============================================================
   UPSC RULE KEEPER — session-guard.js (NEW FILE)
   Version: 2.7.0 (2026-08-09)
   Single-active-session enforcement — one ID/password can only be
   logged in on one device/tab at a time, for both students and the
   admin. No backend needed: implemented entirely with a token field
   on the account's own Firestore document plus a real-time listener.

   HOW IT WORKS:
   1. Every time a page confirms "this browser is authenticated as
      this account" — whether that came from a fresh login or from an
      already-persisted session — it immediately claims the session:
      writes a fresh random token to that account's Firestore doc,
      overwriting whatever was there.
   2. That same page then watches that field in real time. The moment
      it changes to something else (because some OTHER tab/device
      just claimed it), this page knows it's no longer the active
      session and signs itself out.

   This deliberately claims on EVERY authenticated page load, not
   just at explicit login — that's what makes it not matter whether a
   second tab got there via a fresh login or by silently inheriting a
   persisted session (e.g. the known link-opened-child-tab case):
   either way, the moment it becomes active, it claims the account for
   itself and the previous session gets kicked automatically.

   No Firestore rules changes needed: this just writes to a new field
   on documents (users/{uid} for students, settings/admin for the
   admin) that the account already has permission to write to.
   ============================================================ */

import { onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const SESSION_TOKEN_FIELD = "activeSessionToken";

function generateSessionToken() {
    return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Claims the session for this tab: writes a fresh token to docRef,
 * overwriting any previous session's token. Returns the token this
 * tab should watch for (compare against in watchSession).
 */
export async function claimSession(docRef) {
    const token = generateSessionToken();
    await setDoc(docRef, { [SESSION_TOKEN_FIELD]: token }, { merge: true });
    return token;
}

/**
 * Watches docRef in real time. If the token field ever changes to
 * something other than myToken (meaning another session claimed the
 * account), calls onKicked(). Returns the unsubscribe function —
 * call it if the page is intentionally signing out on its own (e.g.
 * a normal Logout click), so the act of signing out doesn't trigger
 * a stale listener callback after the fact.
 */
export function watchSession(docRef, myToken, onKicked) {
    return onSnapshot(docRef, (snap) => {
        if (!snap.exists()) return;
        const current = snap.data()[SESSION_TOKEN_FIELD];
        if (current && current !== myToken) {
            onKicked();
        }
    }, (err) => {
        console.error("Session watch error:", err);
    });
}

/**
 * Watches a disabledUsers/{uid} doc in real time. Calls onDisabled()
 * the moment that doc exists — whether it already existed when this
 * started watching, or an admin creates it while the student is
 * actively using the app. Returns the unsubscribe function.
 */
export function watchDisabledStatus(disabledDocRef, onDisabled) {
    return onSnapshot(disabledDocRef, (snap) => {
        if (snap.exists()) {
            onDisabled();
        }
    }, (err) => {
        console.error("Disabled-status watch error:", err);
    });
}
