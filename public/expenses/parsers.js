// Statement parsers: turn an uploaded PDF / XLSX / XLS / CSV into raw transactions.
// Runs entirely in the browser (SheetJS + pdf.js); nothing is uploaded anywhere.
(function (global) {
  "use strict";

  const HEBREW = /[֐-׿]/;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  // ---------- value helpers ----------

  function pad(n) { return String(n).padStart(2, "0"); }

  function isoDate(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  /** Parse a date from Excel serials, Date objects, and common string formats. */
  function parseDate(v, order, fallbackYear) {
    if (v == null || v === "") return null;
    if (v instanceof Date && !isNaN(v)) return isoDate(v.getFullYear(), v.getMonth() + 1, v.getDate());
    if (typeof v === "number") {
      if (v > 20000 && v < 80000) { // Excel serial date
        const d = new Date(Math.round((v - 25569) * 86400000));
        return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      }
      return null;
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return isoDate(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
    if (m) return order === "MDY" ? isoDate(+m[3], +m[1], +m[2]) : isoDate(+m[3], +m[2], +m[1]);
    m = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (m && fallbackYear) return order === "MDY" ? isoDate(fallbackYear, +m[1], +m[2]) : isoDate(fallbackYear, +m[2], +m[1]);
    m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]*(\d{2,4})?/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return isoDate(+(m[3] || fallbackYear), MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})?/);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return isoDate(+(m[3] || fallbackYear), MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
    return null;
  }

  /** Parse an amount like "1,234.50", "(12.00)", "12.00-", "₪ 45", "$9.99 CR". */
  function parseAmount(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    let s = String(v).trim();
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/\bCR\b|זיכוי/i.test(s)) neg = true;
    if (/-\s*$/.test(s)) { neg = true; s = s.replace(/-\s*$/, ""); }
    if (/^\s*[-−]/.test(s) || /[₪$€£]\s*[-−]/.test(s)) neg = true;
    s = s.replace(/[^\d.,]/g, "");
    if (!/\d/.test(s)) return null;
    // European style "1.234,56" → "1234.56"
    if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    const n = parseFloat(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  function detectCurrency(text) {
    if (/₪|ש"ח|ש״ח|\bILS\b|\bNIS\b/.test(text) || HEBREW.test(text)) return "ILS";
    if (/€|\bEUR\b/.test(text)) return "EUR";
    if (/£|\bGBP\b/.test(text)) return "GBP";
    return "USD";
  }

  function currencyCode(v) {
    const s = String(v || "").trim();
    if (!s) return null;
    if (/₪|ש"ח|ש״ח|ILS|NIS|שקל/.test(s)) return "ILS";
    if (/\$|USD|דולר/.test(s)) return "USD";
    if (/€|EUR|אירו|יורו/.test(s)) return "EUR";
    if (/£|GBP|ליש"ט|פאונד/.test(s)) return "GBP";
    const m = s.match(/\b[A-Z]{3}\b/);
    return m ? m[0] : null;
  }

  function parseInstallment(text) {
    const s = String(text || "");
    let m = s.match(/תשלום\s*(\d+)\s*(?:מתוך|מ-|\/)\s*(\d+)/) || s.match(/(\d+)\s*מתוך\s*(\d+)/) ||
      s.match(/(?:installment|payment|inst\.?)\s*(\d+)\s*(?:of|\/)\s*(\d+)/i);
    if (m && +m[2] > 1 && +m[1] <= +m[2]) return { n: +m[1], of: +m[2] };
    return null;
  }

  // Guess DD/MM vs MM/DD from a sample of date strings.
  function guessDateOrder(samples, hebrew) {
    let dmy = 0, mdy = 0;
    for (const s of samples) {
      const m = String(s).match(/^(\d{1,2})[-/.](\d{1,2})/);
      if (!m) continue;
      if (+m[1] > 12) dmy++;
      if (+m[2] > 12) mdy++;
    }
    if (dmy > mdy) return "DMY";
    if (mdy > dmy) return "MDY";
    return hebrew ? "DMY" : "MDY";
  }

  const SKIP_ROW = /^(total|totals|subtotal|balance|previous balance|new balance|סה["״']?כ|סך הכל|יתרה|סיכום)/i;

  // ---------- spreadsheet parsing ----------

  // Column synonyms, in priority order. Headers are matched exactly first, then by substring.
  const FIELDS = {
    date: ["תאריך עסקה", "תאריך רכישה", "transaction date", "trans. date", "trans date", "purchase date", "date", "תאריך"],
    postDate: ["תאריך חיוב", "posted date", "post date", "posting date", "billing date"],
    description: ["שם בית העסק", "שם בית עסק", "בית העסק", "בית עסק", "merchant name", "merchant", "description",
      "payee", "details", "transaction description", "תיאור", "פרטים", "name"],
    amount: ["סכום חיוב", "סכום החיוב", "סכום חיוב ₪", "charge amount", "billed amount", "billing amount",
      "amount", "debit", "חיוב", "סכום בש\"ח", "סכום"],
    origAmount: ["סכום עסקה", "סכום העסקה", "סכום עסקה מקורי", "original amount", "transaction amount", "foreign amount"],
    card: ["4 ספרות אחרונות של כרטיס האשראי", "4 ספרות אחרונות", "card number", "card", "כרטיס", "account"],
    credit: ["credit", "credits", "זיכוי"],
    currency: ["מטבע עסקה", "מטבע מקור", "currency", "מטבע"],
    hint: ["קטגוריה", "ענף", "category", "sector", "type of business"],
    notes: ["פירוט נוסף", "הערות", "סוג עסקה", "notes", "memo", "type", "פירוט"],
  };

  function normHeader(v) {
    return String(v == null ? "" : v).toLowerCase().replace(/[\n\r]+/g, " ").replace(/[():]/g, "").replace(/\s+/g, " ").trim();
  }

  function mapHeaders(row) {
    const headers = row.map(normHeader);
    const map = {};
    const taken = new Set();
    for (const exact of [true, false]) {
      for (const [field, pats] of Object.entries(FIELDS)) {
        if (map[field] != null) continue;
        outer: for (const p of pats) {
          for (let i = 0; i < headers.length; i++) {
            const h = headers[i];
            if (!h || taken.has(i) || h.length > 60) continue;
            if (exact ? h === p : h.includes(p)) { map[field] = i; taken.add(i); break outer; }
          }
        }
      }
    }
    if (map.date == null && map.postDate != null) { map.date = map.postDate; delete map.postDate; }
    if (map.amount == null && map.origAmount != null) { map.amount = map.origAmount; delete map.origAmount; }
    const ok = map.date != null && map.description != null && (map.amount != null || map.credit != null);
    return ok ? map : null;
  }

  function parseSheetRows(rows, ctx) {
    const out = [];
    let map = null;
    // collect date samples to decide day/month order for this sheet
    const samples = [];
    for (const r of rows) for (const c of r) if (typeof c === "string" && /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(c.trim())) samples.push(c.trim());
    const order = guessDateOrder(samples, ctx.hebrew);

    for (const row of rows) {
      if (!row || !row.some((c) => c !== "" && c != null)) continue;
      const headerMap = mapHeaders(row);
      if (headerMap) { map = headerMap; continue; }
      if (!map) continue;
      const get = (f) => (map[f] != null ? row[map[f]] : undefined);
      const date = parseDate(get("date"), order, ctx.year) || parseDate(get("postDate"), order, ctx.year);
      const desc = String(get("description") ?? "").trim();
      if (!date || !desc || SKIP_ROW.test(desc)) continue;
      let amount = parseAmount(get("amount"));
      const credit = parseAmount(get("credit"));
      if ((amount == null || amount === 0) && credit) amount = -Math.abs(credit);
      if (amount == null || amount === 0) {
        const orig = parseAmount(get("origAmount"));
        if (orig) amount = orig; else continue;
      }
      let notes = String(get("notes") ?? "").trim();
      if (/^(sale|purchase|debit|credit|regular|רגילה|עסקה רגילה|רכישה)$/i.test(notes)) notes = "";
      const origAmount = parseAmount(get("origAmount"));
      const origCurrency = currencyCode(get("currency"));
      const cardCell = String(get("card") ?? "").match(/\d{4}/);
      out.push({
        date, description: desc, amount,
        origAmount: origAmount != null && origCurrency && origCurrency !== ctx.currency ? origAmount : null,
        origCurrency: origCurrency && origCurrency !== ctx.currency ? origCurrency : null,
        hint: String(get("hint") ?? "").trim() || null,
        notes: notes || null,
        installment: parseInstallment(notes) || parseInstallment(desc),
        card: cardCell ? cardCell[0] : ctx.card,
      });
    }
    return out;
  }

  function findCard(text) {
    const m = text.match(/(?:card|כרטיס|ending|מסתיים|account)[^\d\n]{0,40}(\d{4})(?!\d)/i);
    return m ? m[1] : null;
  }

  async function parseSpreadsheet(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true, codepage: 1255 });
    const all = [];
    let currency = null;
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
      const text = rows.slice(0, 400).map((r) => r.join(" ")).join("\n");
      const ctx = {
        hebrew: HEBREW.test(text),
        currency: detectCurrency(text),
        card: findCard(name + " " + text) || findCard(file.name),
        year: guessYear(text),
      };
      currency = currency || ctx.currency;
      all.push(...parseSheetRows(rows, ctx));
    }
    return { transactions: all, currency: currency || "USD" };
  }

  function guessYear(text) {
    const counts = {};
    for (const m of text.matchAll(/\b(20\d{2})\b/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? +best[0] : new Date().getFullYear();
  }

  // ---------- PDF parsing ----------

  const DATE_RE = new RegExp(
    [
      String.raw`\b\d{4}-\d{1,2}-\d{1,2}\b`,
      String.raw`\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b`,
      String.raw`\b\d{1,2}/\d{1,2}\b(?![/.\d])`,
      String.raw`\b\d{1,2}[\s-](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?(?:[\s-,]+\d{2,4})?\b`,
      String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?\b`,
    ].join("|"),
    "gi"
  );
  const AMOUNT_RE = /\(?-?\s?[₪$€£]?\s?-?\d{1,3}(?:,\d{3})*[.,]\d{2}\)?-?(?:\s?CR\b)?|\(?-?\s?[₪$€£]?\s?-?\d+[.,]\d{2}\)?-?(?:\s?CR\b)?/g;

  async function pdfLines(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const rows = [];
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = it.transform[5], x = it.transform[4];
        let row = rows.find((r) => Math.abs(r.y - y) < 3);
        if (!row) rows.push((row = { y, items: [] }));
        row.items.push({ x, str: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        const rtl = r.items.some((i) => HEBREW.test(i.str));
        r.items.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
        lines.push(r.items.map((i) => i.str.trim()).join("  "));
      }
    }
    return lines;
  }

  async function parsePdf(file) {
    const lines = await pdfLines(file);
    const text = lines.join("\n");
    const hebrew = HEBREW.test(text);
    const currency = detectCurrency(text);
    const year = guessYear(text);
    const card = findCard(text) || findCard(file.name);
    const samples = [];
    for (const l of lines) for (const m of l.matchAll(DATE_RE)) samples.push(m[0]);
    const order = guessDateOrder(samples, hebrew);

    const out = [];
    for (const line of lines) {
      const dates = [...line.matchAll(DATE_RE)];
      if (!dates.length) continue;
      const date = parseDate(dates[0][0], order, year);
      if (!date) continue;
      let rest = line.replace(DATE_RE, " ");
      const amounts = [...rest.matchAll(AMOUNT_RE)].map((m) => m[0]);
      if (!amounts.length) continue;
      const amount = parseAmount(amounts[amounts.length - 1]);
      if (amount == null || amount === 0) continue;
      const origAmount = amounts.length > 1 ? parseAmount(amounts[0]) : null;
      rest = rest.replace(AMOUNT_RE, " ");
      const installment = parseInstallment(rest);
      let desc = rest
        .replace(/תשלום\s*\d+\s*מתוך\s*\d+|\d+\s*מתוך\s*\d+/g, " ")
        .replace(/\b(USD|EUR|GBP|ILS|NIS)\b|[₪$€£]|ש"ח/g, " ")
        .replace(/\s{2,}/g, "  ")
        .trim();
      // keep the longest text chunk as the merchant; others become notes
      const chunks = desc.split(/\s{2,}/).filter((c) => /[\p{L}]/u.test(c));
      if (!chunks.length) continue;
      chunks.sort((a, b) => b.length - a.length);
      desc = chunks[0].trim();
      if (SKIP_ROW.test(desc) || desc.length < 2) continue;
      const lineCur = currencyCode((line.match(/\b(USD|EUR|GBP)\b|[$€£]/) || [])[0]);
      out.push({
        date, description: desc, amount,
        origAmount: lineCur && lineCur !== currency && origAmount != null ? origAmount : null,
        origCurrency: lineCur && lineCur !== currency ? lineCur : null,
        hint: null,
        notes: chunks.slice(1).join(" · ") || null,
        installment,
        card,
      });
    }
    return { transactions: out, currency };
  }

  async function parseFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    let result;
    if (ext === "pdf") result = await parsePdf(file);
    else if (["xlsx", "xls", "xlsm", "csv", "ods"].includes(ext)) result = await parseSpreadsheet(file);
    else throw new Error(`Unsupported file type: .${ext}`);
    // Some issuers export purchases as negative numbers. Expenses are stored as
    // positive amounts, so flip the file if most of its rows are negative.
    const txs = result.transactions;
    if (txs.filter((t) => t.amount < 0).length > txs.length / 2) {
      txs.forEach((t) => { t.amount = -t.amount; if (t.origAmount != null) t.origAmount = -t.origAmount; });
    }
    return result;
  }

  global.Parsers = { parseFile, parseDate, parseAmount, parseInstallment, mapHeaders, parseSheetRows };
})(window);
