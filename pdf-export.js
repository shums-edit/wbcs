import { escapeHtml, sanitizeRichText } from "./sanitize.js";

// Generate and print a PDF from rules list
export function generatePDF(rules, title = "UPSC Rules") {
    if (!rules || rules.length === 0) {
        alert("No rules to export.");
        return;
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        alert("Popup blocked! Please allow popups for this site to export PDF.");
        return;
    }

    // Built with DOM APIs instead of document.write(). document.write()
    // is an old, inconsistently-supported API — it can throw unpredictable
    // errors across different browsers/extensions, and offers no real
    // benefit here over building the document directly.
    printWindow.document.title = title;

    const meta = printWindow.document.createElement("meta");
    meta.setAttribute("charset", "UTF-8");
    printWindow.document.head.appendChild(meta);

    const style = printWindow.document.createElement("style");
    style.textContent = `
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 40px;
            padding: 20px;
            color: #333;
        }
        h1 {
            color: #333;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }
        .meta {
            color: #666;
            font-size: 13px;
            margin-bottom: 20px;
        }
        .rule-card {
            margin-bottom: 30px;
            padding: 15px;
            border: 1px solid #ddd;
            border-radius: 8px;
            page-break-inside: avoid;
        }
        .rule-title {
            font-size: 18px;
            font-weight: bold;
            color: #667eea;
        }
        .rule-id {
            font-size: 12px;
            color: #999;
            margin-left: 10px;
        }
        .rule-section {
            margin-top: 10px;
            line-height: 1.6;
            white-space: pre-wrap;
        }
        .rule-section table {
            border-collapse: collapse;
            width: 100%;
            margin: 8px 0;
        }
        .rule-section td, .rule-section th {
            border: 1px solid #ccc;
            padding: 6px 10px;
            text-align: left;
        }
        .footer {
            margin-top: 30px;
            text-align: center;
            font-size: 12px;
            color: #999;
            border-top: 1px solid #eee;
            padding-top: 10px;
        }
        @media print {
            body { margin: 0; padding: 20px; }
            .rule-card { break-inside: avoid; }
        }
    `;
    printWindow.document.head.appendChild(style);

    // Fields below split into two groups, on purpose:
    //   - title / ruleId / category / "Generated on" — plain text only,
    //     always fully escaped with escapeHtml().
    //   - ruleName / definition / keyPoints / examples — rich text from
    //     the admin editor (may legitimately contain <b>/<i>/<u>), so
    //     sanitizeRichText() is used instead: it keeps real formatting
    //     but strips anything unsafe. Using escapeHtml() on these (as the
    //     previous version did) turned intentional bold/italic/underline
    //     into literal "&lt;b&gt;" text in the exported PDF — this fixes
    //     that display bug too, not just the security side.
    let bodyHtml = `
        <h1>📚 ${escapeHtml(title)}</h1>
        <div class="meta">
            <p>Generated on: ${escapeHtml(new Date().toLocaleDateString())}</p>
            <p>Total Rules: ${rules.length}</p>
        </div>
    `;

    rules.forEach(rule => {
        bodyHtml += `
            <div class="rule-card">
                <div>
                    <span class="rule-title">${sanitizeRichText(rule.ruleName)}</span>
                    <span class="rule-id">(${escapeHtml(rule.ruleId || "N/A")})</span>
                </div>
                ${rule.category ? `<div class="rule-section"><strong>Category:</strong> ${escapeHtml(rule.category)}</div>` : ''}
                ${rule.definition ? `<div class="rule-section"><strong>Definition:</strong><br>${sanitizeRichText(rule.definition)}</div>` : ''}
                ${rule.keyPoints ? `<div class="rule-section"><strong>Key Points:</strong><br>${sanitizeRichText(rule.keyPoints).replace(/\n/g, '<br>')}</div>` : ''}
                ${rule.examples ? `<div class="rule-section"><strong>Examples:</strong><br>${sanitizeRichText(rule.examples).replace(/\n/g, '<br>')}</div>` : ''}
            </div>
        `;
    });

    bodyHtml += `<div class="footer">UPSC Rule Keeper - Study Material</div>`;

    printWindow.document.body.insertAdjacentHTML("beforeend", bodyHtml);

    // Not relying on printWindow.onload here — for a window built directly
    // via DOM APIs (no real navigation/load event), onload may never fire.
    // A short delay lets layout settle before print() is called.
    setTimeout(() => printWindow.print(), 300);
}

// Export filtered rules based on search/category
export function exportToPDF(rules, filterType, filterValue) {
    let title = "UPSC Rules";
    if (filterType === "category" && filterValue !== "all") {
        title = `${filterValue} Rules - UPSC`;
    } else if (filterType === "search" && filterValue) {
        title = `Search Results: ${filterValue}`;
    }
    generatePDF(rules, title);
}
