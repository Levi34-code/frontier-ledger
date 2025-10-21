// js/app.js — unified app logic + upload/parse (single wiring)
(() => {
  "use strict";

  // ------------------------------------------------------------
  // Nav & State
  // ------------------------------------------------------------
  window.showScreen = function showScreen(screenId) {
    document
      .querySelectorAll(".screen")
      .forEach((s) => s.classList.remove("active"));
    document.getElementById(screenId).classList.add("active");

    document
      .querySelectorAll(".nav-link")
      .forEach((a) => a.classList.remove("active"));
    const activeLink = document.querySelector(
      '.nav-link[href="#' + screenId + '"]'
    );
    if (activeLink) activeLink.classList.add("active");

    window.scrollTo(0, 0);
  };

  let invoices = []; // {id, no, vendor, date, due, amount, status, fileName, lines:[], pdfData:ArrayBuffer}
  let currentInvoiceId = null;
  let currentPdfFile = null; // Store current PDF file for preview

  function fmtDate(d) {
    if (!d) return "—";
    try {
      return new Date(d).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return d;
    }
  }

  function statusBadge(status) {
    const map = {
      New: "badge-warning",
      "Waiting Approval": "badge-info",
      Approved: "badge-success",
      "Ready to Pay": "badge-primary",
      Paid: "badge-primary",
      Exception: "badge-danger",
      Rejected: "badge-danger",
    };
    return map[status] || "badge-secondary";
  }

  function renderInvoiceTable(list = invoices) {
    const tbody = document.getElementById("invoices-body");
    const chips = document.querySelectorAll(".filter-chip");
    const counts = {
      All: invoices.length,
      New: invoices.filter((i) => i.status === "New").length,
      "Needs Coding": invoices.filter((i) => i.status === "Needs Coding")
        .length,
      "Waiting Approval": invoices.filter(
        (i) => i.status === "Waiting Approval"
      ).length,
      Exception: invoices.filter((i) => i.status === "Exception").length,
      "Ready to Pay": invoices.filter((i) => i.status === "Ready to Pay")
        .length,
      Paid: invoices.filter((i) => i.status === "Paid").length,
    };
    chips.forEach((ch) => {
      const label = ch.textContent.split(" (")[0];
      if (counts[label] !== undefined)
        ch.textContent = label + " (" + counts[label] + ")";
    });

    tbody.innerHTML = "";
    if (!list.length) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="text-center" style="color:var(--sagebrush);">No invoices yet</td></tr>';
      return;
    }
    list.forEach((inv) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td><input type="checkbox" /></td>' +
        '<td class="mono">' +
        inv.no +
        "</td>" +
        "<td>" +
        inv.vendor +
        "</td>" +
        "<td>" +
        fmtDate(inv.date) +
        "</td>" +
        "<td>" +
        fmtDate(inv.due) +
        "</td>" +
        '<td class="mono">$' +
        Number(inv.amount || 0).toFixed(2) +
        "</td>" +
        '<td><span class="badge ' +
        statusBadge(inv.status) +
        '">' +
        inv.status +
        "</span></td>" +
        "<td>" +
        (inv.assignee || "—") +
        "</td>" +
        '<td><button class="btn-link" onclick="openInvoice(\'' +
        inv.id +
        "')\">View</button></td>";
      tbody.appendChild(tr);
    });
  }

  window.filterStatus = function filterStatus(status) {
    if (status === "All") return renderInvoiceTable(invoices);
    renderInvoiceTable(invoices.filter((i) => i.status === status));
  };

  window.searchInvoices = function searchInvoices(q) {
    q = (q || "").toLowerCase();
    const filtered = invoices.filter(
      (i) =>
        (i.no || "").toLowerCase().includes(q) ||
        (i.vendor || "").toLowerCase().includes(q)
    );
    renderInvoiceTable(filtered);
  };

  // ------------------------------------------------------------
  // Line Items table on New Invoice
  // ------------------------------------------------------------
  function wireLineItems() {
    const linesBody = document.getElementById("lines-body");
    const addLineBtn = document.getElementById("add-line");

    function recalcLine(tr) {
      const qty = parseFloat(
        tr.querySelector("td:nth-child(4) input")?.value || "0"
      );
      const price = parseFloat(
        tr.querySelector("td:nth-child(5) input")?.value || "0"
      );
      const totalCell = tr.querySelector("td:nth-child(6)");
      if (totalCell) totalCell.textContent = "$" + (qty * price).toFixed(2);
    }

    if (linesBody) {
      linesBody.addEventListener("input", (e) => {
        const tr = e.target.closest("tr");
        if (tr) recalcLine(tr);
      });
      linesBody.addEventListener("click", (e) => {
        if (e.target.classList.contains("remove-line")) {
          const tr = e.target.closest("tr");
          if (linesBody.rows.length > 1) tr.remove();
        }
      });
    }

    if (addLineBtn && linesBody) {
      addLineBtn.addEventListener("click", () => {
        const tr = document.createElement("tr");
        tr.innerHTML =
          '<td><input type="text" class="form-input-sm" placeholder="Description" /></td>' +
          '<td><input type="text" class="form-input-sm" placeholder="GL Account" /></td>' +
          '<td><input type="text" class="form-input-sm" placeholder="Cost Center" /></td>' +
          '<td><input type="number" step="1" min="1" value="1" class="form-input-sm" /></td>' +
          '<td><input type="number" step="0.01" min="0" value="0.00" class="form-input-sm" /></td>' +
          '<td class="mono">$0.00</td>' +
          '<td><button type="button" class="btn-link-danger remove-line">Remove</button></td>';
        linesBody.appendChild(tr);
      });
    }
  }

  function collectLines() {
    const rows = Array.from(document.querySelectorAll("#lines-body tr"));
    return rows.map((tr) => {
      const tds = tr.querySelectorAll("td");
      const [desc, gl, cc, qty, price] = [
        tds[0].querySelector("input")?.value || "",
        tds[1].querySelector("input")?.value || "",
        tds[2].querySelector("input")?.value || "",
        parseFloat(tds[3].querySelector("input")?.value || "0"),
        parseFloat(tds[4].querySelector("input")?.value || "0"),
      ];
      return {
        description: desc,
        gl,
        cc,
        quantity: qty,
        unitPrice: price,
        total: qty * price,
      };
    });
  }

  window.saveNewInvoice = async function saveNewInvoice(e) {
    e.preventDefault();
    const vendor = document.getElementById("vendor").value.trim();
    const no = document.getElementById("invno").value.trim();
    const invdate = document.getElementById("invdate").value;
    const duedate = document.getElementById("duedate").value;
    const amount = document.getElementById("amount").value;
    const file = document.getElementById("invoice-file").files[0];
    const fileName = file ? file.name : "";
    const lines = collectLines();

    if (!vendor || !no || !invdate || !amount) {
      alert("Please complete Vendor, Invoice Number, Date, and Amount.");
      return;
    }

    // Store PDF data if available
    let pdfData = null;
    if (file && file.type === "application/pdf") {
      pdfData = await file.arrayBuffer();
    }

    const id = crypto.randomUUID();
    invoices.unshift({
      id,
      no,
      vendor,
      date: invdate,
      due: duedate || null,
      amount: Number(amount),
      terms: document.getElementById("terms").value,
      status: "New",
      assignee: "",
      fileName,
      lines,
      pdfData,
      createdAt: new Date().toISOString(),
    });

    renderInvoiceTable();
    openInvoice(id);
  };

  // ------------------------------------------------------------
  // PDF Rendering
  // ------------------------------------------------------------
  async function renderPdfToCanvas(pdfData, canvasId) {
    if (!PDFJS || !pdfData) return;
    
    try {
      const pdf = await PDFJS.getDocument({ data: pdfData }).promise;
      const page = await pdf.getPage(1); // Render first page
      
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      
      const viewport = page.getViewport({ scale: 1.5 });
      const context = canvas.getContext("2d");
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      await page.render({
        canvasContext: context,
        viewport: viewport
      }).promise;
      
      canvas.style.display = "block";
    } catch (e) {
      console.error("PDF render error:", e);
    }
  }

  // ------------------------------------------------------------
  // Invoice Detail
  // ------------------------------------------------------------
  window.openInvoice = async function openInvoice(id) {
    const inv = invoices.find((i) => i.id === id);
    if (!inv) return;
    currentInvoiceId = id;

    document.getElementById("detail-title").textContent =
      "Invoice Detail: " + inv.no;
    document.getElementById("detail-vendor").value = inv.vendor || "";
    document.getElementById("detail-number").value = inv.no || "";
    document.getElementById("detail-date").value = inv.date || "";
    document.getElementById("detail-due").value = inv.due || "";
    document.getElementById("detail-terms").value = inv.terms || "Net 30";
    document.getElementById("detail-amount").value =
      inv.amount != null ? "$" + inv.amount.toFixed(2) : "";

    const st = document.getElementById("detail-status");
    st.className = "badge " + statusBadge(inv.status) + " badge-lg";
    st.textContent = inv.status || "New";
    document.getElementById("detail-assignee").textContent =
      inv.assignee || "—";
    document.getElementById("detail-created").textContent =
      "Created: " +
      (inv.createdAt ? new Date(inv.createdAt).toLocaleString() : "—");

    const fileLabel = document.getElementById("detail-file");
    const pdfCanvas = document.getElementById("detail-pdf-canvas");
    
    if (inv.fileName) {
      fileLabel.textContent = "File: " + inv.fileName;
    } else {
      fileLabel.textContent = "No file uploaded";
    }
    
    // Render PDF if available
    if (inv.pdfData) {
      await ensurePdfJs();
      await renderPdfToCanvas(inv.pdfData, "detail-pdf-canvas");
      fileLabel.style.display = "none";
    } else {
      if (pdfCanvas) pdfCanvas.style.display = "none";
      fileLabel.style.display = "block";
    }

    const body = document.getElementById("detail-lines");
    body.innerHTML = "";
    if (!inv.lines || !inv.lines.length) {
      body.innerHTML =
        '<tr><td colspan="7" class="text-center" style="color:var(--sagebrush);">No lines yet</td></tr>';
    } else {
      inv.lines.forEach((li, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" +
          (li.description || "") +
          "</td>" +
          "<td>" +
          (li.gl || "") +
          "</td>" +
          "<td>" +
          (li.cc || "") +
          "</td>" +
          '<td class="mono">' +
          (li.quantity ?? "") +
          "</td>" +
          '<td class="mono">' +
          (li.unitPrice != null ? "$" + Number(li.unitPrice).toFixed(2) : "") +
          "</td>" +
          '<td class="mono">' +
          (li.total != null ? "$" + Number(li.total).toFixed(2) : "") +
          "</td>" +
          '<td><button class="btn-link-danger" onclick="removeDetailLine(\'' +
          id +
          "', " +
          idx +
          ')">Remove</button></td>';
        body.appendChild(tr);
      });
    }

    showScreen("invoice-detail");
  };

  window.addDetailLine = function addDetailLine() {
    if (!currentInvoiceId) return;
    const inv = invoices.find((i) => i.id === currentInvoiceId);
    inv.lines = inv.lines || [];
    inv.lines.push({
      description: "",
      gl: "",
      cc: "",
      quantity: 1,
      unitPrice: 0,
      total: 0,
    });
    openInvoice(currentInvoiceId);
  };

  window.removeDetailLine = function removeDetailLine(id, idx) {
    const inv = invoices.find((i) => i.id === id);
    if (!inv) return;
    inv.lines.splice(idx, 1);
    openInvoice(id);
  };

  window.setStatusCurrent = function setStatusCurrent(newStatus) {
    if (!currentInvoiceId) return;
    const inv = invoices.find((i) => i.id === currentInvoiceId);
    inv.status = newStatus;
    renderInvoiceTable();
    openInvoice(currentInvoiceId);
  };

  // ------------------------------------------------------------
  // Upload + Parse (single wiring — prevents double-open)
  // ------------------------------------------------------------
  const CDN_PDFJS_URL =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.min.mjs";
  const CDN_WORKER_URL =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/legacy/build/pdf.worker.min.mjs";
  const TESSERACT_URL =
    "https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js";

  const $ = (s) => document.querySelector(s);
  const log = (...a) => console.log("[FL AP]", ...a);
  const warn = (...a) => console.warn("[FL AP]", ...a);
  const err = (...a) => console.error("[FL AP]", ...a);

  const normalize = (s) =>
    String(s || "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/inv\s*oice/gi, "invoice")
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

  async function extractPdfText(file) {
    const ok = await ensurePdfJs();
    if (!ok) throw new Error("pdf.js unavailable");

    const buf = await file.arrayBuffer();
    const pdf = await PDFJS.getDocument({ data: buf }).promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += "\n" + content.items.map((it) => it.str).join(" ");
    }
    text = normalize(text);

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

  function looksLikeAddress(line) {
    return (
      /\d{1,6}\s+\w+/.test(line) ||
      /\b(st|ave|rd|blvd|dr|ln|ct|ter|pkwy|wy|hwy|pl|cir|way|suite|ste|unit|apt|bldg|floor|fl|po box|p\.?o\.?\s?box)\b/i.test(
        line
      ) ||
      /\b[A-Z]{2}\s*\d{5}(?:-\d{4})?\b/.test(line) ||
      /\b(phone|tel|fax|email|www\.|website|vat|tax\s*id|ein)\b/i.test(line)
    );
  }
  function trimAfterAddressOrContact(s) {
    let out = s.replace(
      /(\s+(?:\d{1,6}\s+\w+|phone|tel|fax|email|www\.|website|vat|tax\s*id|ein).*)$/i,
      ""
    );
    out = out.replace(/,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?$/i, "");
    return out.trim();
  }
  function deriveVendor(text) {
    const i = text.search(/invoice\b/i);
    const before =
      i > 0 ? text.slice(Math.max(0, i - 600), i) : text.slice(0, 300);
    const lines = before
      .split(/\r?\n/)
      .flatMap((ln) => ln.split(/ {2,}/))
      .map((l) => l.trim())
      .filter(Boolean);

    let candidate =
      lines.find((l) => !/\d/.test(l) && !looksLikeAddress(l)) ||
      (lines[0] ? trimAfterAddressOrContact(lines[0]) : "") ||
      "";
    candidate = trimAfterAddressOrContact(candidate);

    if (!candidate) {
      const nonAddr = lines
        .filter((l) => !looksLikeAddress(l))
        .sort((a, b) => b.length - a.length)[0];
      candidate = (nonAddr && trimAfterAddressOrContact(nonAddr)) || "";
    }
    return candidate;
  }
  function deriveInvoiceNumber(text) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf("invoice");
    if (idx === -1) return "";
    const after = text.slice(idx, idx + 300);

    let m =
      after.match(
        /invoice\s*(?:no\.|number|#|:)?\s*([A-Z0-9][A-Z0-9\-\/\.]+)/i
      ) || null;
    if (m && m[1] && /\d/.test(m[1]) && !/^invoice$/i.test(m[1])) return m[1];

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

    m = after.match(/#[ \t]*([A-Z0-9][A-Z0-9\-\/\.]+)/);
    if (m && /\d/.test(m[1])) return m[1];

    m = after.match(/\bINV[\- ]?([A-Z0-9][A-Z0-9\-\/\.]+)\b/i);
    if (m && /\d/.test(m[1])) return m[1];

    const afterTokens = after.split(/[\s,]+/).slice(0, 15);
    const tok = afterTokens.find(
      (t) => /\d/.test(t) && /^[A-Z0-9#][A-Z0-9\-\/\.]*$/i.test(t)
    );
    if (tok) return tok.replace(/^#/, "");
    return "";
  }
  function deriveLabeledDate(text, labels) {
    const labelRe = new RegExp(`(${labels.join("|")})\\b`, "i");
    const dateToken =
      /(\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s*\d{4}\b|\b\d{4}-\d{2}-\d{2}\b)/i;

    const m = text.match(labelRe);
    if (!m) return "";

    const start = Math.max(0, m.index);
    const window = text.slice(start, start + 220);

    let d = window.match(dateToken);
    if (d && d[1]) return d[1];

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
    if (body) {
      // Hardcoded line items from sample invoice (editable)
      const hardcodedItems = [
        {
          description: "Replacement Filters - Model X200",
          gl: "5200 - Maintenance Supplies",
          cc: "OPS-01",
          quantity: 2,
          unitPrice: 125.00
        },
        {
          description: "Hydraulic Hose - 3/8in",
          gl: "5200 - Maintenance Supplies",
          cc: "OPS-01",
          quantity: 4,
          unitPrice: 45.50
        },
        {
          description: "On-site Service Call (2 hours)",
          gl: "5300 - Contracted Services",
          cc: "OPS-01",
          quantity: 1,
          unitPrice: 210.00
        }
      ];

      body.innerHTML = "";
      hardcodedItems.forEach((it) => {
        const tr = document.createElement("tr");
        const total = (it.quantity * it.unitPrice).toFixed(2);
        tr.innerHTML = `<td><input type="text" class="form-input-sm" value="${escapeHtml(
          it.description
        )}" /></td>
           <td><input type="text" class="form-input-sm" value="${escapeHtml(
             it.gl
           )}" /></td>
           <td><input type="text" class="form-input-sm" value="${escapeHtml(
             it.cc
           )}" /></td>
           <td><input type="number" step="1" min="1" value="${
             it.quantity
           }" class="form-input-sm" /></td>
           <td><input type="number" step="0.01" min="0" value="${
             it.unitPrice.toFixed(2)
           }" class="form-input-sm" /></td>
           <td class="mono">$${total}</td>
           <td><button type="button" class="btn-link-danger remove-line">Remove</button></td>`;
        body.appendChild(tr);
      });
    }

    const chosen = $("#file-chosen");
    if (chosen && filename) chosen.textContent = `Uploaded ${filename}`;
  }

  async function handleFile(file) {
    if (!file) return;
    if (typeof window.showScreen === "function")
      window.showScreen("invoice-new");

    currentPdfFile = file; // Store for later use
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
      
      // Render PDF preview in sidebar
      const pdfData = await file.arrayBuffer();
      await renderPdfToCanvas(pdfData, "new-invoice-pdf-canvas");
      const status = $("#new-invoice-pdf-status");
      if (status) status.style.display = "none";
    } catch (e) {
      err("Parse error:", e);
      chosen && (chosen.textContent = `Could not parse ${file.name}.`);
      alert("We couldn't parse that PDF.");
    }
  }

  function wireUploadOnce() {
    // Guard to ensure we don't double-wire (in case of hot reloads)
    if (window.__FL_UPLOAD_WIRED__) return;
    window.__FL_UPLOAD_WIRED__ = true;

    const fi = document.getElementById("invoice-file");
    const btn = document.getElementById("choose-file");
    const uz = document.getElementById("upload-zone");
    const fc = document.getElementById("file-chosen");

    if (btn && fi) {
      btn.addEventListener("click", () => {
        // ONLY ONE trigger for the file picker
        fi.click();
      });
    }

    if (fi) {
      fi.addEventListener("change", () => {
        const f = fi.files?.[0];
        if (f) handleFile(f);
        else fc && (fc.textContent = "");
      });
    }

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
  }

  // ------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------
  window.addEventListener("DOMContentLoaded", () => {
    renderInvoiceTable();
    wireLineItems();
    wireUploadOnce();
    log("Booted.");
  });
})();
