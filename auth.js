import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    doc, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import { auth, db, DEFAULT_BATCH_TIMING } from "./firebase-config.js";

function generateAvatar(fullName) {
    const nameParts = fullName.trim().split(/\s+/);
    if (nameParts.length >= 2) {
        return (nameParts[0][0] + nameParts[1][0]).toUpperCase();
    }
    return fullName.substring(0, 2).toUpperCase();
}

function getCurrentDate() {
    return new Date().toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric'
    });
}

function validatePassword(password) {
    const hasLength  = password.length >= 8;
    const hasUpper   = /[A-Z]/.test(password);
    const hasLower   = /[a-z]/.test(password);
    const hasNumber  = /[0-9]/.test(password);
    const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
    return hasLength && hasUpper && hasLower && hasNumber && hasSpecial;
}

document.addEventListener("DOMContentLoaded", () => {
    const studentLoginBtn  = document.getElementById("student-login-btn");
    const studentSignupBtn = document.getElementById("student-signup-btn");
    const signupNameGroup  = document.getElementById("signup-name-group");
    const confirmGroup     = document.getElementById("confirm-password-group");
    const strengthBlock    = document.getElementById("student-strength-block");
    const messageDiv       = document.getElementById("message");

    // ── FLIP CARD: reset student form to login mode whenever the
    // "User Login" button flips back to the student face, matching the
    // old behavior when switching tabs. Exposed globally since the flip
    // trigger lives in a separate inline <script> in index.html.
    function resetToLoginMode() {
        isLoginMode = true;
        signupNameGroup.style.display = "none";
        if (confirmGroup) confirmGroup.style.display = "none";
        if (strengthBlock) strengthBlock.style.display = "none";
        document.getElementById("student-password").value = "";
        if (document.getElementById("student-confirm-password")) {
            document.getElementById("student-confirm-password").value = "";
        }
        studentLoginBtn.textContent = "LOGIN";
        studentSignupBtn.textContent = "CREATE ACCOUNT";
    }
    window.resetStudentLoginMode = resetToLoginMode;

    // ── TOGGLE SIGNUP/LOGIN MODE ───────────────────────────────
    let isLoginMode = true;

    studentSignupBtn.addEventListener("click", () => {
        if (isLoginMode) {
            isLoginMode = false;
            signupNameGroup.style.display = "block";
            studentLoginBtn.textContent = "SIGNUP";
            studentSignupBtn.textContent = "BACK TO LOGIN";
        } else {
            resetToLoginMode();
        }
        messageDiv.innerHTML = "";
    });

    studentLoginBtn.addEventListener("click", async () => {
        if (!isLoginMode) {
            await handleStudentSignup();
        } else {
            await handleStudentLogin();
        }
    });

    // ── STUDENT SIGNUP ─────────────────────────────────────────
    async function handleStudentSignup() {
        const name     = document.getElementById("signup-name").value.trim();
        const email    = document.getElementById("student-email").value.trim();
        const password = document.getElementById("student-password").value;
        const confirm  = document.getElementById("student-confirm-password")?.value;

        if (!name || !email || !password) {
            messageDiv.innerHTML = "❌ Please fill all fields.";
            messageDiv.style.color = "red";
            return;
        }

        // Password strength validation
        if (!validatePassword(password)) {
            messageDiv.innerHTML = "❌ Password must be at least 8 characters with uppercase, lowercase, number and special character.";
            messageDiv.style.color = "red";
            return;
        }

        // Confirm password check
        if (confirm !== password) {
            messageDiv.innerHTML = "❌ Confirm password does not match.";
            messageDiv.style.color = "red";
            return;
        }

        studentLoginBtn.disabled = true;
        studentLoginBtn.textContent = "Creating...";

        try {
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // Save to pendingUsers — admin must approve before login
            await setDoc(doc(db, "pendingUsers", user.uid), {
                fullName: name,
                email: email,
                avatar: generateAvatar(name),
                batchTiming: DEFAULT_BATCH_TIMING,
                joinedDate: getCurrentDate(),
                allowedLanguages: [],
                bookmarks: [],
                recentSearches: [],
                requestedAt: new Date().toISOString()
            });

            await auth.signOut();

            messageDiv.innerHTML = "✅ Account request submitted! Wait for admin approval before logging in.";
            messageDiv.style.color = "green";

            // Reset form
            document.getElementById("signup-name").value = "";
            document.getElementById("student-email").value = "";
            document.getElementById("student-password").value = "";
            if (document.getElementById("student-confirm-password")) {
                document.getElementById("student-confirm-password").value = "";
            }
            resetToLoginMode();

        } catch (error) {
            if (error.code === "auth/email-already-in-use") {
                messageDiv.innerHTML = "❌ This email is already registered. Please login or use a different email.";
            } else if (error.code === "auth/invalid-email") {
                messageDiv.innerHTML = "❌ Invalid email address.";
            } else {
                messageDiv.innerHTML = `❌ ${error.message}`;
            }
            messageDiv.style.color = "red";
        } finally {
            studentLoginBtn.disabled = false;
            studentLoginBtn.textContent = "SIGNUP";
        }
    }

    // ── STUDENT LOGIN ──────────────────────────────────────────
    async function handleStudentLogin() {
        const email    = document.getElementById("student-email").value.trim();
        const password = document.getElementById("student-password").value;

        if (!email || !password) {
            messageDiv.innerHTML = "❌ Please enter email and password.";
            return;
        }

        studentLoginBtn.disabled = true;
        studentLoginBtn.textContent = "Logging in...";

        try {
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists()) {
                // Correct password AND account exists — but check the
                // admin hasn't disabled this account before letting
                // them in.
                const disabledDoc = await getDoc(doc(db, "disabledUsers", user.uid));
                if (disabledDoc.exists()) {
                    await auth.signOut();
                    messageDiv.innerHTML = "🚫 Your account has been disabled. Please contact your admin.";
                    messageDiv.style.color = "red";
                    return;
                }
                // SECURITY: use replace so back button won't return to login
                window.location.replace("dashboard.html");
            } else {
                const pendingRef = doc(db, "pendingUsers", user.uid);
                const pendingDoc = await getDoc(pendingRef);
                await auth.signOut();

                if (pendingDoc.exists()) {
                    messageDiv.innerHTML = "⏳ Your account is pending admin approval. Please wait.";
                    messageDiv.style.color = "orange";
                } else {
                    messageDiv.innerHTML = "❌ Account not found or has been rejected. Please contact admin.";
                    messageDiv.style.color = "red";
                }
            }
        } catch (error) {
            messageDiv.innerHTML = "❌ Invalid email or password.";
            messageDiv.style.color = "red";
        } finally {
            studentLoginBtn.disabled = false;
            studentLoginBtn.textContent = "LOGIN";
        }
    }
});
