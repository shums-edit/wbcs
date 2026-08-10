/* ============================================================
   UPSC RULE KEEPER — admin.js
   Version: 2.1.0 (2026-08-08)
   Changelog:
     - Recycle Bin: "Delete All" button (confirm → wipe deletedUsers)
     - Rule categories are dynamic now (categories.js): "Other…" in
       the dropdown lets the admin add a new one on the fly, which
       then shows up for every future rule AND on the student side
     - Rules now read from / write across every chained Firebase
       project (see firebase-config.js's getAllRuleDbs()). New rules
       are saved to whichever project in the chain still has room.
     - Settings tab: Firebase chain list + "add new project" form,
       plus a storage estimate warning banner (only shown ≥95% full —
       see estimateRuleBytes()/STORAGE_WARNING_THRESHOLD in
       firebase-config.js; this is an ESTIMATE, Firebase has no
       client-side "how full am I" API)
     - (v2.0.0) admin rules table: stripHtml() output is now escaped
       before being inserted into innerHTML — was a stored-XSS gap
       via double-decoded entities
     - (v2.0.0) rule ID generation: added random suffix to avoid
       same-second collisions
     - (v2.0.0) admin shell hidden behind a loading gate until the
       Firebase admin check passes (see admin.html / style.css)
   ============================================================ */

import { onAuthStateChanged, signOut, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection, getDocs, doc, getDoc, setDoc, updateDoc,
    deleteDoc, addDoc, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import {
    auth, db, getAllRuleDbs, estimateRuleBytes,
    STORAGE_CAP_BYTES, STORAGE_WARNING_THRESHOLD, PRIMARY_RULES_THRESHOLD,
    testFirebaseConfig, addFirebaseToChain, removeFirebaseFromChain, resetFirebaseChainCache,
    signInAdminToAllChainedProjects
} from "./firebase-config.js";
import { escapeHtml, stripHtml, sanitizeRichText } from "./sanitize.js";
import { getAllCategories, addCategory, populateCategorySelect, resetCategoryCache } from "./categories.js";
import { startAutoLogoutTimer } from "./inactivity-timer.js";
import { claimSession, watchSession } from "./session-guard.js";

let adminEmail       = null;
let adminPanelLoaded = false;
let unwatchSession   = null; // unsubscribe function from the session-guard listener

// Rules currently loaded in the admin panel, each tagged with which
// chained project it lives in (__projectId). Used for edit/delete
// routing and for the storage-usage estimate.
let allRulesAdmin = [];
let ruleDbsCache  = []; // [{ id, label, db }, ...] — primary first

// ── SECURITY: prevent back button from re-entering admin after logout ──
history.pushState(null, "", window.location.href);
window.addEventListener("popstate", () => {
    history.pushState(null, "", window.location.href);
});

document.addEventListener("DOMContentLoaded", () => {

    const gate          = document.getElementById("admin-loading-gate");
    const loginSection  = document.getElementById("admin-login-section");
    const panelSection  = document.getElementById("admin-panel-container");
    const loginMsgEl    = document.getElementById("admin-login-message");

    function showLoginForm(message) {
        loginSection.style.display = "flex";
        panelSection.style.display = "none";
        if (message) {
            loginMsgEl.textContent = message;
            loginMsgEl.style.color = "#ff4757";
        } else {
            loginMsgEl.textContent = "";
        }
    }

    function showAdminPanel() {
        loginSection.style.display = "none";
        panelSection.style.display = "block";
    }

    // ── AUTH CHECK ─────────────────────────────────────────────
    // v2.7.0: admin.html is now self-contained — not authenticated
    // shows the login form right here instead of redirecting to
    // index.html (which no longer has an admin face at all).
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            if (gate) gate.style.display = "none";
            showLoginForm();
            return;
        }

        if (adminPanelLoaded) return;

        try {
            const settingsRef = doc(db, "settings", "admin");
            const settingsDoc = await getDoc(settingsRef);

            if (!settingsDoc.exists() || user.email !== settingsDoc.data().adminEmail) {
                await signOut(auth);
                if (gate) gate.style.display = "none";
                showLoginForm("❌ Not authorized as admin.");
                return;
            }

            adminPanelLoaded = true;
            adminEmail = settingsDoc.data().adminEmail;
            document.getElementById("current-admin-email").value = adminEmail;

            // Only now — after Firebase has confirmed this is the admin —
            // do we reveal the admin panel shell.
            if (gate) gate.style.display = "none";
            showAdminPanel();

            await Promise.all([
                loadPendingUsers(),
                loadActiveUsers(),
                loadDeletedUsers(),
                loadRules(),
                loadFirebaseChainSettings()
            ]);

            // Auto-logout after 3 minutes of inactivity — shared with
            // the student dashboard's timer (see inactivity-timer.js)
            // so both panels always use the same duration.
            startAutoLogoutTimer({ auth, timerElementId: "auto-logout-timer", redirectTo: "admin.html" });

            // Single-active-session enforcement: claims the admin
            // account for this tab — any other tab/device previously
            // logged in as admin gets signed out automatically. See
            // session-guard.js for how this works.
            const myToken = await claimSession(settingsRef);
            unwatchSession = watchSession(settingsRef, myToken, async () => {
                unwatchSession = null;
                alert("⚠️ The admin account was just logged in on another device or tab, so you've been signed out here.");
                await signOut(auth);
                window.location.reload();
            });

        } catch (error) {
            console.error("Admin auth check failed:", error);
            if (gate) gate.style.display = "none";
            showLoginForm("❌ Failed to load admin panel. Please try again.");
        }
    });

    // ── ADMIN LOGIN FORM SUBMIT ──────────────────────────────────
    // Moved here from auth.js/index.html — this is now the only place
    // admin login happens. onAuthStateChanged above picks up a
    // successful sign-in automatically and reveals the panel.
    async function attemptAdminLogin() {
        const email    = document.getElementById("admin-login-email").value.trim();
        const password = document.getElementById("admin-login-password").value;
        const btn      = document.getElementById("admin-login-submit-btn");

        if (!email || !password) {
            loginMsgEl.textContent = "❌ Please enter admin email and password.";
            loginMsgEl.style.color = "#ff4757";
            return;
        }

        btn.disabled = true;
        btn.textContent = "Logging in...";
        loginMsgEl.textContent = "";

        try {
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const settingsRef = doc(db, "settings", "admin");
            const settingsDoc = await getDoc(settingsRef);

            if (settingsDoc.exists() && userCredential.user.email === settingsDoc.data().adminEmail) {
                // Also sign into every chained Firebase project's own
                // Auth (see firebase-config.js for why this is needed).
                // Capped at 1.5s so login never feels slow regardless
                // of how many chained projects exist.
                const timeout = new Promise(resolve => setTimeout(resolve, 1500));
                await Promise.race([
                    signInAdminToAllChainedProjects(email, password).catch(err => {
                        console.error("Failed to sign in to one or more chained projects:", err);
                    }),
                    timeout
                ]);
                // onAuthStateChanged fires now and reveals the panel.
            } else {
                await auth.signOut();
                loginMsgEl.textContent = "❌ Not authorized as admin.";
                loginMsgEl.style.color = "#ff4757";
            }
        } catch (error) {
            loginMsgEl.textContent = "❌ Invalid admin credentials.";
            loginMsgEl.style.color = "#ff4757";
        } finally {
            btn.disabled = false;
            btn.textContent = "LOGIN AS ADMIN";
        }
    }

    document.getElementById("admin-login-submit-btn").addEventListener("click", attemptAdminLogin);
    document.getElementById("admin-login-email").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); attemptAdminLogin(); }
    });
    document.getElementById("admin-login-password").addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); attemptAdminLogin(); }
    });

    // ── TAB SWITCHING ──────────────────────────────────────────
    document.querySelectorAll(".admin-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".admin-tab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            document.querySelectorAll(".admin-tab-content").forEach(c => c.classList.remove("active"));
            const target = document.getElementById(`${btn.dataset.tab}-tab`);
            if (target) target.classList.add("active");
        });
    });

    // ── PENDING USERS ──────────────────────────────────────────
    async function loadPendingUsers() {
        const container = document.getElementById("pending-users-list");
        container.innerHTML = "<p>⏳ Loading...</p>";
        try {
            const pendingRef = collection(db, "pendingUsers");
            const snapshot   = await getDocs(pendingRef);

            if (snapshot.empty) {
                container.innerHTML = "<p>✅ No pending requests.</p>";
                return;
            }

            container.innerHTML = `
                <table class="user-table">
                    <thead><tr><th>Name</th><th>Email</th><th>Requested On</th><th>Actions</th></tr></thead>
                    <tbody>
                        ${snapshot.docs.map(d => `
                            <tr>
                                <td>${escapeHtml(d.data().fullName)}</td>
                                <td>${escapeHtml(d.data().email)}</td>
                                <td>${escapeHtml(d.data().joinedDate)}</td>
                                <td>
                                    <button class="btn-small approve-btn" data-user-id="${d.id}"
                                        style="background:#28a745;">✅ Approve</button>
                                    <button class="btn-small reject-btn" data-user-id="${d.id}"
                                        style="background:#ff4757; margin-left:5px;">❌ Reject</button>
                                </td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>`;

            container.querySelectorAll(".approve-btn").forEach(btn =>
                btn.addEventListener("click", () => approveUser(btn.dataset.userId)));
            container.querySelectorAll(".reject-btn").forEach(btn =>
                btn.addEventListener("click", () => rejectUser(btn.dataset.userId)));

        } catch (error) {
            console.error("Failed to load pending users:", error);
            container.innerHTML = "<p>❌ Failed to load pending users.</p>";
        }
    }

    async function approveUser(userId) {
        if (!confirm("Approve this student? They will be able to login immediately.")) return;
        try {
            const pendingRef = doc(db, "pendingUsers", userId);
            const pendingDoc = await getDoc(pendingRef);
            if (!pendingDoc.exists()) { alert("❌ User not found."); return; }

            await setDoc(doc(db, "users", userId), {
                ...pendingDoc.data(),
                approvedAt: new Date().toISOString()
            });
            await deleteDoc(pendingRef);

            alert("✅ Student approved! They can now login.");
            await loadPendingUsers();
            await loadActiveUsers();
        } catch (error) {
            console.error("Approve failed:", error);
            alert("❌ Failed to approve. Check Firestore rules.");
        }
    }

    async function rejectUser(userId) {
        if (!confirm("Reject this student? Their request will be permanently deleted.")) return;
        try {
            await deleteDoc(doc(db, "pendingUsers", userId));
            alert("✅ Request rejected.");
            await loadPendingUsers();
        } catch (error) {
            console.error("Reject failed:", error);
            alert("❌ Failed to reject. Check Firestore rules.");
        }
    }

    // ── ACTIVE USERS ───────────────────────────────────────────
    async function loadActiveUsers() {
        const container = document.getElementById("active-users-list");
        container.innerHTML = "<p>⏳ Loading...</p>";
        try {
            const [snapshot, disabledSnapshot] = await Promise.all([
                getDocs(collection(db, "users")),
                getDocs(collection(db, "disabledUsers"))
            ]);
            const disabledUids = new Set(disabledSnapshot.docs.map(d => d.id));

            if (snapshot.empty) {
                container.innerHTML = "<p>No active students yet.</p>";
                return;
            }

            container.innerHTML = `
                <table class="user-table">
                    <thead><tr><th>Name</th><th>Email</th><th>Batch</th><th>Joined</th><th>Languages</th><th>Actions</th></tr></thead>
                    <tbody>
                        ${snapshot.docs.map(d => {
                            const isDisabled = disabledUids.has(d.id);
                            return `
                            <tr>
                                <td>${escapeHtml(d.data().fullName)}</td>
                                <td>${escapeHtml(d.data().email)}</td>
                                <td>UPSC / WBCS / SSC - CGL</td>
                                <td>${escapeHtml(d.data().joinedDate)}</td>
                                <td>
                                    <button class="btn-small languages-btn" data-user-id="${d.id}">🌐 Languages</button>
                                </td>
                                <td>
                                    <button class="btn-small toggle-disable-btn" data-user-id="${d.id}" data-currently-disabled="${isDisabled}"
                                        style="background:${isDisabled ? "#28a745" : "#ffa502"};">
                                        ${isDisabled ? "✅ Enable" : "🚫 Disable"}
                                    </button>
                                    <button class="btn-small delete-user-btn" data-user-id="${d.id}"
                                        style="background:#ff4757; margin-left:5px;">🗑️ Remove</button>
                                </td>
                            </tr>`;
                        }).join("")}
                    </tbody>
                </table>`;

            container.querySelectorAll(".languages-btn").forEach(btn =>
                btn.addEventListener("click", () => openLanguageModal(btn.dataset.userId)));
            container.querySelectorAll(".toggle-disable-btn").forEach(btn =>
                btn.addEventListener("click", () => toggleDisableUser(btn.dataset.userId, btn.dataset.currentlyDisabled === "true")));
            container.querySelectorAll(".delete-user-btn").forEach(btn =>
                btn.addEventListener("click", () => softDeleteUser(btn.dataset.userId)));

        } catch (error) {
            console.error("Failed to load active users:", error);
            container.innerHTML = "<p>❌ Failed to load students.</p>";
        }
    }

    async function toggleDisableUser(userId, currentlyDisabled) {
        const verb = currentlyDisabled ? "Enable" : "Disable";
        if (!confirm(`${verb} this student's access?${currentlyDisabled ? "" : " They'll be signed out immediately if currently logged in, and blocked from logging back in until re-enabled."}`)) return;
        try {
            if (currentlyDisabled) {
                await deleteDoc(doc(db, "disabledUsers", userId));
            } else {
                await setDoc(doc(db, "disabledUsers", userId), { disabledAt: new Date().toISOString() });
            }
            await loadActiveUsers();
        } catch (error) {
            console.error("Toggle disable failed:", error);
            alert("❌ Failed to update. Check Firestore rules.");
        }
    }

    async function softDeleteUser(userId) {
        if (!confirm("Move this student to recycle bin?")) return;
        try {
            const userRef = doc(db, "users", userId);
            const userDoc = await getDoc(userRef);
            if (userDoc.exists()) {
                await setDoc(doc(db, "deletedUsers", userId), {
                    ...userDoc.data(),
                    deletedAt: new Date().toISOString()
                });
                await deleteDoc(userRef);
                // Clean up any disabled-status doc too — a deleted
                // account doesn't need one hanging around, and if
                // restored later it should come back enabled by default.
                await deleteDoc(doc(db, "disabledUsers", userId)).catch(() => {});
                alert("✅ Student moved to recycle bin.");
                await loadActiveUsers();
                await loadDeletedUsers();
            }
        } catch (error) {
            console.error("Delete failed:", error);
            alert("❌ Failed to remove student.");
        }
    }

    // ── DELETED USERS (RECYCLE BIN) ─────────────────────────────
    async function loadDeletedUsers() {
        const container = document.getElementById("deleted-users-list");
        container.innerHTML = "<p>⏳ Loading...</p>";
        try {
            const snapshot = await getDocs(collection(db, "deletedUsers"));

            if (snapshot.empty) {
                container.innerHTML = "<p>Recycle bin is empty.</p>";
                document.getElementById("delete-all-recycle-btn").style.display = "none";
                return;
            }

            document.getElementById("delete-all-recycle-btn").style.display = "inline-block";

            container.innerHTML = `
                <table class="user-table">
                    <thead><tr><th>Name</th><th>Email</th><th>Deleted On</th><th>Actions</th></tr></thead>
                    <tbody>
                        ${snapshot.docs.map(d => `
                            <tr>
                                <td>${escapeHtml(d.data().fullName)}</td>
                                <td>${escapeHtml(d.data().email)}</td>
                                <td>${new Date(d.data().deletedAt).toLocaleDateString()}</td>
                                <td>
                                    <button class="btn-small restore-btn" data-user-id="${d.id}">♻️ Restore</button>
                                    <button class="btn-small perm-delete-btn" data-user-id="${d.id}"
                                        style="background:#ff4757; margin-left:5px;">🗑️ Delete Forever</button>
                                </td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>`;

            container.querySelectorAll(".restore-btn").forEach(btn =>
                btn.addEventListener("click", () => restoreUser(btn.dataset.userId)));
            container.querySelectorAll(".perm-delete-btn").forEach(btn =>
                btn.addEventListener("click", () => permanentDeleteUser(btn.dataset.userId)));

        } catch (error) {
            console.error("Failed to load deleted users:", error);
            container.innerHTML = "<p>❌ Failed to load recycle bin.</p>";
        }
    }

    async function restoreUser(userId) {
        if (!confirm("Restore this student?")) return;
        try {
            const deletedRef = doc(db, "deletedUsers", userId);
            const deletedDoc = await getDoc(deletedRef);
            if (deletedDoc.exists()) {
                const data = { ...deletedDoc.data() };
                delete data.deletedAt;
                await setDoc(doc(db, "users", userId), { ...data, restoredAt: new Date().toISOString() });
                await deleteDoc(deletedRef);
                alert("✅ Student restored.");
                await loadActiveUsers();
                await loadDeletedUsers();
            }
        } catch (error) {
            console.error("Restore failed:", error);
            alert("❌ Failed to restore.");
        }
    }

    async function permanentDeleteUser(userId) {
        if (!confirm("⚠️ Permanently delete? This CANNOT be undone.")) return;
        try {
            await deleteDoc(doc(db, "deletedUsers", userId));
            await deleteDoc(doc(db, "disabledUsers", userId)).catch(() => {}); // safety net, usually already cleaned up by softDeleteUser
            alert("✅ Permanently deleted.");
            await loadDeletedUsers();
        } catch (error) {
            console.error("Permanent delete failed:", error);
            alert("❌ Failed to permanently delete.");
        }
    }

    // "Delete All" — wipes every doc in deletedUsers at once, so the
    // admin doesn't have to click "Delete Forever" one row at a time.
    document.getElementById("delete-all-recycle-btn").addEventListener("click", async () => {
        try {
            const snapshot = await getDocs(collection(db, "deletedUsers"));
            if (snapshot.empty) return;

            if (!confirm(`⚠️ Permanently delete all ${snapshot.size} student(s) in the recycle bin? This CANNOT be undone.`)) return;

            const btn = document.getElementById("delete-all-recycle-btn");
            btn.disabled = true;
            btn.textContent = "Deleting...";

            await Promise.all(snapshot.docs.map(d => deleteDoc(doc(db, "deletedUsers", d.id))));

            alert(`✅ Deleted ${snapshot.size} student(s) from the recycle bin.`);
            await loadDeletedUsers();
        } catch (error) {
            console.error("Delete all failed:", error);
            alert("❌ Failed to delete all. Check Firestore rules.");
        } finally {
            const btn = document.getElementById("delete-all-recycle-btn");
            btn.disabled = false;
            btn.textContent = "🗑️ DELETE ALL";
        }
    });

    // ── LANGUAGE MODAL ─────────────────────────────────────────
    async function openLanguageModal(userId) {
        const modal = document.getElementById("language-modal");
        document.getElementById("lang-user-id").value = userId;
        document.querySelectorAll("#language-modal input[type=checkbox]").forEach(cb => cb.checked = false);

        try {
            const userDoc = await getDoc(doc(db, "users", userId));
            if (userDoc.exists()) {
                (userDoc.data().allowedLanguages || []).forEach(lang => {
                    const cb = document.getElementById(`lang-${lang}`);
                    if (cb) cb.checked = true;
                });
            }
        } catch (error) { console.error("Failed to load languages:", error); }

        modal.style.display = "flex";
    }

    document.getElementById("save-languages-btn").addEventListener("click", async () => {
        const userId = document.getElementById("lang-user-id").value;
        const selected = Array.from(
            document.querySelectorAll("#language-modal input[type=checkbox]:checked")
        ).map(cb => cb.value);

        try {
            await updateDoc(doc(db, "users", userId), { allowedLanguages: selected });
            document.getElementById("language-modal").style.display = "none";
            alert(`✅ Languages updated: ${selected.join(", ") || "English only"}`);
        } catch (error) {
            console.error("Save languages failed:", error);
            alert("❌ Failed to save languages.");
        }
    });

    document.getElementById("close-rule-modal").addEventListener("click", () => {
        document.getElementById("rule-modal").style.display = "none";
    });
    document.getElementById("close-lang-modal").addEventListener("click", () => {
        document.getElementById("language-modal").style.display = "none";
    });

    // ── RULES MANAGEMENT (across every chained Firebase project) ──
    async function loadRules() {
        const container = document.getElementById("rules-list-admin");
        container.innerHTML = "<p>⏳ Loading...</p>";
        try {
            ruleDbsCache = await getAllRuleDbs();

            const perProjectResults = await Promise.all(
                ruleDbsCache.map(async ({ id: projectId, db: projectDb }) => {
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

            allRulesAdmin = perProjectResults.flat().sort((a, b) =>
                stripHtml(a.ruleName).localeCompare(stripHtml(b.ruleName))
            );

            if (allRulesAdmin.length === 0) {
                container.innerHTML = "<p>No rules yet. Click '+ ADD NEW RULE' to start.</p>";
            } else {
                container.innerHTML = `
                    <table class="rule-table">
                        <thead><tr><th>Rule ID</th><th>Rule Name</th><th>Category</th><th>Chapter</th><th>Project</th><th>Actions</th></tr></thead>
                        <tbody>
                            ${allRulesAdmin.map(rule => `
                                <tr>
                                    <td>${escapeHtml(rule.ruleId || "N/A")}</td>
                                    <td>${escapeHtml(stripHtml(rule.ruleName))}</td>
                                    <td>${escapeHtml(rule.category)}</td>
                                    <td>${escapeHtml(stripHtml(rule.chapter)) || "-"}</td>
                                    <td><span style="font-size:12px; color:#999;">${escapeHtml(labelForProject(rule.__projectId))}</span></td>
                                    <td>
                                        <button class="btn-small edit-rule-btn" data-rule-id="${rule.id}" data-project-id="${rule.__projectId}">✏️ Edit</button>
                                        <button class="btn-small delete-rule-btn" data-rule-id="${rule.id}" data-project-id="${rule.__projectId}"
                                            style="background:#ff4757; margin-left:5px;">🗑️ Delete</button>
                                    </td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>`;

                container.querySelectorAll(".edit-rule-btn").forEach(btn =>
                    btn.addEventListener("click", () => editRule(btn.dataset.ruleId, btn.dataset.projectId)));
                container.querySelectorAll(".delete-rule-btn").forEach(btn =>
                    btn.addEventListener("click", () => deleteRule(btn.dataset.ruleId, btn.dataset.projectId)));
            }

            await updateStorageWarningBanner();

        } catch (error) {
            console.error("Failed to load rules:", error);
            container.innerHTML = "<p>❌ Failed to load rules.</p>";
        }
    }

    function labelForProject(projectId) {
        const entry = ruleDbsCache.find(p => p.id === projectId);
        return entry ? entry.label : projectId;
    }

    function dbForProject(projectId) {
        const entry = ruleDbsCache.find(p => p.id === projectId);
        return entry ? entry.db : db;
    }

    // Picks which chained project new rules should be saved into: the
    // The threshold that applies to a given project: primary reserves
    // 20% for account data (never used by rules), so it's treated as
    // "full" for rules-writing/warning purposes at 80%. Chained
    // projects hold rules only, no reservation needed — 95%.
    function thresholdForProject(project) {
        return project.id === "primary" ? PRIMARY_RULES_THRESHOLD : STORAGE_WARNING_THRESHOLD;
    }

    // Picks which chained project new rules should be saved into: the
    // first one (in chain order, primary first) whose estimated usage
    // is still under ITS threshold (80% for primary, 95% for chained —
    // see thresholdForProject). Falls back to the last project in the
    // chain if every one of them is already over — saving still
    // succeeds, the storage banner is the actual signal to go add a
    // new project.
    function pickWriteTargetProject() {
        for (const project of ruleDbsCache) {
            const usageBytes = allRulesAdmin
                .filter(r => r.__projectId === project.id)
                .reduce((sum, r) => sum + estimateRuleBytes(r), 0);
            if (usageBytes / STORAGE_CAP_BYTES < thresholdForProject(project)) {
                return project;
            }
        }
        return ruleDbsCache[ruleDbsCache.length - 1];
    }

    async function updateStorageWarningBanner() {
        const banner = document.getElementById("storage-warning-banner");
        if (!banner) return;

        const overThreshold = ruleDbsCache
            .map(project => {
                const usageBytes = allRulesAdmin
                    .filter(r => r.__projectId === project.id)
                    .reduce((sum, r) => sum + estimateRuleBytes(r), 0);
                return { ...project, percent: (usageBytes / STORAGE_CAP_BYTES) * 100, thresholdPercent: thresholdForProject(project) * 100 };
            })
            .filter(p => p.percent >= p.thresholdPercent);

        if (overThreshold.length === 0) {
            banner.style.display = "none";
            banner.innerHTML = "";
            return;
        }

        banner.style.display = "flex";
        banner.innerHTML = `
            <span>⚠️ <strong>${overThreshold.map(p => `${escapeHtml(p.label)} (~${Math.round(p.percent)}% full, estimated)`).join(", ")}</strong>
            — add a new Firebase project from Settings before it runs out of room.</span>
        `;
    }

    // ── ADD / EDIT RULE MODAL ────────────────────────────────────
    document.getElementById("add-rule-btn").addEventListener("click", async () => {
        document.getElementById("modal-title").textContent = "Add New Rule";
        document.getElementById("rule-doc-id").value = "";
        document.getElementById("rule-project-id").value = "";
        document.getElementById("rule-name").innerHTML = "";
        document.getElementById("rule-chapter").innerHTML = "";
        document.getElementById("rule-definition").innerHTML = "";
        document.getElementById("rule-points").innerHTML = "";
        document.getElementById("rule-examples").innerHTML = "";
        document.getElementById("rule-date").value = "";
        document.getElementById("add-category-group").style.display = "none";
        document.getElementById("new-category-input").value = "";
        await populateCategorySelect(document.getElementById("rule-category"), { includeOther: true });
        document.getElementById("rule-modal").style.display = "flex";
    });

    async function editRule(ruleId, projectId) {
        try {
            const projectDb = dbForProject(projectId);
            const ruleDoc = await getDoc(doc(projectDb, "rules", ruleId));
            if (ruleDoc.exists()) {
                const d = ruleDoc.data();
                document.getElementById("modal-title").textContent = "Edit Rule";
                document.getElementById("rule-doc-id").value = ruleId;
                document.getElementById("rule-project-id").value = projectId;
                // Use innerHTML for rich text fields
                document.getElementById("rule-name").innerHTML       = d.ruleName   || "";
                document.getElementById("rule-chapter").innerHTML    = d.chapter    || "";
                document.getElementById("rule-definition").innerHTML = d.definition || "";
                document.getElementById("rule-points").innerHTML     = d.keyPoints  || "";
                document.getElementById("rule-examples").innerHTML   = d.examples   || "";
                document.getElementById("rule-date").value           = d.ruleDate   || "";
                document.getElementById("add-category-group").style.display = "none";
                document.getElementById("new-category-input").value = "";
                await populateCategorySelect(document.getElementById("rule-category"), { includeOther: true });
                document.getElementById("rule-category").value = d.category || "English";
                document.getElementById("rule-modal").style.display  = "flex";
            }
        } catch (error) {
            console.error("Edit rule load failed:", error);
            alert("❌ Failed to load rule.");
        }
    }

    async function deleteRule(ruleId, projectId) {
        if (!confirm("Delete this rule? Students will no longer see it.")) return;
        try {
            const projectDb = dbForProject(projectId);
            await deleteDoc(doc(projectDb, "rules", ruleId));
            alert("✅ Rule deleted.");
            await loadRules();
        } catch (error) {
            console.error("Delete rule failed:", error);
            alert("❌ Failed to delete rule.");
        }
    }

    // ── DYNAMIC CATEGORY: "Other…" handling ──────────────────────
    document.getElementById("rule-category").addEventListener("change", (e) => {
        const addGroup = document.getElementById("add-category-group");
        addGroup.style.display = e.target.value === "__other__" ? "block" : "none";
    });

    document.getElementById("add-category-btn").addEventListener("click", async () => {
        const input = document.getElementById("new-category-input");
        const btn = document.getElementById("add-category-btn");
        try {
            btn.disabled = true;
            const savedName = await addCategory(input.value);
            input.value = "";
            document.getElementById("add-category-group").style.display = "none";
            await populateCategorySelect(document.getElementById("rule-category"), { includeOther: true });
            document.getElementById("rule-category").value = savedName;
        } catch (error) {
            alert(`❌ ${error.message}`);
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById("save-rule-btn").addEventListener("click", async () => {
        const ruleDocId    = document.getElementById("rule-doc-id").value;
        const ruleProjectId = document.getElementById("rule-project-id").value;
        // Get innerHTML from contenteditable fields (preserves bold/italic/underline/color)
        const ruleName   = document.getElementById("rule-name").innerHTML.trim();
        const chapter    = document.getElementById("rule-chapter").innerHTML.trim();
        const definition = document.getElementById("rule-definition").innerHTML.trim();
        const keyPoints  = document.getElementById("rule-points").innerHTML.trim();
        const examples   = document.getElementById("rule-examples").innerHTML.trim();
        const categoryValue = document.getElementById("rule-category").value;

        if (!ruleName || ruleName === "<br>") {
            alert("Rule name is required.");
            return;
        }
        if (categoryValue === "__other__") {
            alert('Please click "+ ADD CATEGORY" to save your new category first, or pick an existing one.');
            return;
        }

        // Sanitize HTML — only allows b/strong/i/em/u/span(color) tags,
        // with all attributes stripped except a validated style= on
        // span (see sanitize.js). The old regex-only approach here let
        // e.g. <b onmouseover="..."> pass through untouched.
        const ruleData = {
            ruleName:    sanitizeRichText(ruleName),
            chapter:     sanitizeRichText(chapter),
            category:    categoryValue,
            definition:  sanitizeRichText(definition),
            keyPoints:   sanitizeRichText(keyPoints),
            examples:    sanitizeRichText(examples),
            ruleDate:    document.getElementById("rule-date").value || "", // optional — used for date-based sorting on the student side
            lastUpdated: new Date().toISOString()
        };

        try {
            if (!ruleDocId) {
                const targetProject = pickWriteTargetProject();
                const prefix = ruleData.category.substring(0, 3).toUpperCase();
                const rand   = Math.floor(Math.random() * 900 + 100); // 3-digit random suffix
                ruleData.ruleId    = `${prefix}-${Date.now().toString().slice(-4)}${rand}`;
                ruleData.createdAt = new Date().toISOString();
                await addDoc(collection(targetProject.db, "rules"), ruleData);
            } else {
                const projectDb = dbForProject(ruleProjectId);
                await updateDoc(doc(projectDb, "rules", ruleDocId), ruleData);
            }
            document.getElementById("rule-modal").style.display = "none";
            await loadRules();
            alert("✅ Rule saved!");
        } catch (error) {
            console.error("Save rule failed:", error);
            alert("❌ Failed to save rule.");
        }
    });

    // ── SETTINGS: ADMIN EMAIL ─────────────────────────────────────
    document.getElementById("update-admin-email-btn").addEventListener("click", async () => {
        const newEmail = document.getElementById("new-admin-email").value.trim();
        if (!newEmail) { alert("Please enter a new admin email."); return; }
        if (!confirm(`Change admin email to "${newEmail}"?`)) return;
        try {
            await setDoc(doc(db, "settings", "admin"), { adminEmail: newEmail });
            adminEmail = newEmail;
            document.getElementById("current-admin-email").value = newEmail;
            document.getElementById("new-admin-email").value = "";
            alert("✅ Admin email updated! Please logout and login with the new email.");
        } catch (error) {
            console.error("Update admin email failed:", error);
            alert("❌ Failed to update admin email.");
        }
    });

    // ── SETTINGS: FIREBASE CHAIN ──────────────────────────────────
    async function loadFirebaseChainSettings() {
        const container = document.getElementById("firebase-chain-list");
        container.innerHTML = "<p>⏳ Loading...</p>";
        try {
            const projects = await getAllRuleDbs();

            container.innerHTML = `
                <table class="user-table">
                    <thead><tr><th>Label</th><th>Type</th><th>Estimated Usage</th><th>Actions</th></tr></thead>
                    <tbody>
                        ${projects.map(p => {
                            const usageBytes = allRulesAdmin
                                .filter(r => r.__projectId === p.id)
                                .reduce((sum, r) => sum + estimateRuleBytes(r), 0);
                            const percent = Math.min(100, Math.round((usageBytes / STORAGE_CAP_BYTES) * 100));
                            const dangerAt = thresholdForProject(p) * 100;
                            const warnAt = dangerAt - 20; // a softer heads-up 20pts before the real cutoff
                            return `
                                <tr>
                                    <td>${escapeHtml(p.label)}</td>
                                    <td>${p.id === "primary" ? "Primary" : "Chained"}</td>
                                    <td style="min-width:140px;">
                                        <div class="usage-bar"><div class="usage-bar-fill${percent >= dangerAt ? " danger" : percent >= warnAt ? " warn" : ""}" style="width:${percent}%;"></div></div>
                                        <small>${percent}% (estimated) — new rules stop saving here at ${Math.round(dangerAt)}%</small>
                                    </td>
                                    <td>${p.id === "primary" ? "—" : `<button class="btn-small remove-fb-btn" data-chain-id="${escapeHtml(p.id)}" style="background:#ff4757;">Remove</button>`}</td>
                                </tr>`;
                        }).join("")}
                    </tbody>
                </table>`;

            container.querySelectorAll(".remove-fb-btn").forEach(btn => {
                btn.addEventListener("click", async () => {
                    if (!confirm(`Remove "${btn.closest("tr").querySelector("td").textContent}" from the chain? This does NOT delete any data in that project — it just stops this app from reading/writing to it.`)) return;
                    try {
                        await removeFirebaseFromChain(btn.dataset.chainId);
                        await loadRules();
                        await loadFirebaseChainSettings();
                    } catch (err) {
                        console.error("Remove chain project failed:", err);
                        alert("❌ Failed to remove project.");
                    }
                });
            });

        } catch (error) {
            console.error("Failed to load Firebase chain:", error);
            container.innerHTML = "<p>❌ Failed to load connected Firebase projects.</p>";
        }
    }

    document.getElementById("add-fb-project-btn").addEventListener("click", async () => {
        const msgEl = document.getElementById("fb-chain-message");
        const btn = document.getElementById("add-fb-project-btn");

        const config = {
            apiKey:            document.getElementById("new-fb-apiKey").value.trim(),
            authDomain:        document.getElementById("new-fb-authDomain").value.trim(),
            projectId:         document.getElementById("new-fb-projectId").value.trim(),
            storageBucket:     document.getElementById("new-fb-storageBucket").value.trim(),
            messagingSenderId: document.getElementById("new-fb-messagingSenderId").value.trim(),
            appId:             document.getElementById("new-fb-appId").value.trim()
        };
        const label = document.getElementById("new-fb-label").value.trim();
        const confirmPassword = document.getElementById("new-fb-admin-password").value;

        if (!confirmPassword) {
            msgEl.innerHTML = "❌ Please confirm your admin password — needed to set up write access on the new project.";
            msgEl.style.color = "#ff4757";
            return;
        }

        msgEl.innerHTML = "";
        btn.disabled = true;
        btn.textContent = "Testing connection...";

        try {
            await addFirebaseToChain(config, label, adminEmail, confirmPassword);
            msgEl.innerHTML = "✅ Project connected, added to the chain, and ready for writes!";
            msgEl.style.color = "#2ed573";

            ["new-fb-label", "new-fb-apiKey", "new-fb-authDomain", "new-fb-projectId",
             "new-fb-storageBucket", "new-fb-messagingSenderId", "new-fb-appId", "new-fb-admin-password"
            ].forEach(id => document.getElementById(id).value = "");

            await loadRules(); // re-reads the chain including the new project
            await loadFirebaseChainSettings();
        } catch (error) {
            console.error("Add Firebase project failed:", error);
            msgEl.innerHTML = `❌ ${error.message}`;
            msgEl.style.color = "#ff4757";
        } finally {
            btn.disabled = false;
            btn.textContent = "TEST & ADD PROJECT";
        }
    });

    // ── EXPORT CSV ─────────────────────────────────────────────
    // csvEscape: guards against two real issues with the previous
    // version — (1) a value containing a literal `"` would break the
    // CSV structure since quotes weren't escaped, and (2) CSV formula
    // injection: since fullName is student-controlled at signup, a
    // value like =HYPERLINK("http://evil.com","Click") would be written
    // verbatim and can execute as a live formula when opened in Excel/
    // Google Sheets. Prefixing a leading =,+,-,@ with a single quote is
    // the standard mitigation — spreadsheet apps then treat it as text.
    function csvEscape(value) {
        if (value === null || value === undefined) return "";
        let str = String(value);
        if (/^[=+\-@\t\r]/.test(str)) {
            str = "'" + str;
        }
        str = str.replace(/"/g, '""');
        return `"${str}"`;
    }

    document.getElementById("export-csv-btn").addEventListener("click", async () => {
        try {
            const snapshot = await getDocs(collection(db, "users"));
            let csv = "Full Name,Email,Batch,Joined Date,Allowed Languages\n";
            snapshot.forEach(d => {
                const data = d.data();
                csv += [
                    csvEscape(data.fullName),
                    csvEscape(data.email),
                    csvEscape("UPSC / WBCS / SSC - CGL"),
                    csvEscape(data.joinedDate),
                    csvEscape((data.allowedLanguages || []).join("; "))
                ].join(",") + "\n";
            });
            const blob = new Blob([csv], { type: "text/csv" });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement("a");
            a.href     = url;
            a.download = `upsc_students_${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error("CSV export failed:", error);
            alert("❌ Failed to export CSV.");
        }
    });

    // ── ADMIN LOGOUT ───────────────────────────────────────────
    document.getElementById("admin-logout-btn").addEventListener("click", async () => {
        if (unwatchSession) { unwatchSession(); unwatchSession = null; }
        await signOut(auth);
        window.location.reload(); // shows the login form again — index.html no longer has an admin face
    });

}); // end DOMContentLoaded
