/* ============================================================
   UPSC RULE KEEPER — sanitize.js
   Version: 2.1.0 (2026-08-08)
   Changelog: added validated color/background-color support for
   the rich-text color + highlight toolbar buttons (v2.1.0). Still
   the single source of truth for HTML escaping/sanitizing, used by
   dashboard.js, admin.js, voice.js, and pdf-export.js.
   ============================================================ */

const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "BR", "SPAN", "TABLE", "TBODY", "TR", "TD", "TH"]);

// Only SPAN is allowed to carry a style attribute, and only for these
// two properties — never anything else (no url(), no expression(), no
// javascript:, no @import, nothing that isn't a plain color value).
const ALLOWED_STYLE_PROPS = new Set(["color", "background-color"]);

// Strict color value allow-list: #RGB, #RRGGBB, or rgb(r,g,b) with
// plain integers only. Rejects anything containing "(" tricks like
// url(), calc(), var(), or any non-numeric/non-hex content.
const SAFE_COLOR_VALUE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/;

/**
 * Parse a style="..." string into a sanitized, minimal style string
 * containing only color/background-color with a validated value.
 * Returns "" if nothing safe survives.
 */
function sanitizeStyleAttr(styleValue) {
    if (!styleValue) return "";
    const safeDeclarations = [];
    // Split on ';' — each declaration must be "prop: value" with a
    // validated prop name and a validated value. Anything else is
    // dropped entirely (not partially trusted).
    styleValue.split(";").forEach(decl => {
        const parts = decl.split(":");
        if (parts.length !== 2) return;
        const prop  = parts[0].trim().toLowerCase();
        const value = parts[1].trim();
        if (ALLOWED_STYLE_PROPS.has(prop) && SAFE_COLOR_VALUE.test(value)) {
            safeDeclarations.push(`${prop}: ${value}`);
        }
    });
    return safeDeclarations.join("; ");
}

/**
 * Escape a plain-text value for safe insertion into innerHTML.
 * Use this for fields that should NEVER contain HTML (names, emails,
 * categories, IDs, etc).
 */
export function escapeHtml(text) {
    if (text === null || text === undefined || text === "") return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Extract plain text from an HTML string, safely.
 *
 * IMPORTANT: this uses a <template> element rather than a live <div>.
 * Setting innerHTML on a normal element can still trigger payloads
 * (e.g. <img src=x onerror="..."> fires onerror as soon as the browser
 * tries to load the broken image — this happens even if the element is
 * never attached to the visible page). <template>.content is inert per
 * the HTML spec: images don't load, scripts don't run, event handlers
 * don't fire. This is the safe way to strip tags from untrusted HTML.
 *
 * NOTE: the caller must still HTML-escape this return value (via
 * escapeHtml()) before inserting it into innerHTML anywhere — stripHtml
 * decodes entities back to literal text, so re-inserting it raw into
 * innerHTML without escaping re-opens the exact bug this function
 * exists to prevent. See admin.js's rules table for the correct usage.
 */
export function stripHtml(html) {
    if (!html) return "";
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content.textContent || "";
}

/**
 * Sanitize a rich-text HTML string down to a small allow-list of safe
 * formatting tags (bold/italic/underline/span), with attributes removed
 * from every tag EXCEPT a validated style= on <span> (color/background-
 * color only, hex/rgb values only — see sanitizeStyleAttr above).
 *
 * This walks the actual parsed DOM (inside an inert <template>, so
 * nothing executes during sanitization) and:
 *   - strips every attribute off allowed tags except a validated style
 *     on SPAN (kills onerror, onclick, href, src, arbitrary style, etc.
 *     no matter what the tag is)
 *   - unwraps disallowed tags (keeps their text, drops the tag)
 *   - removes <script>/<style> entirely, content included
 *   - drops comments
 */
export function sanitizeRichText(html) {
    if (!html) return "";
    const template = document.createElement("template");
    template.innerHTML = html;

    function clean(root) {
        const children = Array.from(root.childNodes);
        for (const child of children) {
            if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName;
                if (tag === "SCRIPT" || tag === "STYLE") {
                    root.removeChild(child);
                    continue;
                }
                if (!ALLOWED_TAGS.has(tag)) {
                    // Unwrap: keep the inner content, drop the tag itself
                    while (child.firstChild) root.insertBefore(child.firstChild, child);
                    root.removeChild(child);
                    continue;
                }

                if (tag === "SPAN") {
                    // SPAN is only useful here for color/background-color
                    // (that's what execCommand('foreColor'/'hiliteColor')
                    // produces). Keep ONLY a sanitized style attribute;
                    // strip everything else. If nothing safe survives,
                    // unwrap the span entirely — an empty span with no
                    // purpose just adds noise.
                    const safeStyle = sanitizeStyleAttr(child.getAttribute("style"));
                    while (child.attributes.length > 0) {
                        child.removeAttribute(child.attributes[0].name);
                    }
                    if (safeStyle) {
                        child.setAttribute("style", safeStyle);
                        clean(child);
                    } else {
                        while (child.firstChild) root.insertBefore(child.firstChild, child);
                        root.removeChild(child);
                    }
                    continue;
                }

                // B/STRONG/I/EM/U/BR — strip every attribute (onerror, style, etc.)
                while (child.attributes.length > 0) {
                    child.removeAttribute(child.attributes[0].name);
                }
                clean(child);
            } else if (child.nodeType === Node.COMMENT_NODE) {
                root.removeChild(child);
            }
            // text nodes are left as-is
        }
    }

    clean(template.content);
    return template.innerHTML;
}
