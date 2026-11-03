(function () {
  "use strict";

  const { CATEGORIES, BY_ID, categorize, merchantKey } = window.Categories;
  const STORE_KEY = "expense-tracker-v1";
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- state & persistence ----------

  let state = { transactions: [], rules: [], imports: [], currency: null };
  const ui = { tab: "overview", period: "all", card: "all", search: "", catFilter: "all", sort: { key: "date", dir: -1 }, openCats: new Set() };

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) state = Object.assign(state, JSON.parse(raw));
    } catch (e) { /* storage unavailable: start empty */ }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast("Couldn't save to browser storage — data will be lost on reload."); }
  }

  // ---------- helpers ----------

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const sum = (arr, f = (x) => x.amount) => arr.reduce((a, x) => a + f(x), 0);
  const monthOf = (d) => d.slice(0, 7);
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function money(n, opts = {}) {
    const cur = state.currency || "USD";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: opts.whole ? 0 : 2, minimumFractionDigits: opts.whole ? 0 : 2 }).format(n);
    } catch { return n.toFixed(2) + " " + cur; }
  }
  function moneyIn(n, cur) {
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n); }
    catch { return n.toFixed(2) + " " + cur; }
  }
  function monthLabel(ym, long) {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, long ? { month: "long", year: "numeric" } : { month: "short", year: "2-digit" });
  }
  function prevMonth(ym) {
    let [y, m] = ym.split("-").map(Number);
    m--; if (m === 0) { m = 12; y--; }
    return `${y}-${String(m).padStart(2, "0")}`;
  }
  function fmtDate(d) {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(y, m - 1, day).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }
  function pctChange(cur, prev) {
    if (!prev) return null;
    return ((cur - prev) / Math.abs(prev)) * 100;
  }
  function changeHtml(pct, suffix = "") {
    if (pct == null || !isFinite(pct)) return "";
    const cls = pct > 0 ? "up" : "down";
    return `<span class="${cls}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}%</span>${suffix}`;
  }
  const isExcluded = (t) => BY_ID[t.category]?.excluded;
  const spendOf = (list) => sum(list.filter((t) => !isExcluded(t)));

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.hidden = true), 3800);
  }

  // ---------- data operations ----------

  function applyCategory(t) {
    t.merchant = t.merchant || merchantKey(t.description);
    t.category = t.manualCategory || categorize(t, state.rules);
  }
  function recategorizeAll() { state.transactions.forEach(applyCategory); }

  const dedupeKey = (t) => [t.date, t.description.toLowerCase(), t.amount.toFixed(2), t.card || ""].join("|");

  function addTransactions(raw, source) {
    // Count-based de-duplication: re-importing the same statement adds nothing,
    // but two genuine identical purchases on the same day are both kept.
    const existing = {};
    for (const t of state.transactions) { const k = dedupeKey(t); existing[k] = (existing[k] || 0) + 1; }
    const seen = {};
    let added = 0, skipped = 0;
    for (const r of raw) {
      const t = { id: uid(), source, ...r, amount: Math.round(r.amount * 100) / 100 };
      const k = dedupeKey(t);
      seen[k] = (seen[k] || 0) + 1;
      if (seen[k] <= (existing[k] || 0)) { skipped++; continue; }
      applyCategory(t);
      state.transactions.push(t);
      added++;
    }
    return { added, skipped };
  }

  async function importFiles(files) {
    const status = $("#importStatus");
    status.innerHTML = "";
    for (const file of files) {
      const line = document.createElement("div");
      line.textContent = `⏳ Reading ${file.name}…`;
      status.appendChild(line);
      try {
        const { transactions, currency } = await Parsers.parseFile(file);
        if (!transactions.length) throw new Error("no transactions found — is this a statement with dates and amounts?");
        if (!state.currency) state.currency = currency;
        const { added, skipped } = addTransactions(transactions, file.name);
        const cards = [...new Set(transactions.map((t) => t.card).filter(Boolean))];
        const prev = state.imports.find((i) => i.source === file.name);
        if (prev) { prev.count += added; prev.importedAt = new Date().toISOString(); }
        else state.imports.push({ source: file.name, count: added, cards, importedAt: new Date().toISOString() });
        line.innerHTML = `✅ <strong>${esc(file.name)}</strong>: ${added} transaction${added === 1 ? "" : "s"} added` +
          (skipped ? ` <span class="muted">(${skipped} already imported)</span>` : "");
      } catch (e) {
        console.error(e);
        line.className = "err";
        line.textContent = `⚠️ ${file.name}: ${e.message || e}`;
      }
    }
    save();
    // jump to the most recent month after an import
    const months = allMonths();
    if (months.length && ui.period !== "all" && !months.includes(ui.period)) ui.period = months[0];
    render();
  }

  // ---------- derived data ----------

  function scoped() { return state.transactions.filter((t) => ui.card === "all" || (t.card || "—") === ui.card); }
  function inPeriod(list, period) { return period === "all" ? list : list.filter((t) => monthOf(t.date) === period); }
  function allMonths() { return [...new Set(state.transactions.map((t) => monthOf(t.date)))].sort().reverse(); }

  const BILL_LIKE = new Set(["subscriptions", "utilities", "fitness", "insurance", "education", "kids", "fees"]);

  /** Recurring charges: same merchant, ≥2 different months, steady amount, not an installment plan. */
  function findRecurring(list) {
    const byM = groupBy(list.filter((t) => t.amount > 0 && !t.installment && !isExcluded(t)), (t) => t.merchant);
    const out = [];
    for (const [key, txs] of byM) {
      const months = new Set(txs.map((t) => monthOf(t.date)));
      if (months.size < 2 || txs.length > months.size * 1.5) continue;
      const amts = txs.map((t) => t.amount);
      const med = median(amts);
      // Bills and subscriptions may drift in price; for everyday categories only
      // an (almost) identical charge across 3+ months counts as recurring.
      const billLike = BILL_LIKE.has(txs[0].category) || txs.some((t) => /הוראת קבע|standing order|recurring|autopay/i.test(t.notes || ""));
      const tol = billLike ? 0.25 : 0.01;
      if (!billLike && months.size < 3) continue;
      if (amts.some((a) => Math.abs(a - med) > Math.max(med * tol, 0.5))) continue;
      const last = txs.reduce((a, b) => (a.date > b.date ? a : b));
      out.push({ merchant: key, name: last.description, category: last.category, monthly: med, months: months.size, last: last.date });
    }
    return out.sort((a, b) => b.monthly - a.monthly);
  }

  /** Installment plans: keep the latest payment of each plan and project what is still owed. */
  function findInstallments(list) {
    const plans = new Map();
    for (const t of list) {
      if (!t.installment) continue;
      const k = t.merchant + "|" + t.installment.of + "|" + t.amount.toFixed(0);
      const p = plans.get(k);
      if (!p || t.installment.n > p.installment.n) plans.set(k, t);
    }
    return [...plans.values()].map((t) => ({
      t, remaining: (t.installment.of - t.installment.n) * t.amount, left: t.installment.of - t.installment.n,
    })).sort((a, b) => b.remaining - a.remaining);
  }

  function groupBy(list, f) {
    const m = new Map();
    for (const x of list) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return m;
  }

  function categoryTotals(list) {
    const m = groupBy(list.filter((t) => !isExcluded(t)), (t) => t.category);
    return [...m].map(([id, txs]) => ({ id, cat: BY_ID[id] || BY_ID.other, txs, total: sum(txs) }))
      .sort((a, b) => b.total - a.total);
  }

  // ---------- rendering ----------

  function render() {
    renderControls();
    const has = state.transactions.length > 0;
    $("#empty").hidden = has;
    $(".tabs").hidden = !has;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === ui.tab));
    document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = !has || p.id !== "tab-" + ui.tab));
    if (!has) return;
    ({ overview: renderOverview, categories: renderCategories, transactions: renderTransactions, rules: renderRules, imports: renderImports })[ui.tab]();
  }

  function renderControls() {
    const months = allMonths();
    if (ui.period !== "all" && !months.includes(ui.period)) ui.period = "all";
    $("#periodSelect").innerHTML = `<option value="all">All time</option>` +
      months.map((m) => `<option value="${m}">${monthLabel(m, true)}</option>`).join("");
    $("#periodSelect").value = ui.period;
    const cards = [...new Set(state.transactions.map((t) => t.card || "—"))].sort();
    if (ui.card !== "all" && !cards.includes(ui.card)) ui.card = "all";
    $("#cardSelect").innerHTML = `<option value="all">All cards</option>` +
      cards.map((c) => `<option value="${esc(c)}">${c === "—" ? "Unknown card" : "•••• " + esc(c)}</option>`).join("");
    $("#cardSelect").value = ui.card;
    $("#currencySelect").value = state.currency || "USD";
  }

  function catBadge(cat) {
    return `<span class="cat-dot" style="background:${cat.color}22;color:${cat.color}">${cat.icon}</span>`;
  }

  function renderOverview() {
    const all = scoped();
    const cur = inPeriod(all, ui.period);
    const months = [...new Set(all.map((t) => monthOf(t.date)))].sort();
    const isMonth = ui.period !== "all";
    const prevList = isMonth ? inPeriod(all, prevMonth(ui.period)) : [];
    const spend = spendOf(cur);
    const prevSpend = spendOf(prevList);
    const refunds = Math.abs(sum(cur.filter((t) => t.amount < 0 && !isExcluded(t))));
    const purchases = cur.filter((t) => t.amount > 0 && !isExcluded(t));
    const days = isMonth ? new Date(+ui.period.slice(0, 4), +ui.period.slice(5), 0).getDate()
      : Math.max(1, (new Date(cur.reduce((a, t) => (t.date > a ? t.date : a), "0")) - new Date(cur.reduce((a, t) => (t.date < a ? t.date : a), "9"))) / 864e5 + 1);
    const recurring = findRecurring(all);
    const recurringTotal = sum(recurring, (r) => r.monthly);
    const installments = findInstallments(isMonth ? all.filter((t) => monthOf(t.date) <= ui.period) : all).filter((p) => p.left > 0);
    const cats = categoryTotals(cur);
    const prevCats = Object.fromEntries(categoryTotals(prevList).map((c) => [c.id, c.total]));

    // --- contextual insights ---
    const ins = [];
    if (isMonth && prevSpend) {
      const p = pctChange(spend, prevSpend);
      ins.push(["📈", `You spent <b>${money(Math.abs(spend - prevSpend), { whole: true })} ${spend > prevSpend ? "more" : "less"}</b> than ${monthLabel(prevMonth(ui.period), true)} (${changeHtml(p)}).`]);
      const deltas = cats.map((c) => ({ c, d: c.total - (prevCats[c.id] || 0) })).sort((a, b) => b.d - a.d);
      if (deltas[0] && deltas[0].d > 0) ins.push([deltas[0].c.cat.icon, `Biggest increase: <b>${esc(deltas[0].c.cat.name)}</b>, up ${money(deltas[0].d, { whole: true })} from last month.`]);
    } else if (!isMonth && months.length > 1) {
      ins.push(["📅", `Across ${months.length} months you spend about <b>${money(spend / months.length, { whole: true })}</b> a month.`]);
    }
    if (cats[0]) ins.push([cats[0].cat.icon, `<b>${esc(cats[0].cat.name)}</b> is your largest category: ${((cats[0].total / spend) * 100).toFixed(0)}% of spending (${cats[0].txs.length} transactions).`]);
    if (recurring.length) ins.push(["🔁", `<b>${recurring.length} recurring charges</b> add up to about ${money(recurringTotal, { whole: true })}/month — see the list below to spot ones you no longer use.`]);
    if (installments.length) ins.push(["🧾", `<b>${installments.length} installment plan${installments.length > 1 ? "s" : ""}</b> still running, with ${money(sum(installments, (p) => p.remaining), { whole: true })} left to pay.`]);
    const foreign = cur.filter((t) => t.origCurrency);
    if (foreign.length) ins.push(["🌍", `${foreign.length} purchase${foreign.length > 1 ? "s" : ""} in foreign currency (${[...new Set(foreign.map((t) => t.origCurrency))].join(", ")}) totalling ${money(sum(foreign), { whole: true })} — watch for conversion fees.`]);
    if (refunds > 0) ins.push(["↩️", `Refunds and credits gave back <b>${money(refunds, { whole: true })}</b>.`]);
    const uncategorized = cur.filter((t) => t.category === "other");
    if (uncategorized.length) ins.push(["🏷️", `${uncategorized.length} transaction${uncategorized.length > 1 ? "s are" : " is"} uncategorized (${money(sum(uncategorized), { whole: true })}). <button class="link" data-goto="other">Review them</button> — your choice is remembered for that merchant.`]);

    const largest = [...purchases].sort((a, b) => b.amount - a.amount).slice(0, 5);
    const merchants = [...groupBy(purchases, (t) => t.merchant)].map(([k, txs]) => ({ k, txs, total: sum(txs), name: txs[0].description, cat: BY_ID[txs[0].category] }))
      .sort((a, b) => b.total - a.total).slice(0, 6);

    $("#tab-overview").innerHTML = `
      <div class="grid kpis">
        <div class="card kpi"><div class="label">Spent · ${isMonth ? monthLabel(ui.period, true) : "all time"}</div>
          <div class="value num">${money(spend)}</div>
          <div class="sub muted">${isMonth && prevSpend ? changeHtml(pctChange(spend, prevSpend), " vs last month") : `${purchases.length} purchases`}</div></div>
        <div class="card kpi"><div class="label">Average per day</div>
          <div class="value num">${money(spend / days)}</div><div class="sub muted">over ${Math.round(days)} days</div></div>
        <div class="card kpi"><div class="label">Recurring / month</div>
          <div class="value num">${money(recurringTotal)}</div><div class="sub muted">${recurring.length} subscriptions &amp; bills</div></div>
        <div class="card kpi"><div class="label">Refunds &amp; credits</div>
          <div class="value num neg">${money(refunds)}</div><div class="sub muted">${cur.filter((t) => t.amount < 0 && !isExcluded(t)).length} credits</div></div>
      </div>

      <div class="grid two" style="margin-top:16px">
        <div class="card">
          <div class="section-head"><h2>What stands out</h2></div>
          <ul class="insights">${ins.map(([i, h]) => `<li><span class="ico">${i}</span><span>${h}</span></li>`).join("") || "<li>Nothing unusual.</li>"}</ul>
        </div>
        <div class="card">
          <div class="section-head"><h2>By category</h2><span class="muted small">click to drill in</span></div>
          <div class="bars">${cats.map((c) => `
            <div class="bar-row" data-cat="${c.id}">
              <div class="bar-label">${c.cat.icon} ${esc(c.cat.name)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, (c.total / cats[0].total) * 100)}%;background:${c.cat.color}"></div></div>
              <div class="num">${money(c.total, { whole: true })} <span class="muted small">${spend ? ((c.total / spend) * 100).toFixed(0) : 0}%</span></div>
            </div>`).join("")}</div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="section-head"><h2>Monthly trend</h2><span class="muted small">click a month to focus on it</span></div>
        ${monthChart(all, months)}
      </div>

      <div class="grid two" style="margin-top:16px">
        <div class="card">
          <div class="section-head"><h2>Recurring charges</h2><span class="muted small">seen in 2+ months at a steady amount</span></div>
          <div class="mini-list">${recurring.map((r) => `
            <div class="mini-row"><div><div dir="auto">${esc(r.name)}</div><div class="meta">${BY_ID[r.category].icon} ${esc(BY_ID[r.category].name)} · ${r.months} months · last ${fmtDate(r.last)}</div></div>
            <div class="num">${money(r.monthly)}<span class="muted small">/mo</span></div></div>`).join("") || `<p class="muted">None detected yet — import a few months of statements.</p>`}</div>
        </div>
        <div class="card">
          <div class="section-head"><h2>Installment plans</h2></div>
          <div class="mini-list">${installments.map((p) => `
            <div class="mini-row"><div><div dir="auto">${esc(p.t.description)}</div><div class="meta">Payment ${p.t.installment.n} of ${p.t.installment.of} · ${money(p.t.amount)} each</div></div>
            <div class="num">${money(p.remaining)}<div class="meta">${p.left} left</div></div></div>`).join("") || `<p class="muted">No active installment plans.</p>`}</div>
        </div>
      </div>

      <div class="grid two" style="margin-top:16px">
        <div class="card">
          <div class="section-head"><h2>Top merchants</h2></div>
          <div class="mini-list">${merchants.map((m) => `
            <div class="mini-row"><div><div dir="auto">${esc(m.name)}</div><div class="meta">${m.cat.icon} ${esc(m.cat.name)} · ${m.txs.length} visit${m.txs.length > 1 ? "s" : ""} · avg ${money(m.total / m.txs.length, { whole: true })}</div></div>
            <div class="num">${money(m.total)}</div></div>`).join("")}</div>
        </div>
        <div class="card">
          <div class="section-head"><h2>Largest purchases</h2></div>
          <div class="mini-list">${largest.map((t) => `
            <div class="mini-row"><div><div dir="auto">${esc(t.description)}</div><div class="meta">${fmtDate(t.date)} · ${BY_ID[t.category].icon} ${esc(BY_ID[t.category].name)}${t.installment ? ` · ${t.installment.n}/${t.installment.of}` : ""}</div></div>
            <div class="num">${money(t.amount)}</div></div>`).join("")}</div>
        </div>
      </div>`;
  }

  function monthChart(all, months) {
    if (!months.length) return "";
    const shown = months.slice(-12);
    const top = categoryTotals(all).slice(0, 6).map((c) => c.id);
    const cols = shown.map((m) => {
      const cats = categoryTotals(inPeriod(all, m));
      const segs = top.map((id) => ({ id, v: cats.find((c) => c.id === id)?.total || 0 }));
      const rest = sum(cats.filter((c) => !top.includes(c.id)), (c) => c.total);
      segs.push({ id: "_rest", v: rest });
      return { m, segs, total: sum(cats, (c) => c.total) };
    });
    const max = Math.max(...cols.map((c) => c.total), 1);
    return `<div class="month-chart">${cols.map((c) => `
      <div class="month-col ${c.m === ui.period ? "selected" : ""}" data-month="${c.m}" title="${monthLabel(c.m, true)}: ${money(c.total)}" style="cursor:pointer">
        <div class="amt num">${money(c.total, { whole: true })}</div>
        <div class="month-stack" style="height:${(Math.max(c.total, 0) / max) * 130}px">
          ${c.segs.filter((s) => s.v > 0).map((s) => `<div style="height:${(s.v / Math.max(c.total, 1)) * 100}%;background:${s.id === "_rest" ? "var(--border)" : BY_ID[s.id].color}" title="${s.id === "_rest" ? "Other categories" : esc(BY_ID[s.id].name)}: ${money(s.v)}"></div>`).join("")}
        </div>
        <div class="lbl">${monthLabel(c.m)}</div>
      </div>`).join("")}</div>
      <div class="muted small" style="margin-top:10px;display:flex;flex-wrap:wrap;gap:12px">${top.map((id) => `<span><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${BY_ID[id].color}"></span> ${esc(BY_ID[id].name)}</span>`).join("")}</div>`;
  }

  function renderCategories() {
    const all = scoped();
    const cur = inPeriod(all, ui.period);
    const isMonth = ui.period !== "all";
    const prevCats = isMonth ? Object.fromEntries(categoryTotals(inPeriod(all, prevMonth(ui.period))).map((c) => [c.id, c.total])) : {};
    const nMonths = new Set(all.map((t) => monthOf(t.date))).size || 1;
    const spend = spendOf(cur);
    const recurringKeys = new Map(findRecurring(all).map((r) => [r.merchant, r]));
    const excluded = cur.filter(isExcluded);

    const groups = categoryTotals(cur).map((c) => {
      const merchants = [...groupBy(c.txs, (t) => t.merchant)].map(([k, txs]) => ({ k, txs: txs.sort((a, b) => b.date.localeCompare(a.date)), total: sum(txs) }))
        .sort((a, b) => b.total - a.total);
      const open = ui.openCats.has(c.id);
      const ctx = [
        `${c.txs.length} transaction${c.txs.length > 1 ? "s" : ""}`,
        `${merchants.length} merchant${merchants.length > 1 ? "s" : ""}`,
        `avg ${money(c.total / c.txs.length, { whole: true })}`,
        isMonth ? (prevCats[c.id] ? changeHtml(pctChange(c.total, prevCats[c.id]), " vs last month") : "new this month")
          : `~${money(c.total / nMonths, { whole: true })}/month`,
      ];
      return `
        <div class="card cat-group ${open ? "open" : ""}" data-group="${c.id}">
          <div class="cat-head" data-toggle="${c.id}">
            ${catBadge(c.cat)}
            <div class="cat-title"><h3>${esc(c.cat.name)}</h3><div class="ctx">${ctx.join(" · ")}</div></div>
            <div class="cat-total"><div class="num" style="font-weight:600">${money(c.total)}</div><div class="muted small">${spend ? ((c.total / spend) * 100).toFixed(1) : 0}% of spending</div></div>
            <span class="chev">›</span>
          </div>
          ${open ? `<div class="cat-body">${merchants.map((m) => merchantBlock(m, recurringKeys)).join("")}</div>` : ""}
        </div>`;
    });

    $("#tab-categories").innerHTML = `
      <p class="muted" style="margin-top:0">Expenses grouped by category, then by merchant. Tags show recurring charges, installment plans, foreign-currency purchases and refunds.</p>
      ${groups.join("")}
      ${excluded.length ? `<p class="muted small">${excluded.length} card payment${excluded.length > 1 ? "s" : ""} (${money(sum(excluded))}) are excluded from spending totals.</p>` : ""}`;
  }

  function merchantBlock(m, recurringKeys) {
    const first = m.txs[0];
    const tags = [];
    const rec = recurringKeys.get(m.k);
    if (rec) tags.push(`<span class="tag">recurring · ${money(rec.monthly)}/mo</span>`);
    const inst = m.txs.find((t) => t.installment);
    if (inst) tags.push(`<span class="tag warn">installments ${inst.installment.n}/${inst.installment.of}</span>`);
    const foreign = [...new Set(m.txs.map((t) => t.origCurrency).filter(Boolean))];
    if (foreign.length) tags.push(`<span class="tag">${foreign.join(", ")}</span>`);
    if (m.txs.some((t) => t.amount < 0)) tags.push(`<span class="tag green">refund</span>`);
    return `
      <details class="merchant">
        <summary><span class="name" dir="auto">${esc(first.description)}</span>${tags.join("")}
          <span class="muted small">${m.txs.length}×</span><span class="num">${money(m.total)}</span></summary>
        <div class="table-wrap"><table><tbody>${m.txs.map((t) => `
          <tr><td class="num muted">${fmtDate(t.date)}</td>
          <td class="desc"><div class="d" dir="auto">${esc(t.description)}</div>${t.notes ? `<div class="muted small" dir="auto">${esc(t.notes)}</div>` : ""}</td>
          <td class="muted small">${t.origCurrency ? moneyIn(t.origAmount, t.origCurrency) : ""}</td>
          <td class="num ${t.amount < 0 ? "neg" : ""}" style="text-align:right">${money(t.amount)}</td></tr>`).join("")}</tbody></table></div>
      </details>`;
  }

  function categoryOptions(selected) {
    return CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${c.icon} ${esc(c.name)}</option>`).join("");
  }

  function renderTransactions() {
    let list = inPeriod(scoped(), ui.period);
    if (ui.catFilter !== "all") list = list.filter((t) => t.category === ui.catFilter);
    const q = ui.search.trim().toLowerCase();
    if (q) list = list.filter((t) => (t.description + " " + (t.notes || "") + " " + BY_ID[t.category].name).toLowerCase().includes(q));
    const { key, dir } = ui.sort;
    list = [...list].sort((a, b) => {
      const va = key === "category" ? BY_ID[a.category].name : a[key];
      const vb = key === "category" ? BY_ID[b.category].name : b[key];
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
    });
    const arrow = (k) => (ui.sort.key === k ? (ui.sort.dir > 0 ? " ↑" : " ↓") : "");
    const shown = list.slice(0, 1000);

    const panel = $("#tab-transactions");
    const hadFocus = document.activeElement?.id === "txSearch";
    panel.innerHTML = `
      <div class="toolbar">
        <input type="search" id="txSearch" placeholder="Search description, notes or category…" value="${esc(ui.search)}" />
        <select id="txCat"><option value="all">All categories</option>${categoryOptions(ui.catFilter)}</select>
        <button class="btn ghost" id="exportBtn" type="button">Export CSV</button>
      </div>
      <div class="card" style="padding:6px 12px">
        <div class="table-wrap"><table>
          <thead><tr>
            <th data-sort="date">Date${arrow("date")}</th><th data-sort="description">Description${arrow("description")}</th>
            <th>Card</th><th data-sort="category">Category${arrow("category")}</th>
            <th data-sort="amount" style="text-align:right">Amount${arrow("amount")}</th><th></th></tr></thead>
          <tbody>${shown.map((t) => `
            <tr data-id="${t.id}">
              <td class="num muted">${fmtDate(t.date)}</td>
              <td class="desc"><div class="d" dir="auto" title="${esc(t.description)}">${esc(t.description)}
                ${t.installment ? `<span class="tag warn">${t.installment.n}/${t.installment.of}</span>` : ""}
                ${t.origCurrency ? `<span class="tag">${moneyIn(t.origAmount, t.origCurrency)}</span>` : ""}</div>
                ${t.notes ? `<div class="muted small" dir="auto">${esc(t.notes)}</div>` : ""}</td>
              <td class="muted small">${t.card ? "•••• " + esc(t.card) : ""}</td>
              <td><select data-cat-for="${t.id}">${categoryOptions(t.category)}</select></td>
              <td class="num ${t.amount < 0 ? "neg" : ""}" style="text-align:right">${money(t.amount)}</td>
              <td><button class="icon-btn" data-del="${t.id}" title="Delete">×</button></td>
            </tr>`).join("")}</tbody>
        </table></div>
        <div class="muted small" style="padding:10px 4px">${list.length} transactions · total ${money(sum(list))}${list.length > shown.length ? ` · showing first ${shown.length}` : ""}</div>
      </div>`;
    if (hadFocus) { const s = $("#txSearch"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }

  function renderRules() {
    $("#tab-rules").innerHTML = `
      <div class="card">
        <h2>Your categorization rules</h2>
        <p class="muted">Rules override the built-in categories. Changing a transaction's category creates a rule for that merchant automatically.
          A rule matches the merchant name, or any description containing its text.</p>
        <form id="ruleForm" class="toolbar">
          <input type="text" name="pattern" placeholder="Text to match, e.g. shufersal or שופרסל" required style="flex:1;min-width:200px" />
          <select name="category">${categoryOptions("other")}</select>
          <button class="btn" type="submit">Add rule</button>
        </form>
        <div class="table-wrap"><table>
          <thead><tr><th>Matches</th><th>Category</th><th>Transactions</th><th></th></tr></thead>
          <tbody>${state.rules.map((r, i) => `
            <tr><td dir="auto">${esc(r.pattern)}</td><td>${BY_ID[r.category].icon} ${esc(BY_ID[r.category].name)}</td>
            <td class="num">${state.transactions.filter((t) => t.merchant === r.pattern || (r.pattern.length >= 3 && t.description.toLowerCase().includes(r.pattern))).length}</td>
            <td><button class="icon-btn" data-del-rule="${i}" title="Remove rule">×</button></td></tr>`).join("") ||
            `<tr><td colspan="4" class="muted">No custom rules yet.</td></tr>`}</tbody>
        </table></div>
      </div>`;
  }

  function renderImports() {
    $("#tab-imports").innerHTML = `
      <div class="card">
        <h2>Imported statements</h2>
        <p class="muted">Removing a statement deletes the transactions that came from it.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>File</th><th>Cards</th><th>Transactions</th><th>Date range</th><th>Imported</th><th></th></tr></thead>
          <tbody>${state.imports.map((imp, i) => {
            const txs = state.transactions.filter((t) => t.source === imp.source);
            const dates = txs.map((t) => t.date).sort();
            return `<tr><td dir="auto">${esc(imp.source)}</td><td class="muted">${(imp.cards || []).map((c) => "•••• " + esc(c)).join(", ")}</td>
              <td class="num">${txs.length}</td><td class="muted">${dates.length ? fmtDate(dates[0]) + " – " + fmtDate(dates[dates.length - 1]) : ""}</td>
              <td class="muted">${new Date(imp.importedAt).toLocaleString()}</td>
              <td><button class="btn danger sm" data-del-import="${i}">Remove</button></td></tr>`;
          }).join("")}</tbody>
        </table></div>
        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn danger" id="clearAll" type="button">Delete all data</button>
        </div>
      </div>`;
  }

  // ---------- events ----------

  function setCategory(id, category) {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    if (t.source === "manual") { t.manualCategory = category; applyCategory(t); save(); render(); return; }
    state.rules = state.rules.filter((r) => r.pattern !== t.merchant);
    state.rules.unshift({ pattern: t.merchant, category });
    recategorizeAll();
    save();
    const n = state.transactions.filter((x) => x.merchant === t.merchant).length;
    toast(`Saved: "${t.merchant}" → ${BY_ID[category].name}${n > 1 ? ` (${n} transactions updated)` : ""}`);
    render();
  }

  function exportCsv() {
    const rows = [["Date", "Description", "Category", "Amount", "Currency", "Original amount", "Original currency", "Installment", "Card", "Notes", "Source"]];
    for (const t of [...inPeriod(scoped(), ui.period)].sort((a, b) => a.date.localeCompare(b.date))) {
      rows.push([t.date, t.description, BY_ID[t.category].name, t.amount, state.currency, t.origAmount ?? "", t.origCurrency ?? "",
        t.installment ? `${t.installment.n}/${t.installment.of}` : "", t.card ?? "", t.notes ?? "", t.source]);
    }
    const csv = "﻿" + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `expenses-${ui.period}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function bind() {
    const dz = $("#dropzone"), input = $("#fileInput");
    $("#browseBtn").onclick = () => input.click();
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === dz) input.click(); });
    input.onchange = () => { if (input.files.length) importFiles([...input.files]); input.value = ""; };
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]); });

    $("#periodSelect").onchange = (e) => { ui.period = e.target.value; render(); };
    $("#cardSelect").onchange = (e) => { ui.card = e.target.value; render(); };
    $("#currencySelect").onchange = (e) => { state.currency = e.target.value; save(); render(); };
    document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; render(); }));
    $("#demoBtn").onclick = loadDemo;

    const dlg = $("#manualDialog"), form = $("#manualForm");
    $("#addManualBtn").onclick = () => {
      form.reset();
      form.category.innerHTML = categoryOptions("other");
      form.date.value = new Date().toISOString().slice(0, 10);
      dlg.showModal();
    };
    form.addEventListener("submit", (e) => {
      if (e.submitter?.value !== "save") return;
      const d = Object.fromEntries(new FormData(form));
      const t = { id: uid(), source: "manual", date: d.date, description: d.description.trim(), amount: Math.round(parseFloat(d.amount) * 100) / 100,
        manualCategory: d.category, card: null, notes: null, installment: null, origAmount: null, origCurrency: null };
      if (!t.description || !isFinite(t.amount)) return;
      if (!state.currency) state.currency = "USD";
      applyCategory(t);
      state.transactions.push(t);
      if (!state.imports.some((i) => i.source === "manual")) state.imports.push({ source: "manual", count: 0, cards: [], importedAt: new Date().toISOString() });
      save(); render(); toast("Expense added");
    });

    // delegated clicks/changes inside panels
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-cat],[data-toggle],[data-month],[data-del],[data-del-rule],[data-del-import],[data-sort],[data-goto],#exportBtn,#clearAll");
      if (!el) return;
      if (el.dataset.cat) { ui.tab = "categories"; ui.openCats.add(el.dataset.cat); render(); setTimeout(() => document.querySelector(`[data-group="${el.dataset.cat}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); }
      else if (el.dataset.toggle) { const id = el.dataset.toggle; ui.openCats.has(id) ? ui.openCats.delete(id) : ui.openCats.add(id); render(); }
      else if (el.dataset.month) { ui.period = ui.period === el.dataset.month ? "all" : el.dataset.month; render(); }
      else if (el.dataset.del) { state.transactions = state.transactions.filter((t) => t.id !== el.dataset.del); save(); render(); }
      else if (el.dataset.delRule) { state.rules.splice(+el.dataset.delRule, 1); recategorizeAll(); save(); render(); }
      else if (el.dataset.delImport) {
        const imp = state.imports[+el.dataset.delImport];
        if (!confirm(`Remove ${imp.source} and its transactions?`)) return;
        state.transactions = state.transactions.filter((t) => t.source !== imp.source);
        state.imports.splice(+el.dataset.delImport, 1); save(); render();
      }
      else if (el.dataset.sort) { const k = el.dataset.sort; ui.sort = { key: k, dir: ui.sort.key === k ? -ui.sort.dir : k === "date" || k === "amount" ? -1 : 1 }; render(); }
      else if (el.dataset.goto) { ui.tab = "transactions"; ui.catFilter = el.dataset.goto; render(); }
      else if (el.id === "exportBtn") exportCsv();
      else if (el.id === "clearAll") {
        if (!confirm("Delete all transactions, rules and imports from this browser?")) return;
        state = { transactions: [], rules: [], imports: [], currency: null }; save(); ui.period = "all"; render();
      }
    });
    document.addEventListener("change", (e) => {
      if (e.target.dataset.catFor) setCategory(e.target.dataset.catFor, e.target.value);
      else if (e.target.id === "txCat") { ui.catFilter = e.target.value; render(); }
    });
    document.addEventListener("input", (e) => { if (e.target.id === "txSearch") { ui.search = e.target.value; renderTransactions(); } });
    document.addEventListener("submit", (e) => {
      if (e.target.id !== "ruleForm") return;
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      const pattern = d.pattern.trim().toLowerCase();
      if (!pattern) return;
      state.rules = state.rules.filter((r) => r.pattern !== pattern);
      state.rules.unshift({ pattern, category: d.category });
      recategorizeAll(); save(); render();
      toast(`Rule added: "${pattern}" → ${BY_ID[d.category].name}`);
    });
  }

  // ---------- sample data ----------

  function loadDemo() {
    const now = new Date();
    const ym = (back) => { const d = new Date(now.getFullYear(), now.getMonth() - back, 1); return [d.getFullYear(), d.getMonth() + 1]; };
    const day = (back, d) => { const [y, m] = ym(back); return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; };
    const rows = [];
    const add = (back, d, description, amount, extra = {}) => rows.push({ date: day(back, d), description, amount, card: "4821", notes: null, installment: null, origAmount: null, origCurrency: null, hint: null, ...extra });
    for (const b of [3, 2, 1]) {
      add(b, 2, "NETFLIX.COM", 54.9); add(b, 3, "SPOTIFY", 23.9); add(b, 5, "בזק בינלאומי", 99);
      add(b, 8, "HOLMES PLACE", 289); add(b, 15, "חברת החשמל לישראל", 412 + b * 37);
      add(b, 4, "שופרסל דיל רמת גן", 386 + b * 21); add(b, 11, "רמי לוי שיווק השקמה", 512 - b * 30); add(b, 19, "שופרסל דיל רמת גן", 244 + b * 9);
      add(b, 6, "ארומה תל אביב", 34 + b * 4); add(b, 13, "WOLT", 96 + b * 12); add(b, 21, "מסעדת הסטקיה", 284 - b * 20);
      add(b, 9, "פז דלק", 310 + b * 15); add(b, 17, "פנגו חניה", 18 + b * 5); add(b, 23, "סופר פארם", 89 + b * 7);
      add(b, 14, "ICLOUD STORAGE APPLE.COM/BILL", 11.9);
      add(b, 10, "KSP מחשבים", 349, { notes: `תשלום ${4 - b} מתוך 6`, installment: { n: 4 - b, of: 6 } });
    }
    add(1, 18, "AMAZON MKTPLACE", 212.4, { origAmount: 57.3, origCurrency: "USD" });
    add(1, 20, "BOOKING.COM HOTEL", 1240, { origAmount: 311, origCurrency: "EUR" });
    add(2, 25, "ZARA עזריאלי", 418); add(2, 27, "ZARA עזריאלי", -139, { notes: "זיכוי" });
    add(3, 26, "סינמה סיטי", 96); add(1, 26, "CAFE GREG", 64); add(1, 28, "טמבור", 180); add(2, 12, "וטרינר רמת גן", 260);
    add(1, 29, "פיצה האט", 78); add(3, 22, "GOOGLE *YouTubePremium", 23.9);
    state.currency = state.currency || "ILS";
    addTransactions(rows, "sample-data");
    state.imports.push({ source: "sample-data", count: rows.length, cards: ["4821"], importedAt: new Date().toISOString() });
    save();
    ui.period = allMonths()[0];
    render();
  }

  load();
  if (state.transactions.length) ui.period = allMonths()[0] || "all";
  bind();
  render();
})();
