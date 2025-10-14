// js/app.js
(() => {
  "use strict";

  // ===== Config =====
  const LS_KEY = "fl.ap.invoices.v1";
  const PDFJS_URL = "https://unpkg.com/pdfjs-dist@4.7.76/build/pdf.min.js";
  const PDFJS_WORKER = "https://unpkg.com/pdfjs-dist@4.7.76/build/pdf.worker.min.js";

  // ===== Utilities =====
  const $ = (sel) => document.querySelector(sel);
  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  const normalize = (s) => String(s || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) return resolve();
      const el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = reject;
      document.head.appendChild(el);
    });
  }

  // ===== Local "store" (browser memory) =====
  const store = {
    all() {
      try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
      catch { return []; }
    },
    save(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); },
    add(inv) { const list = store.all(); list.unshift(inv); store.save(list); render(); },
    clear() { localStorage.removeItem(LS_KEY); render(); }
  };

  // ===== PDF text extraction =====
  async function ensurePdfJs() {
    if (!window.pdfjsLib) {
      await loadScriptOnce(PDFJS_URL);
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }

  async function extractPdfText(arrayBuffer) {
    await ensurePdfJs();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += " " + content.items.map(it => it.str).join(" ");
    }
    return normalize(text);
  }

  // ===== Heuristic invoice parser =====
  function parseInvoice(text) {
    const find = (re, flags = "i") => {
      const m = text.match(new RegExp(re, flags));
      return m ? (m.groups?.v ?? m[1] ?? "") : "";
    };

    const dateRe = "(?<v>(?:\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4})|(?:\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},\\s*\\d{4}\\b))";
    const invoiceNo = find("(?:invoice\\s*(?:no\\.|#|number)?\\s*[:\\-]?\\s*)(?<v>[A-Z0-9\\-\\/\\.]{3,})");
    const poNumber  = find("(?:po\\s*(?:#|number)?\\s*[:\\-]?\\s*)(?<v>[A-Z0-9\\-\\/\\.]{3,})");
    const invDate   = find("(?:invoice\\s*date\\s*[:\\-]?\\s*|date\\s*[:\\-]?\\s*)" + dateRe);
    const dueDate   = find("(?:due\\s*date\\s*[:\\-]?\\s*)" + dateRe);
    const amountDue = bestAmount(text);
    const vendor    = deriveVendor(text);
    const items     = deriveLineItems(text);

    return {
      vendor,
      invoice_number: invoiceNo || "",
      invoice_date: invDate || "",
      due_date: dueDate || "",
      po_number: poNumber || "",
      amount_due: amountDue || "",
      currency: guessCurrency(amountDue),
      items
    };
  }

  function bestAmount(text) {
    const labelRes = [
      /(amount\s*due)[:\s]*([$]?\s?\d[\d,]*\.\d{2})/i,
      /(total\s*due)[:\s]*([$]?\s?\d[\d,]*\.\d{2})/i,
      /(invoice\s*total)[:\s]*([$]?\s?\d[\d,]*\.\d{2})/i,
      /(?:\btotal\b)[:\s]*([$]?\s?\d[\d,]*\.\d{2})/i,
    ];
    for (const re of labelRes) {
      const m = text.match(re);
      if (m) return m[2] || m[1];
    }
    const all = [...text.matchAll(/\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})/g)].map(m => m[0]);
    const toNum = s => Number(String(s).replace(/[^0-9.]/g,"")) || 0;
    return all.sort((a,b)=>toNum(b)-toNum(a))[0] || "";
  }

  const guessCurrency = (amt) =>
    /\$/.test(amt) ? "USD" : /€/.test(amt) ? "EUR" : /£/.test(amt) ? "GBP" : "USD";

  function deriveVendor(text) {
    const idx = text.search(/invoice\s*(no\.|#|number|date)?/i);
    if (idx > 0) {
      const before = text.slice(Math.max(0, idx - 140), idx);
      const words = before.replace(/[^A-Za-z0-9&.,\- ]/g," ").split(/\s+/).filter(Boolean);
      return words.slice(-6).join(" ").replace(/\s{2,}/g," ").trim();
    }
    return "";
  }

  function deriveLineItems(text) {
    const chunks = text.split(/\s{2,}|(?<=\d)\s(?=\d)/g);
    const items = [];
    for (const ln of chunks) {
      const qty = (ln.match(/\bqty[:\s]*(\d{1,3})\b/i)?.[1]) || (ln.match(/\b(\d{1,3})\s*(x|×)\b/i)?.[1]);
      const price = (ln.match(/\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})/)||[])[0];
      if (qty && price && /\D{4,}/.test(ln)) {
        items.push({
          description: ln.replace(/qty[:\s]*\d{1,3}|(\d{1,3}\s*(x|×))|\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})/gi,"").trim(),
          quantity: Number(qty),
          unit_price: price
        });
      }
      if (items.length >= 10) break;
    }
    return items;
  }

  // ===== UI wiring =====
  let hiddenInput;

  function ensureHiddenFileInput() {
    if (hiddenInput) return hiddenInput;
    hiddenInput = document.createElement("input");
    hiddenInput.type = "file";
    hiddenInput.accept = "application/pdf";
    hiddenInput.style.display = "none";
    document.body.appendChild(hiddenInput);
    hiddenInput.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) handleFile(f);
      hiddenInput.value = "";
    });
    return hiddenInput;
  }

  function bindButtons() {
    const btn = $("#upload-invoice-btn") || $("#new-invoice-btn") || document.querySelector('[data-role="upload-invoice"]');
    if (btn) {
      btn.addEventListener("click", () => ensureHiddenFileInput().click());
    }
  }

  function bindDragDrop() {
    document.addEventListener("dragover", (e) => { e.preventDefault(); });
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f && f.type === "application/pdf") handleFile(f);
    });
  }

  async function handleFile(file) {
    setStatus(`Reading ${file.name} …`);
    try {
      const buf = await file.arrayBuffer();
      const text = await extractPdfText(buf);
      setStatus("Parsing…");
      const parsed = parseInvoice(text);
      parsed._meta = { filename: file.name, parsedAt: new Date().toISOString() };
      store.add(parsed);
      setStatus("Added ✓");
      showPreview(parsed);
    } catch (err) {
      console.error(err);
      setStatus("Failed to parse this PDF.");
    }
  }

  // ===== Rendering =====
  function setStatus(msg) {
    const el = $("#parseStatus");
    if (el) el.textContent = msg;
  }

  function showPreview(obj) {
    const wrap = $("#preview");
    const box = $("#parsedJson");
    if (wrap && box) {
      wrap.style.display = "block";
      box.textContent = JSON.stringify(obj, null, 2);
    }
  }

  function render() {
    const data = store.all();

    // Count badge (any of these IDs work)
    const countEl = $("#invoicesCount") || $("#countPill");
    if (countEl) countEl.textContent = `${data.length} invoice${data.length === 1 ? "" : "s"}`;

    // Table (optional)
    const tbody = $("#invoice-tbody") || $("#tbody");
    const table = $("#invoice-table") || $("#tbl");
    const empty = $("#emptyState");

    if (!tbody || !table) return; // no table in this page; skip

    if (!data.length) {
      if (empty) empty.style.display = "block";
      table.style.display = "none";
      tbody.innerHTML = "";
      return;
    }

    if (empty) empty.style.display = "none";
    table.style.display = "table";
    tbody.innerHTML = data.map(row => `
      <tr>
        <td>${escapeHtml(row.vendor)}</td>
        <td>${escapeHtml(row.invoice_number)}</td>
        <td>${escapeHtml(row.invoice_date)}</td>
        <td>${escapeHtml(row.due_date)}</td>
        <td>${escapeHtml(row.po_number)}</td>
        <td>${escapeHtml(row.amount_due)}</td>
        <td><span class="pill">New</span></td>
      </tr>
    `).join("");
  }

  // ===== Boot =====
  window.addEventListener("DOMContentLoaded", () => {
    bindButtons();
    bindDragDrop();
    render();
  });

  // Optional: expose a tiny API in case you want to hook buttons in HTML
  window.FL_AP = {
    addTest(inv) { store.add(inv); },
    clear() { store.clear(); },
    parseTextToInvoice: parseInvoice
  };
})();
