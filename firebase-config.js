/* ============================================================
   UPSC RULE KEEPER — firebase-config.js
   Version: 2.1.0 (2026-08-08)
   Changelog: added support for chaining multiple Firebase projects
   ("firebaseChain") so the rules collection can spill over into a
   new project once the primary approaches its free-tier storage cap.

   SCOPING NOTE (read this before changing anything here):
   Only the "rules" collection is chained across multiple projects.
   Auth, users, pendingUsers, deletedUsers, settings, and categories
   ALWAYS live in the PRIMARY project only. Reasons:
     1. Firebase free-tier Firestore storage (1GB) is what actually
        fills up fast from lots of rule text — student/user accounts
        are tiny by comparison and Firebase Auth itself has a very
        high free-tier user cap, so there's no real need to chain
        those.
     2. Splitting auth/user accounts across multiple Firebase projects
        would mean a student's login only works on whichever project
        their account happens to live in — a much bigger, riskier
        redesign than what was asked for.
   So: log in once, on the primary project, always. Rules are read
   from / written across the whole chain.
   ============================================================ */

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, setPersistence, browserSessionPersistence, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getFirestore, collection, getDocs, doc, setDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Firebase Configuration — PRIMARY project. Always holds Auth, users,
// pendingUsers, deletedUsers, settings, categories, and firebaseChain
// (the list of additional chained projects).
export const firebaseConfig = {
    apiKey: "AIzaSyAef63a-7QgT2CQt7XzjTmArNmAedNZfww",
    authDomain: "alpha-academy-368a6.firebaseapp.com",
    projectId: "alpha-academy-368a6",
    storageBucket: "alpha-academy-368a6.firebasestorage.app",
    messagingSenderId: "1061977020364",
    appId: "1:1061977020364:web:3a1b9c0dcd00093653af69"
};

// Single primary app instance — import this everywhere, never call
// initializeApp() again for the primary project.
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// LOGIN PERSISTENCE (v2.4.0 — reverted to browserSessionPersistence):
// By default Firebase keeps a login active across every tab/window
// and even after closing the browser, until an explicit signOut().
//
// v2.3.0 briefly switched this to inMemoryPersistence to close a real
// edge case (a link-opened child tab could inherit another tab's
// session). That turned out to be a worse regression: this is a
// MULTI-PAGE site — index.html, dashboard.html, and admin.html are
// separate HTML documents, and logging in navigates between them via
// window.location.replace(), a full page load. inMemoryPersistence
// stores the login ONLY in that page's JS memory, which is completely
// wiped on ANY navigation — so every single login was immediately
// followed by dashboard.html/admin.html seeing no user and bouncing
// straight back to index.html. It cannot survive page navigation at
// all, not just a new tab, so it's fundamentally incompatible with
// this site's architecture.
//
// browserSessionPersistence (sessionStorage) correctly survives
// navigation within the same tab — required for login to work at
// all here — while still not being shared with an independently
// opened new tab (typed URL, blank tab pasted in). Its one known gap
// is the narrower case of a tab spawned AS A CHILD of another tab
// (a clicked link, ctrl+click, etc.), which can inherit sessionStorage
// per browser spec. That's a real gap, but a working login matters
// far more, so this is accepted for now.
//
// NOT awaited at the top level, on purpose: an earlier version used
// `await setPersistence(...)` here, which blocks this entire module —
// and therefore every file that imports `auth` from it, including
// auth.js, which wires up the Login button's click handler — from
// finishing evaluation until the call resolves. In some browser
// profiles that call could be slow or behave unpredictably, which
// silently broke login entirely: the page would render, but the click
// handlers would never actually finish attaching. Firing it here
// without awaiting is safe — no sign-in ever happens automatically at
// page load, and by the time a person types credentials and clicks
// Login, this local call (milliseconds) has long since resolved.
setPersistence(auth, browserSessionPersistence).catch(err => {
    console.error("Failed to set session persistence — falling back to Firebase's default:", err);
});

// MyMemory API (free, no key needed)
export const MYMEMORY_API_URL = "https://api.mymemory.translated.net/get";

// Admin settings collection in Firestore
export const ADMIN_SETTINGS_COLLECTION = "settings";
export const ADMIN_SETTINGS_DOC = "admin";

// Default batch timing for all students
export const DEFAULT_BATCH_TIMING = "12:00 PM to 02:00 PM";

// ── STORAGE ESTIMATE CONSTANTS ──────────────────────────────
// Firestore free tier (Spark plan) storage cap, per project.
export const STORAGE_CAP_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
// Only warn once a project's estimated usage crosses this — silent
// before that, per your instruction ("don't give me at 90%, give me
// at 95%"). Applies to CHAINED projects, which hold rules content
// only — no account data, so no reservation needed.
export const STORAGE_WARNING_THRESHOLD = 0.95;

// The PRIMARY project is different: it's the ONLY place account data
// (students, pending approvals, settings) ever lives, and account
// data must never get crowded out by rules content filling up the
// project. So on primary specifically, rules stop being written there
// — and the warning fires — at 80% instead of 95%, permanently
// reserving that last 20% purely for accounts. Confirmed: a generous,
// deliberately safe reserve, not a tight one — rules content is by
// far the larger consumer of space (10–50x a student record), so 20%
// of a full gigabyte is enormously more room than account data will
// realistically ever need, even with hundreds of students.
export const PRIMARY_RULES_THRESHOLD = 0.80;

/**
 * Rough byte-size estimate of one rule document's text content.
 * This is an ESTIMATE, not a real Firestore usage number — Firebase
 * doesn't expose live storage usage to client-side JS at all (that
 * data only lives in the Firebase Console / requires a paid backend
 * with the Cloud Billing API). This gives a practical early-warning
 * signal instead of nothing.
 */
export function estimateRuleBytes(ruleData) {
    const fields = [
        ruleData.ruleName, ruleData.chapter, ruleData.category,
        ruleData.definition, ruleData.keyPoints, ruleData.examples,
        ruleData.ruleId, ruleData.createdAt, ruleData.lastUpdated
    ];
    let bytes = 0;
    fields.forEach(f => { if (f) bytes += new Blob([String(f)]).size; });
    // Firestore also charges ~32 bytes of overhead per document plus
    // per-field name overhead — pad a flat +200 bytes/doc so the
    // estimate leans cautious (better to warn a little early than late).
    return bytes + 200;
}

// ── CHAINED FIREBASE PROJECTS ───────────────────────────────
// Cache of initialized chained apps so we don't re-initialize on
// every call within the same page load.
let chainedDbsCache = null;

/**
 * Reads the list of chained Firebase projects from the PRIMARY
 * project's Firestore ("firebaseChain" collection), initializes each
 * as a separate named Firebase app, and returns their Firestore
 * instances. Cached per page load — call resetFirebaseChainCache()
 * after adding a new project so it picks it up without a refresh.
 */
export async function getChainedDbs() {
    if (chainedDbsCache) return chainedDbsCache;

    const results = [];
    try {
        const snapshot = await getDocs(collection(db, "firebaseChain"));
        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            const appName = `chain_${docSnap.id}`;
            try {
                const chainedApp = getApps().some(a => a.name === appName)
                    ? getApp(appName)
                    : initializeApp(data.config, appName);
                const chainedAuth = getAuth(chainedApp);
                // Same persistence mode as the primary app, so an admin
                // session established on this chained project (see
                // establishChainedAuth below) survives page navigation
                // the same way the primary login does. Fire-and-forget —
                // not awaited, same reasoning as the primary setup above.
                setPersistence(chainedAuth, browserSessionPersistence).catch(() => {});
                results.push({
                    id: docSnap.id,
                    label: data.label || data.config.projectId,
                    db: getFirestore(chainedApp),
                    auth: chainedAuth,
                    config: data.config
                });
            } catch (err) {
                console.error(`Failed to initialize chained Firebase project "${docSnap.id}":`, err);
            }
        });
    } catch (err) {
        console.error("Failed to load Firebase chain list:", err);
    }

    chainedDbsCache = results;
    return results;
}

/**
 * Signs the admin into ONE chained project's own Firebase Auth, using
 * the same email/password as the primary project. This is the actual
 * fix for "can't write to chained projects": Firebase Auth is
 * per-project, so being logged in on the primary project does nothing
 * for a chained project's security rules — request.auth there is only
 * ever populated by actually signing in to THAT project too.
 *
 * Self-healing: the first time this runs for a given chained project,
 * no matching account exists there yet, so sign-in fails with
 * auth/user-not-found — in that case, create one with the same
 * credentials (safe: we only ever call this once the caller has
 * already verified this really is the admin on the primary project).
 * Every login after that just signs in normally.
 */
async function establishChainedAuth(chainedAuth, email, password) {
    try {
        await signInWithEmailAndPassword(chainedAuth, email, password);
    } catch (err) {
        if (err.code === "auth/user-not-found") {
            await createUserWithEmailAndPassword(chainedAuth, email, password);
        } else {
            throw err;
        }
    }
}

/**
 * Call this once, right after the admin's PRIMARY login succeeds (see
 * auth.js) — signs them into every currently-chained project's own
 * Auth too, so request.auth is populated everywhere for the rest of
 * this session, letting every project use the exact same security
 * rule for writes. One project failing to authenticate doesn't block
 * the others or the primary login itself — logged, not thrown.
 */
export async function signInAdminToAllChainedProjects(email, password) {
    const chained = await getChainedDbs();
    await Promise.all(chained.map(async (project) => {
        try {
            await establishChainedAuth(project.auth, email, password);
        } catch (err) {
            console.error(`Failed to authenticate admin on chained project "${project.id}":`, err);
        }
    }));
}

/** Call after adding/removing a chained project so the next getChainedDbs()/getAllRuleDbs() re-reads the list. */
export function resetFirebaseChainCache() {
    chainedDbsCache = null;
}

/**
 * Returns every Firestore instance that "rules" should be read from /
 * searched across: the primary project's db first, then every chained
 * project's db, in the order they were added.
 */
export async function getAllRuleDbs() {
    const chained = await getChainedDbs();
    return [
        { id: "primary", label: "Primary (alpha-academy-368a6)", db },
        ...chained
    ];
}

/**
 * Validates a pasted Firebase config object by attempting to actually
 * initialize a throwaway app and open Firestore with it. Does NOT
 * write anything — the caller decides whether to save it after this
 * succeeds. Throws on failure with a human-readable reason.
 */
export async function testFirebaseConfig(config) {
    const required = ["apiKey", "authDomain", "projectId", "appId"];
    for (const key of required) {
        if (!config[key]) throw new Error(`Missing required field: ${key}`);
    }
    const testAppName = `test_${Date.now()}`;
    try {
        const testApp = initializeApp(config, testAppName);
        const testDb  = getFirestore(testApp);
        // A lightweight read — succeeds even on an empty/new collection,
        // but fails fast on bad credentials/project ID/network issues.
        await getDocs(collection(testDb, "rules"));
        return true;
    } catch (err) {
        throw new Error(`Could not connect to that Firebase project: ${err.message}`);
    }
}

/**
 * Saves a validated Firebase config into the chain (primary project's
 * Firestore) and resets the cache so it's picked up immediately.
 * adminEmail/adminPassword (optional but strongly recommended) let
 * this also set up the admin's matching Auth account on the new
 * project right away — see establishChainedAuth above for why that's
 * necessary. Without them, the project is added but writes to it will
 * fail until the admin's next login.
 */
export async function addFirebaseToChain(config, label, adminEmail, adminPassword) {
    await testFirebaseConfig(config);
    const chainId = `proj_${Date.now()}`;
    await setDoc(doc(db, "firebaseChain", chainId), {
        config,
        label: label || config.projectId,
        addedAt: new Date().toISOString()
    });
    resetFirebaseChainCache();

    if (adminEmail && adminPassword) {
        const chained = await getChainedDbs();
        const newEntry = chained.find(p => p.id === chainId);
        if (newEntry) {
            try {
                await establishChainedAuth(newEntry.auth, adminEmail, adminPassword);
            } catch (err) {
                console.error("Failed to establish admin auth on newly added project:", err);
                throw new Error(`Project connected, but couldn't set up write access on it: ${err.message}. Try logging out and back in, which will retry this automatically.`);
            }
        }
    }

    return chainId;
}

/** Removes a project from the chain. Does NOT delete or touch any data in that project — just stops reading/writing to it from this app. */
export async function removeFirebaseFromChain(chainId) {
    await deleteDoc(doc(db, "firebaseChain", chainId));
    resetFirebaseChainCache();
}
