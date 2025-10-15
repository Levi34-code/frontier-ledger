// js/app.js — demo-stable parsing: vendor name only + robust invoice # + dates
(() => {
  "use strict";

  const AUTO_SAVE_AFTER_PARSE = false;

  // pdf.js (force CDN ESM)
  const CDN_PDFJS_URL =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.min.mjs";
  const CDN_WORKER_URL =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.worker.min.mjs";

  // OCR fallback
  const TESSERACT_URL =
    "https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js";

  // ---------- utils ----------
  const $ = (s) => document.querySelector(s);
  const log = (...a) => console.log("[FL AP]", ...a);
  const warn = (...a) => console.warn("[FL AP]", ...a);
  const err = (...a) => console.error("[FL AP]", ...a);

  const normalize = (s) =>
    String(s || "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/inv\s*oice/gi, "invoice") // fix OCR splits like "Inv oice"
      .trim();

  const moneyNum = (s) => Number(String(s || "").replace(/[^0-9.]/g, "")) || 0;

  const escapeHtml = (s) =>
    String(s || "").replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[m])
    );

  function toInputDate(s) {
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    // Accept: mm/dd/yyyy, m/d/yy, yyyy-mm-dd, "Jan 2, 2025"
    try {
      const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (m1) {
        const [, mm, dd, yy] = m1;
        const yr = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
        const d = new Date(yr, Number(mm) - 1, Number(dd));
        if (!isNaN(d)) return fmtYMD(d);
      }
      const d2 = new Date(s);
      if (!isNaN(d2)) return fmtYMD(d2);
    } catch {}
    return "";
  }
  function fmtYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // ---------- pdf.js loader (force CDN) ----------
  let PDFJS = null;
  async function importEsm(url) {
    const abs = new URL(url, location.href).href;
    return await import(abs);
  }
  async function ensurePdfJs() {
    if (PDFJS) return true;
    try {
      log("Importing pdf.js (CDN):", CDN_PDFJS_URL);
      PDFJS = await importEsm(CDN_PDFJS_URL);
      if (!PDFJS?.getDocument) throw new Error("CDN pdf.js missing exports");
      PDFJS.GlobalWorkerOptions.workerSrc = CDN_WORKER_URL;
      log("pdf.js ready (CDN).");
      return true;
    } catch (e) {
      err("Failed to import pdf.js from CDN.", e);
      alert("pdf.js failed to load from CDN.");
      return false;
    }
  }

  async function ensureTesseract() {
    if (window.Tesseract) return true;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT_URL;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load Tesseract"));
      document.head.appendChild(s);
    });
    return true;
  }

  // ---------- PDF → text with OCR fallback ----------
  async function extractPdfText(file) {
    const ok = await ensurePdfJs();
    if (!ok) throw new Error("pdf.js unavailable");

    const buf = await file.arrayBuffer();
    const pdf = await PDFJS.getDocument({ data: buf }).promise;

    // Embedded text first
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += "\n" + content.items.map((it) => it.str).join(" ");
    }
    text = normalize(text);

    // OCR fallback if no text
    if (text.length < 30) {
      await ensureTesseract();
      const status = $("#file-chosen");
      let ocrText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        status && (status.textContent = `OCR page ${i}/${pdf.numPages}…`);
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = vp.width;
        canvas.height = vp.height;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const res = await window.Tesseract.recognize(canvas, "eng");
        ocrText += "\n" + (res?.data?.text || "");
      }
      text = normalize(ocrText);
    }

    return text;
  }

  // ---------- Parsing helpers tailored for your demo ----------
  function looksLikeAddress(line) {
    return (
      /\d{1,6}\s+\w+/.test(line) || // street number + word
      /\b(st|ave|rd|blvd|dr|ln|ct|ter|pkwy|wy|hwy|pl|cir|way|suite|ste|unit|apt|bldg|floor|fl|po box|p\.?o\.?\s?box)\b/i.test(
        line
      ) ||
      /\b[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/.test(line) || // state + ZIP
      /\b(phone|tel|fax|email|www\.|website|vat|tax\s*id|ein)\b/i.test(line)
    );
  }

  function trimAfterAddressOrContact(s) {
    // cut at first digit (typical start of address) or contact keyword
    let out = s.replace(
      /(\s+(?:\d{1,6}\s+\w+|phone|tel|fax|email|www\.|website|vat|tax\s*id|ein).*)$/i,
      ""
    );
    // also cut trailing ", WY 82001" style tails if present
    out = out.replace(/,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?$/i, "");
    return out.trim();
  }

  // Vendor: look before the word "Invoice", take strongest "name-only" line.
  function deriveVendor(text) {
    const i = text.search(/invoice\b/i);
    const before =
      i > 0 ? text.slice(Math.max(0, i - 600), i) : text.slice(0, 300);

    // Split by real lines first, also split long lines by 2+ spaces
    const lines = before
      .split(/\r?\n/)
      .flatMap((ln) => ln.split(/ {2,}/))
      .map((l) => l.trim())
      .filter(Boolean);

    // Prefer a line without digits and not address-like.
    let candidate =
      lines.find((l) => !/\d/.test(l) && !looksLikeAddress(l)) ||
      (lines[0] ? trimAfterAddressOrContact(lines[0]) : "") ||
      "";

    // If candidate still contains address tokens, strip after first such token
    candidate = trimAfterAddressOrContact(candidate);

    // If empty, use the longest non-address chunk
    if (!candidate) {
      const nonAddr = lines
        .filter((l) => !looksLikeAddress(l))
        .sort((a, b) => b.length - a.length)[0];
      candidate = (nonAddr && trimAfterAddressOrContact(nonAddr)) || "";
    }

    return candidate;
  }

  // Invoice #: find “invoice/ invoice # / invoice no.” and capture next token WITH A DIGIT.
  function deriveInvoiceNumber(text) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf("invoice");
    if (idx === -1) return "";

    const after = text.slice(idx, idx + 300); // small window

    // Nice formats: "Invoice # 123", "Invoice No. INV-1003", "Invoice: 1003"
    let m =
      after.match(
        /invoice\s*(?:no\.|number|#|:)?\s*([A-Z0-9][A-Z0-9\-\/\.]+)/i
      ) || null;
    if (m && m[1] && /\d/.test(m[1]) && !/^invoice$/i.test(m[1])) return m[1];

    // If breaks on next line, scan next 2 lines for first token with a digit
    const lines = after
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 1) {
      for (let ln = 1; ln < Math.min(lines.length, 3); ln++) {
        const token = (lines[ln].match(/[A-Z0-9#][A-Z0-9\-\/\.]*/i) || [])[0];
        if (token && /\d/.test(token) && !/^invoice$/i.test(token)) {
          return token.replace(/^#/, "");
        }
      }
    }

    // Fallbacks near “invoice”
    m = after.match(/#[ \t]*([A-Z0-9][A-Z0-9\-\/\.]+)/);
    if (m && /\d/.test(m[1])) return m[1];

    m = after.match(/\bINV[\- ]?([A-Z0-9][A-Z0-9\-\/\.]+)\b/i);
    if (m && /\d/.test(m[1])) return m[1];

    // Last resort: first 15 tokens after “invoice” that contain a digit
    const afterTokens = after.split(/[\s,]+/).slice(0, 15);
    const tok = afterTokens.find(
      (t) => /\d/.test(t) && /^[A-Z0-9#][A-Z0-9\-\/\.]*$/i.test(t)
    );
    if (tok) return tok.replace(/^#/, "");
    return "";
  }

  // Dates: look for label then capture a nearby date on same or next line
  function deriveLabeledDate(text, labels) {
    const labelRe = new RegExp(`(${labels.join("|")})\\b`, "i");
    const dateToken =
      /(\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s*\d{4}\b|\b\d{4}-\d{2}-\d{2}\b)/i;

    const m = text.match(labelRe);
    if (!m) return "";

    const start = Math.max(0, m.index);
    const window = text.slice(start, start + 220); // small window after label

    // same line
    let d = window.match(dateToken);
    if (d && d[1]) return d[1];

    // next 2 lines
    const lines = window
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = 1; i < Math.min(lines.length, 3); i++) {
      const dd = lines[i].match(dateToken);
      if (dd && dd[1]) return dd[1];
    }
    return "";
  }

  function deriveInvoiceDate(text) {
    return (
      deriveLabeledDate(text, [
        "invoice\\s*date",
        "date\\s*of\\s*invoice",
        "issued\\s*date",
        "\\bdate\\b",
      ]) || ""
    );
  }

  function deriveDueDate(text) {
    return (
      deriveLabeledDate(text, [
        "due\\s*date",
        "payment\\s*due",
        "due\\s*on",
        "pay\\s*by",
      ]) || ""
    );
  }

  function bestAmount(text) {
    const lbls = [
      /(amount\s*due)[:\s]*([$]?\s?\d[\d,]*\.\d{2})/i,
      /(total\s*due)[:\s]*([$]?\s?\d[\d,]*\.\d{2})/i,
      /(invoice\s*total)[:\s]*([$]?\s?\d[\d,]*\.\d{2})/i,
      /(?:\btotal\b)[:\s]*([$]?\s?\d[\d,]*\.\d{2})/i,
    ];
    for (const re of lbls) {
      const m = text.match(re);
      if (m) return m[2] || m[1];
    }
    const all = [...text.matchAll(/\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})/g)].map(
      (m) => m[0]
    );
    const toNum = (s) => Number(String(s).replace(/[^0-9.]/g, "")) || 0;
    return all.sort((a, b) => toNum(b) - toNum(a))[0] || "";
  }

  function deriveLineItems(text) {
    const chunks = text.split(/\s{2,}|(?<=\d)\s(?=\d)/g);
    const items = [];
    for (const ln of chunks) {
      const qty =
        ln.match(/\bqty[:\s]*(\d{1,3})\b/i)?.[1] ||
        ln.match(/\b(\d{1,3})\s*(x|×)\b/i)?.[1];
      const price = (ln.match(/\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})/) || [])[0];
      if (qty && price && /\D{4,}/.test(ln)) {
        items.push({
          description: ln
            .replace(
              /qty[:\s]*\d{1,3}|(\d{1,3}\s*(x|×))|\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})/gi,
              ""
            )
            .trim(),
          quantity: Number(qty),
          unit_price: price,
        });
      }
      if (items.length >= 5) break;
    }
    return items;
  }

  // ---------- Parse + Fill ----------
  function parseInvoice(text) {
    const vendor = deriveVendor(text);
    const invoice_number = deriveInvoiceNumber(text);
    const invoice_date_raw = deriveInvoiceDate(text);
    const due_date_raw = deriveDueDate(text);
    const invoice_date = toInputDate(invoice_date_raw);
    const due_date = toInputDate(due_date_raw);
    const amount_due = bestAmount(text);
    const items = deriveLineItems(text);

    return {
      vendor,
      invoice_number,
      invoice_date,
      due_date,
      amount_due,
      items,
    };
  }

  function fillForm(parsed, filename) {
    const vendor = $("#vendor");
    const invno = $("#invno");
    const invdate = $("#invdate");
    const duedate = $("#duedate");
    const amount = $("#amount");

    if (vendor) vendor.value = parsed.vendor || "";
    if (invno) invno.value = parsed.invoice_number || "";
    if (invdate) invdate.value = parsed.invoice_date || "";
    if (duedate) duedate.value = parsed.due_date || "";
    if (amount) amount.value = moneyNum(parsed.amount_due).toFixed(2) || "";

    const body = $("#lines-body");
    if (body && parsed.items && parsed.items.length) {
      body.innerHTML = "";
      parsed.items.slice(0, 3).forEach((it) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><input type="text" class="form-input-sm" value="${escapeHtml(
          it.description
        )}" /></td>
           <td><input type="text" class="form-input-sm" placeholder="e.g., 5100 - IT Services" /></td>
           <td><input type="text" class="form-input-sm" placeholder="e.g., ADMIN" /></td>
           <td><input type="number" step="1" min="1" value="${
             Number(it.quantity) || 1
           }" class="form-input-sm" /></td>
           <td><input type="number" step="0.01" min="0" value="${moneyNum(
             it.unit_price
           ).toFixed(2)}" class="form-input-sm" /></td>
           <td class="mono">$${(
             Number(it.quantity || 1) * moneyNum(it.unit_price)
           ).toFixed(2)}</td>
           <td><button type="button" class="btn-link-danger remove-line">Remove</button></td>`;
        body.appendChild(tr);
      });
    }

    const chosen = $("#file-chosen");
    if (chosen && filename) chosen.textContent = `Parsed ✓ ${filename}`;
  }

  // ---------- Main flow ----------
  async function handleFile(file) {
    if (!file) return;
    if (typeof window.showScreen === "function")
      window.showScreen("invoice-new");

    const chosen = $("#file-chosen");
    chosen && (chosen.textContent = `Reading ${file.name} …`);
    log("Selected:", file.name, file.type);

    if (file.type !== "application/pdf") {
      chosen &&
        (chosen.textContent = `Selected (no parse): ${file.name} — please upload a PDF for now.`);
      warn("Non-PDF selected; parsing skipped.");
      return;
    }

    try {
      const text = await extractPdfText(file);
      const parsed = parseInvoice(text);
      log("Parsed:", parsed);
      fillForm(parsed, file.name);

      if (AUTO_SAVE_AFTER_PARSE) {
        const form = $("#invoice-form");
        if (form)
          form.dispatchEvent(
            new Event("submit", { cancelable: true, bubbles: true })
          );
      }
    } catch (e) {
      err("Parse error:", e);
      chosen && (chosen.textContent = `Could not parse ${file.name}.`);
      alert("We couldn't parse that PDF.");
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const fi = $("#invoice-file");
    const btn = $("#choose-file");
    const uz = $("#upload-zone");

    if (btn && fi) btn.addEventListener("click", () => fi.click());
    if (fi)
      fi.addEventListener("change", () => {
        const f = fi.files?.[0];
        if (f) handleFile(f);
      });

    if (uz) {
      ["dragenter", "dragover"].forEach((evt) =>
        uz.addEventListener(evt, (e) => {
          e.preventDefault();
          uz.style.borderColor = "var(--frontier-brown)";
        })
      );
      ["dragleave", "drop"].forEach((evt) =>
        uz.addEventListener(evt, (e) => {
          e.preventDefault();
          uz.style.borderColor = "var(--gray-300)";
        })
      );
      uz.addEventListener("drop", (e) => {
        const f = e.dataTransfer?.files?.[0];
        if (f) handleFile(f);
      });
    }

    log("Booted.");
  });
})();
