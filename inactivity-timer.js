/* ============================================================
   UPSC RULE KEEPER — inactivity-timer.js
   Version: 2.8.0 (2026-08-10)
   Shared auto-logout-on-inactivity logic — used by BOTH admin.js and
   dashboard.js so the timeout duration only ever needs to change in
   ONE place.

   Changelog:
     - Added a "session expiring" warning popup at the 1-minute-
       remaining mark, with Continue/Cancel. Continue resets the full
       timer (same as any activity would). Cancel just dismisses the
       popup — it deliberately does NOT reset anything, so the
       original countdown keeps going and auto-logout still happens
       exactly on schedule.
     - Built dynamically via JS rather than static HTML, so this one
       shared module works on both dashboard.html and admin.html
       without needing the modal markup duplicated in either page.
     - (v2.2.0) shared 3-minute timer, used by both panels.
   ============================================================ */

import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

export const AUTO_LOGOUT_SECONDS = 180; // 3 minutes — shared by admin + student panels
const WARNING_AT_SECONDS_REMAINING = 60; // show the popup with 1 minute left

let modalEl = null;

function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement("div");
    modalEl.className = "session-warning-overlay";
    modalEl.innerHTML = `
        <div class="session-warning-box">
            <h3>⏱️ Session Expiring</h3>
            <p>You've been inactive — this session will expire in about 1 minute.</p>
            <div class="session-warning-actions">
                <button type="button" class="btn-primary session-warning-continue">Continue Session</button>
                <button type="button" class="btn-secondary session-warning-cancel">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(modalEl);
    return modalEl;
}

/**
 * Starts an inactivity timer that signs the user out after
 * AUTO_LOGOUT_SECONDS of no click/keydown/mousemove/touch/scroll —
 * showing a Continue/Cancel warning popup 1 minute before it fires.
 *
 * @param {object} opts
 * @param {object} opts.auth - the Firebase Auth instance to sign out of
 * @param {string} [opts.timerElementId] - id of an element to show the
 *   "⏱️ Auto logout in Ns" countdown in during the last 30 seconds.
 * @param {string} [opts.redirectTo] - where to send the user after
 *   logout. Defaults to "index.html".
 * @returns {{ reset: Function, stop: Function }}
 */
export function startAutoLogoutTimer({ auth, timerElementId, redirectTo = "index.html" }) {
    let logoutTimeout = null;
    let countdownInterval = null;
    let warningShown = false;

    function hideWarning() {
        if (modalEl) modalEl.style.display = "none";
        warningShown = false;
    }

    function showWarning() {
        if (warningShown) return;
        warningShown = true;
        const modal = ensureModal();
        modal.style.display = "flex";

        // Fresh handlers each time this shows, so repeated warnings
        // (e.g. across multiple sessions on the same page) don't stack
        // duplicate listeners on the same buttons.
        //
        // e.stopPropagation() here matters: without it, this click
        // bubbles up to the page-wide "any click = activity, reset the
        // timer" listener below. That listener checks `warningShown`
        // to decide whether to reset — but by the time the bubbled
        // click reaches it, hideWarning() has already run and set
        // warningShown back to false, so it looked like an ordinary
        // click and reset the timer anyway. That silently undid
        // Cancel every time — this is the actual bug fix.
        modal.querySelector(".session-warning-continue").onclick = (e) => {
            e.stopPropagation();
            hideWarning();
            reset();
        };
        modal.querySelector(".session-warning-cancel").onclick = (e) => {
            e.stopPropagation();
            // Deliberately does NOT reset — the original timer keeps
            // counting down and auto-logout still happens on schedule.
            hideWarning();
        };
    }

    function reset() {
        clearTimeout(logoutTimeout);
        clearInterval(countdownInterval);
        hideWarning();

        let secondsLeft = AUTO_LOGOUT_SECONDS;
        const timerEl = timerElementId ? document.getElementById(timerElementId) : null;

        countdownInterval = setInterval(() => {
            secondsLeft--;

            if (secondsLeft === WARNING_AT_SECONDS_REMAINING) {
                showWarning();
            }

            if (secondsLeft <= 30 && timerEl) {
                timerEl.textContent = `⏱️ Auto logout in ${secondsLeft}s`;
            } else if (timerEl) {
                timerEl.textContent = "";
            }
        }, 1000);

        logoutTimeout = setTimeout(async () => {
            clearInterval(countdownInterval);
            hideWarning();
            alert("⏰ Session expired due to inactivity. Please login again.");
            await signOut(auth);
            window.location.replace(redirectTo);
        }, AUTO_LOGOUT_SECONDS * 1000);
    }

    function stop() {
        clearTimeout(logoutTimeout);
        clearInterval(countdownInterval);
        hideWarning();
    }

    reset();
    ["click", "keydown", "mousemove", "touchstart", "scroll"].forEach(evt => {
        document.addEventListener(evt, () => {
            // While the warning popup is up, ordinary page activity
            // (mouse movement, a click elsewhere) must NOT silently
            // reset the timer — only an explicit "Continue Session"
            // click should. Otherwise Cancel would be meaningless: any
            // stray mouse movement right after clicking it would reset
            // the timer anyway.
            if (!warningShown) reset();
        }, { passive: true });
    });

    return { reset, stop };
}
