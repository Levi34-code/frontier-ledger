// js/app.js — pdf.js (force CDN ESM) + OCR + auto-fill
(() => {
  "use strict";

  const AUTO_SAVE_AFTER_PARSE = false;

  // ✅ Force CDN (matching ESM + worker)
  const CDN_PDFJS_URL =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.min.mjs";
  const CDN_WORKER_URL =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.worker.min.mjs";

  // OCR (only used if PDF has no embedded text)
  const TESSERACT_URL =
    "https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js";

  // ---------- utils ----------
  const $ = (sel) => document.querySelector(sel);
  const normalize = (s) =>
    String(s || "")
      .replace(/\u00A0/g, " ")
      .replace(/\s+/g, " ")
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
  const log = (...a) => console.log("[FL AP]", ...a);
  const warn = (...a) => console.warn("[FL AP]", ...a);
  const err = (...a) => console.error("[FL AP]", ...a);

  function toInputDate(s) {
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    try {
      const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      let d;
      if (m) {
        const [, mm, dd, yy] = m;
        const yr = yy.length === 2 ? Number(yy) + 2000 : Number(yy);
        d = new Date(yr, Number(mm) - 1, Number(dd));
      } else {
        d = new Date(s);
      }
      if (isNaN(d.getTime())) return "";
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(d.getDate()).padStart(2, "0")}`;
    } catch {
      return "";
    }
  }

  // ---------- pdf.js loader (force CDN ESM) ----------
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

      // ✅ Absolute worker URL (same CDN, matching version)
      PDFJS.GlobalWorkerOptions.workerSrc = CDN_WORKER_URL;
      log("pdf.js ready (CDN). Worker:", PDFJS.GlobalWorkerOptions.workerSrc);
      return true;
    } catch (e) {
      err("Failed to import pdf.js from CDN.", e);
      alert("pdf.js failed to load from CDN. Please check your network.");
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

    // Try embedded text first
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += " " + content.items.map((it) => it.str).join(" ");
    }
    text = normalize(text);
    log("Embedded text length:", text.length);

    // OCR fallback if needed
    if (text.length < 30) {
      await ensureTesseract();
      const status = $("#file-chosen");
      let ocrText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        status && (status.textContent = `OCR page ${i}/${pdf.numPages}…`);
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;

        const res = await window.Tesseract.recognize(canvas, "eng");
        ocrText += "\n" + (res?.data?.text || "");
      }
      text = normalize(ocrText);
      log("OCR text length:", text.length);
    }

    return text;
  }

  // ---------- Heuristic invoice parser ----------
  function parseInvoice(text) {
    const find = (re, flags = "i") => {
      const m = text.match(new RegExp(re, flags));
      return m ? m.groups?.v ?? m[1] ?? "" : "";
    };
    const dateRe =
      "(?<v>(?:\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4})|(?:\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},\\s*\\d{4}\\b))";

    const vendor = deriveVendor(text);
    const invoice_number = find(
      "(?:invoice\\s*(?:no\\.|#|number)?\\s*[:\\-]?\\s*)(?<v>[A-Z0-9\\-\\/\\.]{3,})"
    );
    const invoice_date = find(
      "(?:invoice\\s*date\\s*[:\\-]?\\s*|date\\s*[:\\-]?\\s*)" + dateRe
    );
    const due_date = find("(?:due\\s*date\\s*[:\\-]?\\s*)" + dateRe);
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

  function deriveVendor(text) {
    const idx = text.search(/invoice\s*(no\.|#|number|date)?/i);
    if (idx > 0) {
      const before = text.slice(Math.max(0, idx - 140), idx);
      const words = before
        .replace(/[^A-Za-z0-9&.,\- ]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      return words
        .slice(-6)
        .join(" ")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    return "";
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

  // ---------- Fill your existing form ----------
  function fillForm(parsed, filename) {
    const vendor = $("#vendor");
    const invno = $("#invno");
    const invdate = $("#invdate");
    const duedate = $("#duedate");
    const amount = $("#amount");

    if (vendor) vendor.value = parsed.vendor || "";
    if (invno) invno.value = parsed.invoice_number || "";
    if (invdate) invdate.value = toInputDate(parsed.invoice_date) || "";
    if (duedate) duedate.value = toInputDate(parsed.due_date) || "";
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
      if (!text || text.length < 5)
        throw new Error("No text detected after OCR");
      chosen && (chosen.textContent = "Parsing…");
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
      alert(
        "We couldn't parse that PDF. If this keeps happening, test with a text-based PDF (not a scan)."
      );
    }
  }

  // ---------- Wire up your HTML ----------
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
