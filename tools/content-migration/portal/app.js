/* Content Migration review portal — vanilla JS, talks to the local CLI server. */

const $ = (sel, el = document) => el.querySelector(sel);
const state = { files: [], plan: [], assets: null, links: null, active: null, siteBaseUrl: "https://www.example.com" };

const STATUS_CLASS = { verified: "verified", failed: "failed", planned: "pending", mapped: "pending", migrated: "pending", skipped: "zero" };
/** A real, appliable update — skipped/failed produce no diff and never count as changes. */
const isEff = (c) => !!c.newUrl && c.status !== "failed" && c.status !== "skipped";

init();

async function init() {
  let config;
  [state.files, state.plan, state.reviews, config] = await Promise.all([
    fetch("/api/files").then((r) => r.json()),
    fetch("/api/plan").then((r) => r.json()),
    fetch("/api/reviews").then((r) => r.json()),
    fetch("/api/config").then((r) => r.json()),
  ]);
  state.siteBaseUrl = config.siteBaseUrl || state.siteBaseUrl;
  // high -> low everywhere: files by total changes, items within a file by changes
  for (const f of state.files) {
    f.totalChanges = f.items.reduce((n, i) => n + i.changes, 0);
    f.items.sort((a, b) => b.changes - a.changes);
  }
  state.files.sort((a, b) => b.totalChanges - a.totalChanges);
  renderSidebar();
  $("#nav-overview").onclick = () => { switchView("overview"); renderOverview(); };
  $("#nav-items").onclick = () => switchView("items");
  $("#nav-assets").onclick = () => { switchView("assets"); renderAssets(); };
  $("#nav-changes").onclick = () => { switchView("changes"); renderChanges(); };
  $("#nav-stats").onclick = () => { switchView("stats"); renderStats(); };
  $("#nav-issues").onclick = () => { switchView("issues"); renderIssues(); };
  $("#nav-redirects").onclick = () => { switchView("redirects"); renderRedirects(); };
  $("#nav-verify").onclick = () => { switchView("verify"); renderVerify(); };
  $("#nav-report").onclick = () => { switchView("report"); renderReport(); };
  $("#nav-log").onclick = () => { switchView("log"); renderLog(); };
  $("#export-btn").onclick = () => { switchView("export"); renderExport(); };
  renderOverview();
}

/* ---------- selective export ---------- */

async function renderExport() {
  const view = $("#export-view");
  const files = await fetch("/api/files").then((r) => r.json());
  for (const f of files) f.items.sort((a, b) => b.changes - a.changes);

  view.innerHTML = `<h2>Export Webflow CSVs</h2>
    <p class="muted">Exact copies of the exports with URLs replaced — reference and multi-reference fields pass through untouched
    (the equivalence report verifies every exported cell). By default only items with updates are selected, so the re-import
    touches nothing else.</p>
    <div class="filters">
      <button id="do-export">⬇ Export selected</button>
      <label class="muted"><input type="checkbox" id="exp-force" /> force (include unverified changes)</label>
      <span class="muted" id="exp-count"></span>
    </div>
    <div id="exp-result" hidden></div>
    <div id="exp-files"></div>`;

  const filesBox = $("#exp-files", view);
  const countEl = $("#exp-count", view);

  for (const f of files) {
    const card = document.createElement("div");
    card.className = "field-card";
    const changed = f.items.filter((i) => i.changes > 0).length;
    card.innerHTML = `
      <div class="field-head">
        <label><input type="checkbox" class="file-check" data-file="${esc(f.name)}" ${changed ? "checked" : ""}/>
          <span class="fname">${esc(f.name)}</span></label>
        <span class="muted">${f.rows} items, ${changed} with updates</span>
        <span class="tabs">
          <button data-sel="changed">only updated (${changed})</button>
          <button data-sel="all">all (${f.rows})</button>
          <button data-sel="none">none</button>
        </span>
      </div>
      <div class="export-items">
        ${f.items.map((it) => `<label class="export-item ${it.changes ? "" : "muted"}">
          <input type="checkbox" class="item-check" data-file="${esc(f.name)}" data-row="${it.row}" ${it.changes ? "checked" : ""}/>
          <span class="title">${esc(it.name)}</span>
          <span class="slug">${esc(it.slug)}</span>
          <span class="badge ${it.changes === 0 ? "zero" : it.statuses.includes("failed") ? "failed" : it.statuses.every((s) => s === "verified" || s === "skipped") ? "verified" : "pending"}">${it.changes}</span>
        </label>`).join("")}
      </div>`;
    filesBox.append(card);

    const itemChecks = [...card.querySelectorAll(".item-check")];
    const fileCheck = card.querySelector(".file-check");
    for (const b of card.querySelectorAll("[data-sel]")) {
      b.onclick = () => {
        const mode = b.dataset.sel;
        for (const c of itemChecks) {
          const changes = Number(c.closest(".export-item").querySelector(".badge").textContent);
          c.checked = mode === "all" ? true : mode === "none" ? false : changes > 0;
        }
        fileCheck.checked = itemChecks.some((c) => c.checked);
        updateCount();
      };
    }
    fileCheck.onchange = () => {
      for (const c of itemChecks) {
        const changes = Number(c.closest(".export-item").querySelector(".badge").textContent);
        c.checked = fileCheck.checked && changes > 0;
      }
      updateCount();
    };
    for (const c of itemChecks) c.onchange = () => { fileCheck.checked = itemChecks.some((x) => x.checked); updateCount(); };
  }

  function currentSelection() {
    const selection = {};
    for (const card of filesBox.children) {
      const file = card.querySelector(".file-check")?.dataset.file;
      const rows = [...card.querySelectorAll(".item-check")].filter((c) => c.checked).map((c) => Number(c.dataset.row));
      if (file && rows.length) {
        const total = card.querySelectorAll(".item-check").length;
        selection[file] = rows.length === total ? "all" : rows;
      }
    }
    return selection;
  }

  function updateCount() {
    const sel = currentSelection();
    const n = Object.values(sel).reduce((a, v) => a + (v === "all" ? 1e9 : v.length), 0);
    const files2 = Object.keys(sel).length;
    countEl.textContent = files2 ? `${files2} file(s), ${n >= 1e9 ? "all" : n} item(s) selected` : "nothing selected";
  }
  updateCount();

  $("#do-export", view).onclick = async () => {
    const btn = $("#do-export", view);
    const result = $("#exp-result", view);
    const selection = currentSelection();
    if (Object.keys(selection).length === 0) { result.hidden = false; result.innerHTML = `<div class="fail-box">Nothing selected.</div>`; return; }
    btn.disabled = true;
    btn.textContent = "Exporting…";
    try {
      let r = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: $("#exp-force", view).checked, selection }) }).then((x) => x.json());
      if (!r.ok && r.reason && confirm(`${r.reason}.\n\nForce export anyway? Only URLs with a new value are replaced; unverified ones stay as-is.`)) {
        r = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true, selection }) }).then((x) => x.json());
      }
      result.hidden = false;
      if (r.ok) {
        const bad = r.files.reduce((n, f) => n + f.unexpectedDiffs, 0);
        result.innerHTML = `<div class="${bad ? "fail-box" : "note"}" style="${bad ? "" : "background:#f0fdf4;border-color:#86efac;color:#14532d"}">
          <b>${bad ? "✕ Exported with unexpected diffs — do not import!" : "✓ Exported to workspace/output/ — equivalence PASS"}</b>
          <table class="changes" style="margin-top:8px"><thead><tr><th>File</th><th>Rows</th><th>Replaced</th><th>Cells changed</th><th>Old URLs left</th><th>Unexpected diffs</th></tr></thead>
          <tbody>${r.files.map((f) => `<tr><td>${esc(f.file)}</td><td>${f.rows}</td><td>${f.applied}</td><td>${f.cellsChanged}</td><td>${f.leftovers}</td><td>${f.unexpectedDiffs}</td></tr>`).join("")}</tbody></table>
          <div class="muted" style="margin-top:6px">Full certificate: workspace/output/equivalence-report.md</div></div>`;
      } else {
        result.innerHTML = `<div class="fail-box">✕ not exported: ${esc(r.reason ?? r.error ?? "unknown error")}</div>`;
      }
    } catch (e) {
      result.hidden = false;
      result.innerHTML = `<div class="fail-box">✕ export failed: ${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "⬇ Export selected";
    }
  };
}

function switchView(view) {
  for (const b of document.querySelectorAll("#topbar nav button")) b.classList.remove("active");
  $(`#nav-${view}`)?.classList.add("active");
  $("#overview-view").hidden = view !== "overview";
  $("#empty").hidden = view !== "items" || state.active !== null;
  $("#item-view").hidden = view !== "items" || state.active === null;
  $("#assets-view").hidden = view !== "assets";
  $("#changes-view").hidden = view !== "changes";
  $("#stats-view").hidden = view !== "stats";
  $("#issues-view").hidden = view !== "issues";
  $("#export-view").hidden = view !== "export";
  $("#redirects-view").hidden = view !== "redirects";
  $("#verify-view").hidden = view !== "verify";
  $("#report-view").hidden = view !== "report";
  $("#log-view").hidden = view !== "log";
}

/* ---------- sidebar ---------- */

function renderSidebar() {
  const tree = $("#file-tree");
  tree.innerHTML = "";
  if (state.files.length === 0) {
    tree.innerHTML = `<div class="item-row muted">No CSVs ingested yet.<br/>Drop files in workspace/inbox and run <code>pnpm ingest</code>.</div>`;
    return;
  }
  for (const file of state.files) {
    const group = document.createElement("div");
    group.className = "file-group";
    const head = document.createElement("div");
    head.className = "file-name";
    const label = `${file.name} — ${file.totalChanges} changes`;
    head.textContent = `▾ ${label}`;
    let open = true;
    const list = document.createElement("div");
    head.onclick = () => { open = !open; list.hidden = !open; head.textContent = `${open ? "▾" : "▸"} ${label}`; };
    group.append(head, list);
    for (const item of file.items) {
      const row = document.createElement("div");
      row.className = "item-row";
      const reviewed = state.reviews?.[`${file.name}#${item.row}`]?.reviewed;
      row.innerHTML = `<span class="title">${reviewed ? `<span class="reviewed-tick" title="marked reviewed">✔</span> ` : ""}${esc(item.name)}<br/><span class="slug">${esc(item.slug)}</span></span>
        ${triPill(item)}`;
      row.onclick = () => openItem(file.name, item.row, row);
      list.append(row);
    }
    tree.append(group);
  }
}

/**
 * Tri-color status pill: green = URLs updated, amber = skipped (tracked, no
 * diff), red = has an issue needing a human. All-good items show one green
 * segment; a red segment anywhere means "look at me".
 */
function triPill(item) {
  const segs = [];
  if (item.changes) segs.push(`<span class="seg seg-ok" title="${item.changes} URL(s) updated">${item.changes}✓</span>`);
  if (item.skipped) segs.push(`<span class="seg seg-skip" title="${item.skipped} skipped (video/oversize) — no diff, tracked">${item.skipped}⊘</span>`);
  if (item.failed) segs.push(`<span class="seg seg-bad" title="${item.failed} failing URL(s) — needs a human">${item.failed}✕</span>`);
  if (!segs.length) segs.push(`<span class="seg seg-none" title="no matched URLs">0</span>`);
  return `<span class="tri">${segs.join("")}</span>`;
}

async function openItem(file, rowIndex, rowEl) {
  for (const el of document.querySelectorAll(".item-row.active")) el.classList.remove("active");
  rowEl.classList.add("active");
  state.active = { file, row: rowIndex };
  switchView("items");
  const detail = await fetch(`/api/item?file=${encodeURIComponent(file)}&row=${rowIndex}`).then((r) => r.json());
  renderItem(detail);
}

/* ---------- item view (CMS-style) ---------- */

function renderItem(detail) {
  const view = $("#item-view");
  view.hidden = false;
  $("#empty").hidden = true;
  const allChanges = detail.fields.flatMap((f) => f.changes.map((c) => ({ ...c, _field: f.field })));
  const updates = allChanges.filter(isEff).length;
  const pending = allChanges.filter((c) => !c.newUrl && c.status !== "failed" && c.status !== "skipped").length;
  const failing = allChanges.filter((c) => c.status === "failed");
  const skippedC = allChanges.filter((c) => c.status === "skipped");
  const rkey = `${detail.file}#${detail.row}`;
  const isReviewed = state.reviews?.[rkey]?.reviewed;
  view.innerHTML = `<div class="item-header">
    <div class="item-title-row">
      <h2>${esc(detail.name)}</h2>
      <button id="review-toggle" class="${isReviewed ? "reviewed" : ""}">${isReviewed ? "✔ Reviewed — click to undo" : "Mark as reviewed ✔"}</button>
    </div>
    <div class="slug">${esc(detail.file)} · row ${detail.row}${detail.slug ? " · /" + esc(detail.slug) : ""} ·
      ${updates} real update${updates === 1 ? "" : "s"}${skippedC.length ? ` · ${skippedC.length} skipped` : ""}${failing.length ? ` · ${failing.length} failing` : ""}</div>
    ${updates === 0 && allChanges.length > 0 ? `<div class="note">No real changes in this item — nothing to re-import. The URLs below are tracked leftovers (HubSpot content still to be moved later).</div>` : ""}
    ${failing.length ? `<div class="fail-box"><b>✕ ${failing.length} failing URL(s) in this item:</b>
      ${failing.slice(0, 12).map((c) => `<div class="fail-line"><span class="fail-field">${esc(c._field)}</span> ${esc(c.oldUrl)}<br/><span class="muted">${esc(c.error ?? "migration failed")}</span></div>`).join("")}
      ${failing.length > 12 ? `<div class="muted">…and ${failing.length - 12} more</div>` : ""}
    </div>` : ""}
    ${skippedC.length ? `<div class="note">⊘ ${skippedC.length} URL(s) intentionally skipped (videos / oversize) — left unchanged in export.</div>` : ""}
    ${pending ? `<div class="note">⚠ ${pending} URL(s) pending migrate — the After/Diff views become the real final diff once assets are uploaded to Webflow.</div>` : ""}
  </div>`;

  // fields with the most changes first
  const fields = [...detail.fields].sort((a, b) => b.changes.length - a.changes.length);
  for (const f of fields) {
    if (!f.before && f.changes.length === 0) continue; // hide empty untouched fields
    view.append(fieldCard(f));
  }

  $("#review-toggle", view).onclick = async () => {
    const next = !state.reviews?.[rkey]?.reviewed;
    await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: detail.file, row: detail.row, reviewed: next }) });
    state.reviews[rkey] = { reviewed: next, at: new Date().toISOString() };
    renderSidebar();
    renderItem(detail);
  };
}

function fieldCard(f) {
  const card = document.createElement("div");
  card.className = "field-card" + (f.changes.length ? " changed" : "");
  const head = document.createElement("div");
  head.className = "field-head";
  const effCount = f.changes.filter(isEff).length;
  const trackedCount = f.changes.length - effCount;
  head.innerHTML = `<span class="fname">${esc(f.field)}</span>` +
    (effCount ? `<span class="badge ${aggBadge(f.changes)}">${effCount} update${effCount > 1 ? "s" : ""}</span>` : "") +
    (trackedCount ? `<span class="badge zero" title="skipped/failed — no diff">${trackedCount} tracked, no diff</span>` : "");
  card.append(head);

  const body = document.createElement("div");
  body.className = "field-body";
  card.append(body);

  const isHtml = /<[a-z][\s\S]*>/i.test(f.before) || /<[a-z][\s\S]*>/i.test(f.after);
  const pending = f.changes.filter((c) => !c.newUrl && c.status !== "skipped" && c.status !== "failed").length;

  if (f.changes.length === 0) {
    body.innerHTML = isHtml ? `<div class="rendered">${f.before}</div>` : `<div class="plain">${esc(f.before)}</div>`;
    if (isHtml) markImages(body);
    return card;
  }

  // changed field: Split / Before / After / Diff / Raw tabs
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  head.append(tabs);
  const render = (mode) => {
    for (const b of tabs.children) b.classList.toggle("active", b.dataset.mode === mode);
    const pendingNote = pending && mode !== "before" && mode !== "raw"
      ? `<div class="note">⚠ ${pending} URL(s) here have no Webflow URL yet (pending migrate) — shown unchanged.</div>` : "";
    if (mode === "split") {
      const pane = (content, side, label) => `<div class="split-pane">
        <div class="split-head ${side === "old" ? "sh-old" : "sh-new"}">${label}</div>
        ${isHtml ? `<div class="rendered">${content}</div>` : `<div class="plain">${highlightUrls(content, f.changes, side === "old" ? "before" : "after")}</div>`}
      </div>`;
      body.innerHTML = pendingNote + `<div class="split">${pane(f.before, "old", "Previous content")}${pane(f.after, "new", "Updated content")}</div>`;
      if (isHtml) {
        const [beforePane, afterPane] = body.querySelectorAll(".split-pane .rendered");
        highlightChangedElements(beforePane, f.changes, "old");
        highlightChangedElements(afterPane, f.changes, "new");
        markImages(body);
      }
    } else if (mode === "diff") {
      body.innerHTML = pendingNote + `<div class="diff">${diffHtml(f.before, f.after)}</div>`;
    } else if (mode === "raw") {
      body.innerHTML = `<div class="plain">${highlightUrls(f.before, f.changes, "before")}</div>`;
    } else {
      const content = mode === "before" ? f.before : f.after;
      body.innerHTML = pendingNote + (isHtml
        ? `<div class="rendered">${content}</div>`
        : `<div class="plain">${highlightUrls(content, f.changes, mode)}</div>`);
      if (isHtml) markImages(body);
    }
  };
  for (const mode of ["split", "before", "after", "diff", "raw"]) {
    const b = document.createElement("button");
    b.dataset.mode = mode;
    b.textContent = mode === "raw" ? "Raw" : mode === "split" ? "Side by side" : mode[0].toUpperCase() + mode.slice(1);
    b.onclick = () => render(mode);
    tabs.append(b);
  }

  // per-change URL list with live image probes + verify status
  const list = document.createElement("ul");
  list.className = "change-list";
  for (const c of f.changes) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="badge ${STATUS_CLASS[c.status] ?? "pending"}">${c.status}</span>
      <span>${esc(c.oldUrl)}</span><span class="arrow">→</span>
      <span>${c.newUrl ? esc(c.newUrl) : "<i>(pending migrate)</i>"}</span>`;
    if (c.newUrl) li.append(probeBadge(c));
    if (c.verify && !c.verify.ok) li.append(chip("bad", `verify: ${c.verify.error || "HTTP " + c.verify.status}`));
    else if (c.verify && c.verify.ok) li.append(chip("ok", `verified ${c.verify.status} ${c.verify.contentType}`));
    if (c.error) li.append(chip(c.status === "skipped" ? "wait" : "bad", c.error));
    list.append(li);
  }
  card.append(list);

  render("split");
  return card;
}

/** Outline the elements whose URL is being changed: yellow = old URL, green = new URL. */
function highlightChangedElements(container, changes, side) {
  if (!container) return;
  const decode = (s) => s.replaceAll("&amp;", "&");
  // per-URL class: red = failing, amber = intentionally skipped, yellow/green = normal change
  const classFor = (c) => (c.status === "failed" ? "hl-bad" : c.status === "skipped" ? "hl-skip" : side === "old" ? "hl-old" : "hl-new");
  const targets = changes
    .map((c) => ({ url: side === "old" ? c.oldUrl : (c.newUrl ?? c.oldUrl), cls: classFor(c) }))
    .filter((t) => t.url)
    .map((t) => ({ ...t, url: decode(t.url) }));
  for (const el of container.querySelectorAll("img, a, source, video, iframe")) {
    for (const attr of ["src", "href", "srcset"]) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      const hit = targets.find((t) => decode(v).includes(t.url));
      if (hit) {
        el.classList.add(hit.cls);
        if (hit.cls === "hl-bad") el.title = "FAILING URL: " + hit.url;
        break;
      }
    }
  }
}

function aggBadge(changes) {
  if (changes.some((c) => c.status === "failed")) return "failed";
  if (changes.every((c) => c.status === "verified")) return "verified";
  return "pending";
}

function chip(cls, text) {
  const s = document.createElement("span");
  s.className = `imgcheck ${cls}`;
  s.textContent = (cls === "ok" ? "● " : cls === "bad" ? "✕ " : "… ") + text;
  return s;
}

/** Live render guardrail: probe the new URL with an actual <img> element. */
function probeBadge(change) {
  // only real images can be probed with an <img> — PDFs/docs would always "error"
  const looksImage = /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(change.newUrl);
  if (!looksImage) return chip("ok", "link");
  const badge = chip("wait", "loading…");
  const img = new Image();
  img.onload = () => badge.replaceWith(chip("ok", "renders"));
  img.onerror = () => badge.replaceWith(chip("bad", "broken"));
  img.src = absolutize(change.newUrl);
  return badge;
}

/** Explicit broken-URL callouts inside a rendered HTML body. */
function markImages(container) {
  for (const img of container.querySelectorAll("img")) {
    img.addEventListener("error", () => {
      img.style.outline = "3px solid #dc2626";
      img.title = "BROKEN: " + img.src;
      const note = document.createElement("div");
      note.className = "broken-note";
      note.textContent = `⚠ Broken image URL: ${img.getAttribute("src")}`;
      img.insertAdjacentElement("afterend", note);
    });
    if (img.getAttribute("src")?.startsWith("/")) img.src = absolutize(img.getAttribute("src"));
  }
}

function absolutize(url) {
  return url.startsWith("/") ? state.siteBaseUrl + url : url;
}

function highlightUrls(text, changes, mode) {
  let out = esc(text);
  for (const c of changes) {
    if (mode === "before") out = out.split(esc(c.oldUrl)).join(`<span class="url-hit">${esc(c.oldUrl)}</span>`);
    else if (c.newUrl) out = out.split(esc(c.newUrl)).join(`<span class="url-new">${esc(c.newUrl)}</span>`);
  }
  return out;
}

/* ---------- asset inventory ---------- */

function fmtSize(n) {
  if (n == null) return "—";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

function extLink(url, label) {
  return `<a class="urllink" href="${esc(absolutize(url))}" target="_blank" rel="noopener">${esc(label ?? url)} ↗</a>`;
}

/** The three per-asset pipeline steps, each with a green check when done. */
function stepBadges(x) {
  const steps = [
    { label: "1 downloaded", done: x.downloaded },
    { label: "2 uploaded", done: !!x.newUrl },
    { label: "3 replaced", done: x.statuses.length > 0 && x.statuses.every((s) => s === "verified") },
  ];
  return steps.map((s) =>
    `<span class="step ${s.done ? "step-done" : "step-todo"}">${s.done ? "✓" : "○"} ${s.label}</span>`
  ).join("");
}

function cfStatus(o) {
  if (!o) return `<span class="muted">unchecked</span>`;
  const ok = o.ok ?? (o.status >= 200 && o.status < 300);
  if (ok && o.redirected) return `<span class="imgcheck ok">✓ Cloudflare redirect working (${o.status})</span>`;
  if (ok) return `<span class="imgcheck ok">✓ 200 direct — no redirect needed</span>`;
  if (o.redirected) return `<span class="imgcheck bad">✕ redirects to a broken target (${o.status})</span>`;
  return `<span class="imgcheck bad">✕ broken today (${o.status || esc(o.error || "error")})</span>`;
}

function sourceStatus(x) {
  const s = x.check?.source;
  if (!s) return `<span class="muted">unchecked</span>`;
  if (s.ok) return `<span class="imgcheck ok">✓ ${s.status} ${esc(s.contentType)}</span>`;
  return `<span class="imgcheck bad">✕ ${esc(s.error || "HTTP " + s.status)}</span>`;
}

/** Two-sided verdict for a rewritten link: old URL before, new URL after. */
function linkVerdict(c) {
  if (!c) return { cls: "muted", text: "unchecked" };
  const o = !!c.old?.ok, n = !!c.new?.ok;
  if (o && n) return { cls: "ok", text: `✓ both resolve (old ${c.old.status}, new ${c.new.status})` };
  if (!o && n) return { cls: "wait", text: `⚠ broken before rewrite (${c.old?.status || c.old?.error}) — rewrite fixes it (new ${c.new.status})` };
  if (o && !n) return { cls: "bad", text: `✕ BREAKS after rewrite (old ${c.old.status} OK, new ${c.new?.status || c.new?.error})` };
  return { cls: "bad", text: `✕ broken before AND after (old ${c.old?.status || c.old?.error}, new ${c.new?.status || c.new?.error})` };
}

async function renderAssets(refetch = false) {
  const view = $("#assets-view");
  if (!state.assets || !state.rules || refetch) {
    [state.assets, state.links, state.rules] = await Promise.all([
      fetch("/api/assets").then((r) => r.json()),
      fetch("/api/links").then((r) => r.json()),
      fetch("/api/rules").then((r) => r.json()),
    ]);
  }
  const a = state.assets;
  const checked = a.filter((x) => x.check);
  const sourceFail = a.filter((x) => x.check?.source && !x.check.source.ok);
  const cfBroken = a.filter((x) => x.check?.old && !(x.check.old.ok ?? (x.check.old.status >= 200 && x.check.old.status < 300)));
  const uploaded = a.filter((x) => x.newUrl);
  const tooLarge = a.filter((x) => (x.check?.source?.contentLength ?? 0) > 4 * 1048576);
  const types = {};
  for (const x of a) types[x.type] = (types[x.type] ?? 0) + 1;

  // per-rule impact + health, computed from the plan and the asset checks
  const ruleStats = state.rules.map((r) => {
    const entries = state.plan.filter((e) => e.ruleId === r.id);
    const ruleAssets = a.filter((x) => x.ruleIds?.includes(r.id));
    const failing = ruleAssets.filter((x) => x.check?.source && !x.check.source.ok);
    const okCount = ruleAssets.filter((x) => x.check?.source?.ok).length;
    return { rule: r, changes: entries.length, items: new Set(entries.map((e) => e.file + "#" + e.row)).size, assets: ruleAssets.length, ok: okCount, failing };
  });

  view.innerHTML = `<h2>Assets to migrate — ${a.length} unique</h2>

    <details class="rules-panel" open>
      <summary>Rules applied across the site (${state.rules.length}) — first match wins, edit in rules.json</summary>
      <div class="rule-grid">
      ${ruleStats.map(({ rule: r, changes, items, assets, ok, failing }, i) => `<div class="rule-card ${failing.length ? "rule-bad" : ""}">
        <div class="rule-title">
          <span class="badge ${r.action === "rehost" ? "pending" : "verified"}">${r.action}</span>
          <b>${i + 1}. ${esc(r.id)}</b>
          <span class="origin ${r.origin === "cloudflare" ? "origin-cf" : "origin-added"}">${r.origin === "cloudflare" ? "your Cloudflare rule" : "added during planning"}</span>
        </div>
        <div class="rule-desc">${esc(r.description ?? "")}</div>
        ${r.reasoning ? `<div class="rule-why"><b>Why:</b> ${esc(r.reasoning)}</div>` : ""}
        <div class="rule-tech"><code>${esc(r.match)}</code> → <code>${esc(r.sourceUrl ?? ((r.host || "(relative)") + (r.target ?? "")))}</code></div>
        <div class="rule-impact">
          <span class="chip">${changes} URL match${changes === 1 ? "" : "es"}</span>
          <span class="chip">${items} item${items === 1 ? "" : "s"}</span>
          ${r.action === "rehost" ? `<span class="chip">${assets} asset${assets === 1 ? "" : "s"}</span>
            <span class="chip ${failing.length ? "chip-bad" : "chip-ok"}">${failing.length ? failing.length + " broken" : ok ? "all " + ok + " checked OK" : "unchecked"}</span>
            <button class="minibtn" data-rule-filter="${esc(r.id)}">show assets</button>`
          : (() => {
              const links = (state.links ?? []).filter((l) => l.ruleIds.includes(r.id));
              const checked = links.filter((l) => l.check);
              const afterBroken = checked.filter((l) => !l.check.new?.ok);
              const fixed = checked.filter((l) => !l.check.old?.ok && l.check.new?.ok);
              return `<span class="chip">${links.length} link${links.length === 1 ? "" : "s"}</span>
                <span class="chip ${afterBroken.length ? "chip-bad" : checked.length ? "chip-ok" : ""}">${!checked.length ? "unchecked" : afterBroken.length ? afterBroken.length + " broken after rewrite" : "all " + checked.length + " resolve 200 after rewrite"}</span>
                ${fixed.length ? `<span class="chip chip-warn">${fixed.length} broken before — fixed by rewrite</span>` : ""}
                <button class="minibtn" data-rule-changes="${esc(r.id)}">show changes</button>`;
            })()}
        </div>
      </div>`).join("")}
      </div>
    </details>

    <div class="summary">
      ${Object.entries(types).sort((p, q) => q[1] - p[1]).map(([t, n]) => `<span class="chip">${esc(t)}: ${n}</span>`).join("")}
      <span class="chip ${sourceFail.length ? "chip-bad" : "chip-ok"}">source failing: ${sourceFail.length}</span>
      <span class="chip ${cfBroken.length ? "chip-bad" : "chip-ok"}">cloudflare broken: ${cfBroken.length}</span>
      <span class="chip ${uploaded.length === a.length ? "chip-ok" : "chip-warn"}">uploaded: ${uploaded.length}/${a.length}</span>
      <span class="chip ${tooLarge.length ? "chip-warn" : "chip-ok"}">over 4 MB: ${tooLarge.length}</span>
      <span class="chip">checked: ${checked.length}/${a.length}</span>
    </div>
    <div class="migrate-bar">
      <button id="run-migrate">▶ Run migration (download → upload, videos skipped)</button>
      <div id="migrate-progress" class="muted"></div>
    </div>
    <div class="filters">
      <button id="run-checks">Re-run URL checks (HEAD only, ~2 min)</button>
      <select id="a-type"><option value="">all types</option>${Object.keys(types).map((t) => `<option>${esc(t)}</option>`).join("")}</select>
      <select id="a-status"><option value="">all statuses</option><option value="fail">source failing</option><option value="cf-broken">cloudflare broken</option><option value="unchecked">unchecked</option><option value="uploaded">uploaded</option><option value="pending">pending upload</option></select>
      <select id="a-rule"><option value="">all rules</option>${state.rules.filter((r) => r.action === "rehost").map((r) => `<option>${esc(r.id)}</option>`).join("")}</select>
      <select id="a-sort">
        <option value="priority">sort: problems first</option>
        <option value="refs">sort: most referenced</option>
        <option value="size">sort: largest first</option>
        <option value="type">sort: type</option>
        <option value="name">sort: file name</option>
      </select>
      <input id="a-search" placeholder="search URL…" />
      <span class="muted" id="a-count"></span>
    </div>
    <div id="asset-list"></div>`;

  const list = $("#asset-list", view);
  const apply = () => {
    const ft = $("#a-type", view).value, fs = $("#a-status", view).value, fr = $("#a-rule", view).value,
      sort = $("#a-sort", view).value, q = $("#a-search", view).value.toLowerCase();
    const fname = (x) => decodeURIComponent((x.sourceUrl.split("?")[0].split("/").pop() || x.sourceUrl));
    const size = (x) => x.check?.source?.contentLength ?? -1;
    const rank = (x) => (x.check?.source && !x.check.source.ok ? 0 : !x.check ? 1 : 2);
    const sorters = {
      priority: (p, q2) => rank(p) - rank(q2) || q2.refs - p.refs,
      refs: (p, q2) => q2.refs - p.refs,
      size: (p, q2) => size(q2) - size(p),
      type: (p, q2) => p.type.localeCompare(q2.type) || q2.refs - p.refs,
      name: (p, q2) => fname(p).localeCompare(fname(q2)),
    };
    const rows = a
      .filter((x) => (!ft || x.type === ft) && (!fr || x.ruleIds?.includes(fr)) && (!q || x.sourceUrl.toLowerCase().includes(q) || x.oldUrl.toLowerCase().includes(q)))
      .filter((x) => !fs
        || (fs === "fail" && x.check?.source && !x.check.source.ok)
        || (fs === "cf-broken" && x.check?.old && !(x.check.old.ok ?? (x.check.old.status >= 200 && x.check.old.status < 300)))
        || (fs === "unchecked" && !x.check)
        || (fs === "uploaded" && x.newUrl)
        || (fs === "pending" && !x.newUrl))
      .sort(sorters[sort] ?? sorters.priority);
    $("#a-count", view).textContent = `${rows.length} of ${a.length}`;
    list.innerHTML = rows.map((x) => {
      const s = x.check?.source;
      const big = (s?.contentLength ?? 0) > 4 * 1048576;
      return `<div class="asset-card" data-src="${esc(x.sourceUrl)}">
        <div class="ac-main">
          <div class="ac-head">
            <span class="typetag t-${esc(x.type.replace(/[^a-z]/g, ""))}">${esc(x.type)}</span>
            <span class="ac-name" title="${esc(x.sourceUrl)}">${esc(fname(x))}</span>
            <span class="ac-meta">${x.refs} ref${x.refs > 1 ? "s" : ""}${s ? " · " + fmtSize(s.contentLength) : ""}${big ? " · <b class='warn-text'>over 4 MB</b>" : ""}</span>
          </div>
          <div class="u"><span class="ulabel">in content</span>${extLink(x.oldUrl)}</div>
          <div class="u"><span class="ulabel">resolves via</span>${extLink(x.sourceUrl)}</div>
          <div class="u"><span class="ulabel">webflow</span>${x.newUrl ? extLink(x.newUrl) : `<span class="muted">not uploaded yet</span>`}</div>
        </div>
        <div class="ac-side">
          <div>${sourceStatus(x)}</div>
          <div>${cfStatus(x.check?.old)}</div>
          ${x.migrateError ? (x.migrateError.phase === "skipped"
            ? `<div class="imgcheck wait" title="${esc(x.migrateError.message)}">⊘ skipped: ${esc(x.migrateError.code ?? "")}</div>`
            : `<div class="imgcheck bad" title="${esc(x.migrateError.message)}">✕ ${esc(x.migrateError.phase)} failed: ${x.migrateError.status ?? ""} ${esc(x.migrateError.code ?? x.migrateError.message.slice(0, 40))}</div>`) : ""}
          <div class="steps">${stepBadges(x)}</div>
        </div>
      </div>`;
    }).join("");
    for (const card of list.querySelectorAll(".asset-card")) {
      card.onclick = (ev) => {
        if (ev.target.closest("a")) return; // let URL links open in a new tab
        openAssetDetail(card.dataset.src);
      };
    }
  };
  for (const id of ["a-type", "a-status", "a-rule", "a-sort"]) $("#" + id, view).onchange = apply;
  $("#a-search", view).oninput = apply;
  for (const btn of view.querySelectorAll("[data-rule-filter]")) {
    btn.onclick = () => {
      $("#a-rule", view).value = btn.dataset.ruleFilter;
      apply();
      $("#asset-list", view).scrollIntoView({ behavior: "smooth" });
    };
  }
  for (const btn of view.querySelectorAll("[data-rule-changes]")) {
    btn.onclick = () => {
      switchView("changes");
      renderChanges(btn.dataset.ruleChanges);
    };
  }
  wireMigrateButton(view, apply);
  $("#run-checks", view).onclick = async () => {
    const btn = $("#run-checks", view);
    btn.disabled = true;
    btn.textContent = "Checking… (watch the terminal for progress)";
    try {
      await fetch("/api/assets/check", { method: "POST" });
      await renderAssets(true);
    } catch (e) {
      btn.textContent = "Check failed: " + e.message;
      btn.disabled = false;
    }
  };
  apply();
}

/* ---------- migration runner (Run button + live status) ---------- */

let migratePoller = null;

function wireMigrateButton(view) {
  const btn = $("#run-migrate", view);
  const bar = $("#migrate-progress", view);

  const paint = (p) => {
    if (p.phase === "idle") { bar.textContent = ""; return; }
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const label = p.phase === "download" ? "Phase 1/2 downloading" : p.phase === "upload" ? "Phase 2/2 uploading" : "Finished";
    bar.innerHTML = p.running
      ? `<b>${label}</b> — ${p.done}/${p.total} (${pct}%) · ${p.ok} ok · ${p.fail} failed · ${p.skipped} skipped`
      : `<b>Finished:</b> ${esc(p.lastMessage)} — refreshing…`;
    btn.disabled = p.running;
    btn.textContent = p.running ? "⏳ Migration running…" : "▶ Run migration (download → upload, videos skipped)";
  };

  const poll = async () => {
    const p = await fetch("/api/migrate/status").then((r) => r.json()).catch(() => null);
    if (!p) return;
    paint(p);
    if (!p.running && migratePoller) {
      clearInterval(migratePoller);
      migratePoller = null;
      // full refresh: plan + files feed the sidebar, Changes table, and rule stats
      [state.files, state.plan] = await Promise.all([
        fetch("/api/files").then((r) => r.json()),
        fetch("/api/plan").then((r) => r.json()),
      ]);
      for (const f of state.files) {
        f.totalChanges = f.items.reduce((n, i) => n + i.changes, 0);
        f.items.sort((a, b) => b.changes - a.changes);
      }
      state.files.sort((a, b) => b.totalChanges - a.totalChanges);
      renderSidebar();
      await renderAssets(true); // final refresh with all statuses
    }
  };

  btn.onclick = async () => {
    btn.disabled = true;
    const r = await fetch("/api/migrate", { method: "POST" }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) { bar.textContent = "✕ " + r.error; btn.disabled = false; return; }
    if (!migratePoller) migratePoller = setInterval(poll, 2500);
  };

  // if a run is already in flight when the view opens, resume polling
  fetch("/api/migrate/status").then((r) => r.json()).then((p) => {
    if (p.running) {
      paint(p);
      if (!migratePoller) migratePoller = setInterval(poll, 2500);
    }
  }).catch(() => {});
}

/* ---------- asset detail with preview ---------- */

function preview(url, type, title) {
  const abs = absolutize(url);
  if (type === "image") return `<img class="preview-img" src="${esc(abs)}" alt="${esc(title)}"
    onerror="this.outerHTML='<div class=broken-note>⚠ Does not load: ${esc(abs)}</div>'" />`;
  if (type === "pdf") return `<iframe class="preview-pdf" src="${esc(abs)}"></iframe>`;
  if (type === "video") return `<video class="preview-video" src="${esc(abs)}" controls preload="metadata"></video>`;
  return `<div class="muted">No inline preview for this type — ${extLink(url, "open in a new tab")}</div>`;
}

async function openAssetDetail(sourceUrl) {
  const x = await fetch(`/api/asset?src=${encodeURIComponent(sourceUrl)}`).then((r) => r.json());
  const view = $("#assets-view");
  const s = x.check?.source;
  view.innerHTML = `<button class="backlink" id="back-assets">← All assets</button>
    <h2>${esc(decodeURIComponent(x.sourceUrl.split("/").pop() || x.sourceUrl))}</h2>
    <div class="summary">
      <span class="chip">${esc(x.type)}</span>
      <span class="chip">${x.refs} reference${x.refs > 1 ? "s" : ""} in ${x.items} item${x.items > 1 ? "s" : ""}</span>
      ${s ? `<span class="chip">${fmtSize(s.contentLength)}</span>` : ""}
    </div>
    <div class="detail-grid">
      <div class="field-card">
        <div class="field-head"><span class="fname">Status</span></div>
        <div class="field-body">
          <div class="statusline">${stepBadges(x)}</div>
          <table class="kv">
            <tr><th>In content</th><td>${extLink(x.oldUrl)}</td></tr>
            <tr><th>Resolves via (download source)</th><td>${extLink(x.sourceUrl)}</td></tr>
            <tr><th>Webflow URL</th><td>${x.newUrl ? extLink(x.newUrl) : `<span class="muted">not uploaded yet</span>`}</td></tr>
            <tr><th>Source file check</th><td>${sourceStatus(x)}</td></tr>
            <tr><th>Old URL today</th><td>${cfStatus(x.check?.old)}${x.check?.old?.finalUrl && x.check.old.redirected ? `<br/><span class="muted">lands on: ${extLink(x.check.old.finalUrl)}</span>` : ""}</td></tr>
            ${x.assetId ? `<tr><th>Webflow asset id</th><td><code>${esc(x.assetId)}</code></td></tr>` : ""}
            ${x.folder ? `<tr><th>Webflow folder</th><td>${esc(x.folder)}</td></tr>` : ""}
            ${x.migrateError ? `<tr><th>Migration error</th><td><span class="imgcheck bad">✕ ${esc(x.migrateError.phase)} · ${x.migrateError.status ?? "—"} ${esc(x.migrateError.code ?? "")}</span><br/><span class="muted">${esc(x.migrateError.message)}</span><br/><span class="muted">${esc(x.migrateError.at)}</span></td></tr>` : ""}
          </table>
        </div>
      </div>
      <div class="field-card">
        <div class="field-head"><span class="fname">Preview${x.newUrl ? " — original vs Webflow copy" : " — original (HubSpot CDN)"}</span></div>
        <div class="field-body">
          ${x.newUrl ? `<div class="preview-compare">
            <div class="preview-cell">
              <div class="split-head sh-old">Original — HubSpot CDN</div>
              <div class="preview-box">${preview(x.sourceUrl, x.type, "original " + x.sourceUrl)}</div>
            </div>
            <div class="preview-cell">
              <div class="split-head sh-new">Webflow copy</div>
              <div class="preview-box">${preview(x.newUrl, x.type, "webflow " + x.newUrl)}</div>
            </div>
          </div>` : `<div class="preview-box">${preview(x.sourceUrl, x.type, x.sourceUrl)}</div>`}
        </div>
      </div>
    </div>
    <div class="field-card">
      <div class="field-head"><span class="fname">Referenced by</span></div>
      <table class="changes"><thead><tr><th>Item</th><th>Slug</th><th>Field</th><th>Status</th></tr></thead>
      <tbody>${(x.references ?? []).map((r) => `<tr>
        <td>${esc(r.itemName)}<br/><span class="muted">${esc(r.file)}</span></td>
        <td>${esc(r.slug)}</td>
        <td>${esc(r.field)}</td>
        <td><span class="badge ${STATUS_CLASS[r.status] ?? "pending"}">${r.status}</span></td>
      </tr>`).join("")}</tbody></table>
    </div>`;
  $("#back-assets").onclick = () => renderAssets();
}

/* ---------- diff (token LCS, capped) ---------- */

function diffHtml(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length * tb.length > 4_000_000) {
    return `<span class="muted">(content too large for inline diff — see the change list below)</span>`;
  }
  const ops = lcsDiff(ta, tb);
  return ops.map(([op, text]) =>
    op === 0 ? esc(text) : op < 0 ? `<del>${esc(text)}</del>` : `<ins>${esc(text)}</ins>`
  ).join("");
}

function tokenize(s) {
  return s.match(/<[^>]*>|[^\s<]+|\s+/g) ?? [];
}

function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  const push = (op, text) => {
    if (!text) return;
    const last = ops[ops.length - 1];
    if (last && last[0] === op) last[1] += text;
    else ops.push([op, text]);
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(0, a[i]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { push(-1, a[i]); i++; }
    else { push(1, b[j]); j++; }
  }
  while (i < n) { push(-1, a[i]); i++; }
  while (j < m) { push(1, b[j]); j++; }
  return ops;
}

/* ---------- all-changes table ---------- */

async function renderChanges(presetRule = "") {
  const view = $("#changes-view");
  if (!state.links || !state.assets) {
    [state.assets, state.links] = await Promise.all([
      fetch("/api/assets").then((r) => r.json()),
      fetch("/api/links").then((r) => r.json()),
    ]);
  }
  const linkByOld = new Map(state.links.map((l) => [l.oldUrl, l]));
  const assetBySource = new Map(state.assets.map((x) => [x.sourceUrl, x]));
  const mark = (side) => side == null ? ""
    : ` <span class="imgcheck ${side.ok ? "ok" : "bad"}">${side.ok ? "✓" : "✕"} ${side.status || esc(side.error || "err")}</span>`;
  const rules = [...new Set(state.plan.map((e) => e.ruleId))];
  const statuses = [...new Set(state.plan.map((e) => e.status))];
  const files = [...new Set(state.plan.map((e) => e.file))];
  view.innerHTML = `<h2>All changes (${state.plan.length})</h2>
    <div class="filters">
      <select id="f-file"><option value="">all files</option>${files.map((f) => `<option>${esc(f)}</option>`).join("")}</select>
      <select id="f-rule"><option value="">all rules</option>${rules.map((r) => `<option${r === presetRule ? " selected" : ""}>${esc(r)}</option>`).join("")}</select>
      <select id="f-status"><option value="">all statuses</option>${statuses.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
      <input id="f-search" placeholder="search URL…" />
    </div>
    <table class="changes"><thead><tr>
      <th>Status</th><th>Item</th><th>Field</th><th>Old URL</th><th>New URL</th><th>Rule</th>
    </tr></thead><tbody></tbody></table>`;
  const tbody = $("tbody", view);
  const apply = () => {
    const ff = $("#f-file").value, fr = $("#f-rule").value, fs = $("#f-status").value,
      q = $("#f-search").value.toLowerCase();
    tbody.innerHTML = state.plan
      .filter((e) => (!ff || e.file === ff) && (!fr || e.ruleId === fr) && (!fs || e.status === fs) &&
        (!q || e.oldUrl.toLowerCase().includes(q) || (e.newUrl ?? "").toLowerCase().includes(q)))
      .map((e) => {
        const lc = e.action === "rewrite" ? linkByOld.get(e.oldUrl)?.check : null;
        const ac = e.action === "rehost" ? assetBySource.get(e.sourceUrl)?.check : null;
        const verdict = lc ? linkVerdict(lc) : null;
        return `<tr>
        <td><span class="badge ${STATUS_CLASS[e.status] ?? "pending"}">${e.status}</span></td>
        <td>${esc(e.itemName)}<br/><span class="muted">${esc(e.file)}</span></td>
        <td>${esc(e.field)}</td>
        <td>${esc(e.oldUrl)}${lc ? mark(lc.old) : ac ? mark(ac.old) : ""}</td>
        <td>${e.newUrl ? esc(e.newUrl) : "<span class='muted'>pending</span>"}${lc ? mark(lc.new) : ""}${e.verify ? `<br/><span class="muted">${e.verify.ok ? "✓" : "✕"} HTTP ${e.verify.status} ${esc(e.verify.contentType || "")}</span>` : ""}${verdict && verdict.cls !== "ok" ? `<br/><span class="imgcheck ${verdict.cls}">${verdict.text}</span>` : ""}</td>
        <td>${esc(e.ruleId)}</td>
      </tr>`;
      }).join("");
  };
  for (const id of ["f-file", "f-rule", "f-status"]) $("#" + id, view).onchange = apply;
  $("#f-search", view).oninput = apply;
  apply();
}

/* ---------- overview: what needs a human, and sign-off ---------- */

async function renderOverview() {
  const view = $("#overview-view");
  const o = await fetch("/api/overview").then((r) => r.json());
  const allTasksDone = o.tasks.every((t) => t.done);
  const good = o.failedEntries === 0 && o.exports.equivalencePass;

  view.innerHTML = `
    <h2>Migration overview</h2>
    <div class="summary hero">
      <span class="chip chip-ok big">✓ ${o.verified} URLs updated &amp; verified</span>
      <span class="chip ${o.skipped ? "chip-warn" : "chip-ok"} big">⊘ ${o.skipped} skipped (tracked)</span>
      <span class="chip ${o.failedEntries ? "chip-bad" : "chip-ok"} big">✕ ${o.failedEntries} failing (need a human)</span>
      <span class="chip ${o.review.reviewed >= o.review.total ? "chip-ok" : ""} big">👁 ${o.review.reviewed}/${o.review.total} items reviewed</span>
      <span class="chip ${o.exports.equivalencePass ? "chip-ok" : "chip-warn"} big">${o.exports.equivalencePass ? "✓ export equivalence PASS" : "export not verified yet"}</span>
    </div>
    ${allTasksDone ? `<div class="note" style="background:#f0fdf4;border-color:#86efac;color:#14532d"><b>✓ All sign-off gates done — migration is good to go.</b></div>` : ""}

    <div class="field-card">
      <div class="field-head"><span class="fname">Good-to-go checklist — tick each gate as you complete it</span></div>
      <div class="field-body">
        ${o.tasks.map((t) => `<label class="task ${t.done ? "task-done" : ""}">
          <input type="checkbox" data-task="${esc(t.id)}" ${t.done ? "checked" : ""} ${t.auto ? "disabled" : ""}/>
          <span>${esc(t.label)}${t.auto ? ` <span class="muted">(auto — completes when every updated item is marked reviewed)</span>` : ""}${t.done && t.at ? ` <span class="muted">· done ${esc(t.at.slice(0, 16).replace("T", " "))}</span>` : ""}</span>
        </label>`).join("")}
      </div>
    </div>

    <div class="field-card ${o.failingItems.length ? "rule-bad" : ""}">
      <div class="field-head"><span class="fname">Needs a human — failing URLs (${o.failingItems.length} item${o.failingItems.length === 1 ? "" : "s"})</span></div>
      <div class="field-body">
        ${o.failingItems.length === 0 ? `<span class="imgcheck ok">✓ nothing failing</span>` : o.failingItems.map((it) => `
          <div class="fail-line"><a href="#" class="goto-item" data-file="${esc(it.file)}" data-row="${it.row}"><b>${esc(it.itemName)}</b></a>
          ${it.problems.map((p) => `<br/><span class="muted">${esc(p)}</span>`).join("")}</div>`).join("")}
        ${o.failingItems.length ? `<p class="muted">Fix path: replace or remove these in Webflow after import (the exported content keeps the old URL); the two hs. links need Webflow pages or redirects.</p>` : ""}
      </div>
    </div>

    <div class="field-card">
      <div class="field-head"><span class="fname">Still on HubSpot CDN — tracked (${o.notUploaded.length} files)</span>
        ${Object.entries(o.notUploadedByType).map(([t, n]) => `<span class="chip">${esc(t)}: ${n}</span>`).join(" ")}
      </div>
      <div class="field-body">
        <p class="muted">These could not move to Webflow (no video uploads; 10MB document / 4MB image limits) and remain on the HubSpot CDN.
        Content referencing them is left exactly as it was — zero changes. Tracked here and in docs/hubspot-migration-leftovers.md;
        direction on what to do with them is an open decision.</p>
        <details><summary>Show all ${o.notUploaded.length} URLs</summary>
          ${o.notUploaded.map((n) => `<div class="fail-line"><span class="fail-field" style="background:#fef3c7">${esc(n.type)}</span> ${extLink(n.url)}<br/><span class="muted">${esc(n.reason)}</span></div>`).join("")}
        </details>
      </div>
    </div>

    <div class="detail-grid" style="grid-template-columns:1fr 1fr">
      <div class="field-card">
        <div class="field-head"><span class="fname">Deliverables</span></div>
        <div class="field-body">
          ${o.exports.files.map((f) => `<div>📄 output/${esc(f)}</div>`).join("") || "<div class='muted'>no CSVs exported yet</div>"}
          <div>${o.exports.redirectsCsv ? "📄 output/fs-301-redirects.csv (Finsweet)" : "<span class='muted'>Finsweet 301 CSV not generated</span>"}</div>
          <div>${o.exports.equivalencePass ? `<span class="imgcheck ok">✓ equivalence report PASS</span>` : `<span class="imgcheck wait">equivalence pending</span>`}</div>
        </div>
      </div>
    </div>

    <p class="muted">How to verify an item: open it, check the side-by-side panes (green outline = new URL, red = failing),
    then click "Mark as reviewed". The review gate completes itself when all ${o.review.total} updated items are ✔.</p>`;

  for (const cb of view.querySelectorAll("[data-task]")) {
    cb.onchange = async () => {
      await fetch("/api/signoff", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cb.dataset.task, done: cb.checked }) });
      renderOverview();
    };
  }
  for (const a of view.querySelectorAll(".goto-item")) {
    a.onclick = (ev) => {
      ev.preventDefault();
      const rowEl = [...document.querySelectorAll(".item-row")].find((r) =>
        r.querySelector(".title")?.textContent.includes(a.textContent.trim()));
      switchView("items");
      openItem(a.dataset.file, Number(a.dataset.row), rowEl ?? document.createElement("div"));
    };
  }
}

/* ---------- stats: field-level vs in-content change counts ---------- */

async function renderStats() {
  const view = $("#stats-view");
  const stats = await fetch("/api/stats").then((r) => r.json());
  const grand = { updates: 0, whole: 0, embedded: 0, leftovers: 0 };
  const sumStatuses = {};
  for (const f of stats) for (const fl of f.fields) {
    grand.updates += fl.updates; grand.whole += fl.whole; grand.embedded += fl.embedded; grand.leftovers += fl.leftovers;
    for (const [s, n] of Object.entries(fl.statuses)) sumStatuses[s] = (sumStatuses[s] ?? 0) + n;
  }
  view.innerHTML = `<h2>Change statistics</h2>
    <div class="summary">
      <span class="chip chip-ok">${grand.updates} real updates</span>
      <span class="chip">${grand.whole} field-level (whole field is the URL)</span>
      <span class="chip">${grand.embedded} in-content (inside rich text)</span>
      <span class="chip ${grand.leftovers ? "chip-warn" : "chip-ok"}">${grand.leftovers} tracked leftovers (skipped/failed — no diff, don't count)</span>
      ${Object.entries(sumStatuses).map(([s, n]) => `<span class="chip ${s === "failed" ? "chip-bad" : s === "verified" ? "chip-ok" : s === "skipped" ? "chip-warn" : ""}">${s}: ${n}</span>`).join("")}
    </div>
    ${stats.map((f) => {
      const t = f.fields.reduce((a, x) => ({ updates: a.updates + x.updates, whole: a.whole + x.whole, embedded: a.embedded + x.embedded, leftovers: a.leftovers + x.leftovers }), { updates: 0, whole: 0, embedded: 0, leftovers: 0 });
      return `<div class="field-card">
      <div class="field-head"><span class="fname">${esc(f.file)}</span>
        <span class="badge ${t.updates ? "verified" : "zero"}">${t.updates} real updates</span>
        <span class="muted" style="margin-left:8px">${t.whole} field-level · ${t.embedded} in-content${t.leftovers ? ` · ${t.leftovers} leftovers` : ""}</span>
        ${t.updates === 0 ? `<span class="muted" style="margin-left:8px">— nothing to re-import</span>` : ""}
      </div>
      <table class="changes"><thead><tr>
        <th>Field</th><th>Real updates</th><th>Field-level</th><th>In-content</th><th>Leftovers (no diff)</th><th>Items updated</th><th>Status breakdown</th>
      </tr></thead><tbody>
        ${f.fields.map((fl) => `<tr>
          <td><b>${esc(fl.field)}</b></td>
          <td>${fl.updates || "—"}</td>
          <td>${fl.whole || "—"}</td>
          <td>${fl.embedded || "—"}</td>
          <td>${fl.leftovers || "—"}</td>
          <td>${fl.items}</td>
          <td>${Object.entries(fl.statuses).map(([s, n]) => `<span class="badge ${STATUS_CLASS[s] ?? "pending"}">${s} ${n}</span>`).join(" ")}</td>
        </tr>`).join("")}
      </tbody></table>
    </div>`;
    }).join("")}
    <p class="muted">Real updates = URL actually replaced in the export (a visible diff). Leftovers = skipped (videos/oversize) or
    failed (dead source) URLs — no diff, tracked for the later move/redirect work, never counted as changes.
    Field-level = the whole field value is swapped; in-content = only the URL substring inside rich text changes.</p>`;
}

/* ---------- issues: what needs a human, with live URLs ---------- */

async function renderIssues() {
  const view = $("#issues-view");
  const { manual, redirects } = await fetch("/api/issues").then((r) => r.json());

  view.innerHTML = `<h2>Issues — manual work needed</h2>
    <div class="summary">
      <span class="chip ${manual.length ? "chip-bad" : "chip-ok"}">${manual.length} item${manual.length === 1 ? "" : "s"} need content edits</span>
      <span class="chip ${redirects.length ? "chip-warn" : "chip-ok"}">${redirects.length} redirect${redirects.length === 1 ? "" : "s"} to create — no content edit needed</span>
    </div>

    <div class="field-card ${manual.length ? "rule-bad" : ""}">
      <div class="field-head"><span class="fname">Content edits — fix these in the Webflow editor after import (${manual.length})</span></div>
      <div class="field-body">
        ${manual.length === 0 ? `<span class="imgcheck ok">✓ nothing needs a content edit</span>` : ""}
        ${manual.map((m) => `<div class="issue-card">
          <div class="issue-head">
            <b>${esc(m.itemName)}</b>
            <span class="slug">/${esc(m.slug)}</span>
            ${extLink(m.liveUrl, "open live page")}
            <button class="minibtn goto-item" data-file="${esc(m.file)}" data-row="${m.row}">open in portal</button>
          </div>
          <div class="muted">${esc(m.file)}</div>
          ${m.problems.map((p) => `<div class="fail-line"><span class="fail-field">${esc(p.field)}</span> ${esc(p.oldUrl)}<br/>
            <span class="muted">${esc(p.error)}</span><br/>
            <span class="muted"><b>What to do:</b> the file no longer exists anywhere — delete this ${p.field.toLowerCase().includes("image") || /\.(png|jpe?g|gif)/i.test(p.oldUrl) ? "image" : "element"} from the item in Webflow, or replace it with a new file.</span></div>`).join("")}
        </div>`).join("")}
      </div>
    </div>

    <div class="field-card">
      <div class="field-head"><span class="fname">Redirects only — create these in Webflow, no content edits needed (${redirects.length})</span></div>
      <div class="field-body">
        ${redirects.length === 0 ? `<span class="imgcheck ok">✓ none</span>` : ""}
        ${redirects.map((r) => `<div class="issue-card">
          <div class="issue-head"><b>${esc(r.target)}</b> <span class="imgcheck bad">✕ ${esc(r.status)}</span></div>
          <div class="muted">Old link in content: ${esc(r.oldUrl)} — the exported content keeps this link; once a Webflow page or 301 exists at <code>${esc(r.target)}</code> it works everywhere. No item edits required.</div>
          <div class="muted">Linked from: ${r.items.map((i) => `${esc(i.itemName)} (${extLink(i.liveUrl, "/" + esc(i.slug))})`).join(" · ")}</div>
        </div>`).join("")}
      </div>
    </div>

    <p class="muted">Skipped videos/oversize files are NOT issues — they're tracked in the video-strategy gate on the Overview
    and in docs/hubspot-migration-leftovers.md.</p>`;

  for (const b of view.querySelectorAll(".goto-item")) {
    b.onclick = () => {
      switchView("items");
      openItem(b.dataset.file, Number(b.dataset.row), document.createElement("div"));
    };
  }
}

/* ---------- 301 redirects for HubSpot public PDFs ---------- */

let redirectsPoller = null;

async function renderRedirects() {
  const view = $("#redirects-view");
  const { rows, progress } = await fetch("/api/redirects").then((r) => r.json());
  if (rows.length === 0) {
    view.innerHTML = `<h2>PDF 301 redirects</h2>
      <div class="note">No HubSpot public-PDFs CSV found. Drop the exported list (e.g. "hubspot_public_pdfs…csv") into workspace/inbox/ and reload.</div>`;
    return;
  }
  const by = (s) => rows.filter((r) => r.status === s).length;
  const ready = rows.filter((r) => r.target).length;
  view.innerHTML = `<h2>PDF 301 redirects — ${rows.length} public PDFs</h2>
    <p class="muted">Old site path (currently rescued by Cloudflare) → permanent target. Uploaded PDFs point at their
    Webflow copy; files over Webflow's 10 MB limit keep the HubSpot CDN as target and are flagged. Output is the
    Finsweet bulk-301 format: <code>path,targetPath</code>.</p>
    <div class="summary">
      <span class="chip chip-ok">reused from migration: ${by("reused")}</span>
      <span class="chip ${by("uploaded") ? "chip-ok" : ""}">uploaded: ${by("uploaded")}</span>
      <span class="chip ${by("pending") ? "chip-warn" : "chip-ok"}">pending: ${by("pending")}</span>
      <span class="chip ${by("too-large") ? "chip-warn" : "chip-ok"}">over 10 MB (stay on CDN): ${by("too-large")}</span>
      <span class="chip ${by("failed") ? "chip-bad" : "chip-ok"}">failed: ${by("failed")}</span>
      <span class="chip">redirects ready: ${ready}/${rows.length}</span>
    </div>
    <div class="migrate-bar">
      <button id="run-redirects">▶ Upload PDFs + generate Finsweet CSV</button>
      <a id="dl-redirects" class="minibtn" href="/api/redirects/csv" download>⬇ Download fs-301-redirects.csv</a>
      <div id="redirects-progress" class="muted"></div>
    </div>
    <table class="changes"><thead><tr>
      <th>Status</th><th>Old path → target</th><th>Size</th><th>Folder</th>
    </tr></thead><tbody>
      ${rows.map((r) => `<tr>
        <td><span class="badge ${r.status === "failed" ? "failed" : r.status === "pending" ? "pending" : r.status === "too-large" ? "pending" : "verified"}">${r.status}</span></td>
        <td class="urlcell">
          <div class="u"><span class="ulabel">path</span> ${extLink(r.oldPath)}</div>
          <div class="u"><span class="ulabel">target</span> ${r.target ? extLink(r.target) : `<span class="muted">pending upload</span>`}</div>
          ${r.error ? `<div class="u"><span class="ulabel"></span><span class="imgcheck bad">✕ ${esc(r.error)}</span></div>` : ""}
        </td>
        <td>${(r.sizeKb / 1024).toFixed(1)} MB${r.sizeKb > 10240 ? " ⚠" : ""}</td>
        <td>${esc(r.folder)}</td>
      </tr>`).join("")}
    </tbody></table>`;

  const btn = $("#run-redirects", view);
  const bar = $("#redirects-progress", view);
  const paint = (p) => {
    if (!p.startedAt) return;
    bar.innerHTML = p.running
      ? `<b>Uploading</b> — ${p.done}/${p.total} · ${p.ok} ok · ${p.fail} failed · ${p.tooLarge} over-limit`
      : `<b>Finished:</b> ${esc(p.lastMessage)}`;
    btn.disabled = p.running;
  };
  paint(progress);
  const poll = async () => {
    const { progress: p } = await fetch("/api/redirects").then((r) => r.json()).catch(() => ({ progress: null }));
    if (!p) return;
    paint(p);
    if (!p.running && redirectsPoller) {
      clearInterval(redirectsPoller);
      redirectsPoller = null;
      renderRedirects();
    }
  };
  if (progress.running && !redirectsPoller) redirectsPoller = setInterval(poll, 2500);
  btn.onclick = async () => {
    btn.disabled = true;
    const r = await fetch("/api/redirects/run", { method: "POST" }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) { bar.textContent = "✕ " + r.error; btn.disabled = false; return; }
    if (!redirectsPoller) redirectsPoller = setInterval(poll, 2500);
  };
}

/* ---------- verify: live dual-domain redirect verification ---------- */

let verifyPoller = null;

async function renderVerify() {
  const view = $("#verify-view");
  const data = await fetch("/api/redirect-verify").then((r) => r.json());
  const rows = data.rows ?? [];
  const p = data.progress;

  const st = (s) => s === 200 ? `<span class="imgcheck ok">200</span>` : s >= 300 && s < 400 ? `<span class="imgcheck wait">${s}</span>` : `<span class="imgcheck bad">${s || "ERR"}</span>`;
  const summary = rows.length ? {
    total: rows.length,
    today: rows.filter((r) => r.worksToday).length,
    after: rows.filter((r) => r.survivesCutover).length,
    cfOnly: rows.filter((r) => r.via === "cloudflare only").length,
    tgtBad: rows.filter((r) => r.targetFile.status !== 200).length,
  } : null;

  view.innerHTML = `
    <h2>Redirect verification — live, both domains</h2>
    <div class="migrate-bar">
      <button id="run-verify-redirects">▶ Verify all redirects live (~3–4 min)</button>
      ${rows.length ? `<button id="dl-verify" class="minibtn">⬇ Export results (single HTML file)</button>` : ""}
      <div id="verify-progress" class="muted">${p.running ? `running ${p.done}/${p.total}…` : data.checkedAt ? `last run: ${esc(data.checkedAt.slice(0, 16).replace("T", " "))}` : "never run — click to start"}</div>
    </div>
    ${summary ? `<div class="summary">
      <span class="chip">${summary.total} redirects</span>
      <span class="chip ${summary.today === summary.total ? "chip-ok" : "chip-bad"}">works today (www): ${summary.today}/${summary.total}</span>
      <span class="chip ${summary.after === summary.total ? "chip-ok" : "chip-warn"}">survives Cloudflare removal: ${summary.after}/${summary.total}</span>
      <span class="chip ${summary.cfOnly ? "chip-warn" : "chip-ok"}">cloudflare-only (die after removal): ${summary.cfOnly}</span>
      <span class="chip ${summary.tgtBad ? "chip-bad" : "chip-ok"}">target files broken: ${summary.tgtBad}</span>
    </div>` : ""}
    ${rows.length ? `<table class="changes dead-table"><thead><tr>
      <th>#</th><th>Original URL</th><th>Live (www) — hop → final</th><th>Via</th><th>webflow.io</th><th>Webflow/target file</th>
    </tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${r.healthy ? "" : r.worksToday ? "vrow-warn" : "vrow-bad"}">
        <td class="num">${i + 1}</td>
        <td class="urlcell">${extLink(state.siteBaseUrl + r.path, decodeURIComponent(r.path))}</td>
        <td>${st(r.live.firstHop)} → ${esc(r.live.to)} · final ${st(r.live.finalStatus)} ${esc(r.live.finalHost)}</td>
        <td class="fieldname">${esc(r.via)}</td>
        <td>${st(r.webflow.status)}${r.webflow.matchesTarget ? ` <span class="imgcheck ok">→ ${esc(r.webflow.to)} ✓</span>` : r.webflow.status >= 300 && r.webflow.status < 400 ? ` <span class="imgcheck bad">wrong target</span>` : ` <span class="imgcheck bad">no redirect</span>`}</td>
        <td>${st(r.targetFile.status)} <span class="muted">${esc(r.targetFile.contentType)}</span><br/>${extLink(r.target, "open file")}</td>
      </tr>`).join("")}
    </tbody></table>` : `<p class="muted">Run the verification to build the table.</p>`}`;

  const btn = $("#run-verify-redirects", view);
  const bar = $("#verify-progress", view);
  btn.disabled = p.running;
  const poll = async () => {
    const d = await fetch("/api/redirect-verify").then((r) => r.json()).catch(() => null);
    if (!d) return;
    bar.textContent = d.progress.running ? `running ${d.progress.done}/${d.progress.total}…` : "finished — rendering…";
    if (!d.progress.running && verifyPoller) {
      clearInterval(verifyPoller);
      verifyPoller = null;
      renderVerify();
    }
  };
  if (p.running && !verifyPoller) verifyPoller = setInterval(poll, 2500);
  btn.onclick = async () => {
    btn.disabled = true;
    const r = await fetch("/api/redirect-verify/run", { method: "POST" }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) { bar.textContent = "✕ " + r.error; btn.disabled = false; return; }
    if (!verifyPoller) verifyPoller = setInterval(poll, 2500);
  };

  const dl = $("#dl-verify", view);
  if (dl) dl.onclick = async () => {
    const css = await fetch("/style.css").then((x) => x.text());
    const clone = view.cloneNode(true);
    clone.querySelectorAll("#run-verify-redirects, #dl-verify, #verify-progress").forEach((el) => el.remove());
    const when = (data.checkedAt ?? "").slice(0, 10);
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Redirect Verification — ${esc(when)}</title>
<style>${css}
body { display: block; height: auto; overflow: auto; background: #f6f7f9; }
.report-wrap { max-width: 1250px; margin: 0 auto; padding: 28px 32px; }
</style></head>
<body><div class="report-wrap">
<p class="muted">Verified live on ${esc((data.checkedAt ?? "").replace("T", " ").slice(0, 16))} — every link clickable.</p>
${clone.innerHTML}</div></body></html>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    a.download = `redirect-verification-${when}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

/* ---------- report: every summary in one place, exportable as .md ---------- */

/** Minimal markdown renderer — headers, lists, checkboxes, tables, bold, links, hr. */
function mdToHtml(md) {
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a class="urllink" href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(https?:\/\/[^\s<)]+)/g, (m) => `<a class="urllink" href="${m}" target="_blank" rel="noopener">${m}</a>`);
  const lines = md.split("\n");
  const out = [];
  let inList = false;
  let inTable = false;
  const closeAll = () => { if (inList) { out.push("</ul>"); inList = false; } if (inTable) { out.push("</table>"); inTable = false; } };
  for (const line of lines) {
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;
    if (/^---+$/.test(line.trim())) { closeAll(); out.push("<hr/>"); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeAll(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // separator row
      if (!inTable) { closeAll(); out.push('<table class="changes">'); inTable = true; }
      const cells = line.trim().replace(/^\||\|$/g, "").split("|");
      out.push("<tr>" + cells.map((c) => `<td>${inline(c.trim())}</td>`).join("") + "</tr>");
      continue;
    }
    const li = line.match(/^(\s*)-\s+(?:\[([ x])\]\s+)?(.*)/);
    if (li) {
      if (inTable) { out.push("</table>"); inTable = false; }
      if (!inList) { out.push("<ul>"); inList = true; }
      const check = li[2] === undefined ? "" : li[2] === "x" ? "✅ " : "⬜ ";
      out.push(`<li style="margin-left:${li[1].length * 8}px">${check}${inline(li[3])}</li>`);
      continue;
    }
    if (!line.trim()) { closeAll(); continue; }
    closeAll();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeAll();
  return out.join("\n");
}

async function renderReport() {
  const view = $("#report-view");
  view.innerHTML = `<p class="muted">Building report…</p>`;
  const r = await fetch("/api/report").then((x) => x.json());
  const s = r.stats;
  const stat = (n, label, cls = "") => `<div class="stat ${cls}"><div class="stat-n">${n}</div><div class="stat-l">${label}</div></div>`;

  view.innerHTML = `
    <div class="item-title-row">
      <h2>Migration report</h2>
      <button id="dl-html" class="minibtn">⬇ Download report.html (single shareable file)</button>
      <span class="muted">rebuilt live · ${esc(r.generatedAt.slice(0, 16).replace("T", " "))}</span>
    </div>

    <div class="stat-cards">
      ${stat(s.verified.toLocaleString(), "URLs migrated & verified", "st-ok")}
      ${stat(s.onWebflow.toLocaleString(), "files hosted on Webflow", "st-ok")}
      ${stat(s.redirectRows, "301 redirects published", "st-ok")}
      ${stat(s.skippedAccepted, "kept on HubSpot (tracked)", "st-warn")}
      ${stat(r.needsToFix.length, "things need fixing", r.needsToFix.length ? "st-bad" : "st-ok")}
    </div>

    <div class="field-card">
      <div class="field-head"><span class="fname">Summary</span></div>
      <div class="field-body report-body"><ul>${r.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>
    </div>

    <div class="field-card rule-bad">
      <div class="field-head"><span class="fname">🔧 Needs to fix — ${r.needsToFix.length} things</span></div>
      <div class="field-body">
        ${r.needsToFix.map((x, i) => `<div class="fix-block">
          <div class="fix-num">${i + 1}</div>
          <div><b>${esc(x.title)}</b><div class="muted">${esc(x.summary)}</div></div>
        </div>`).join("")}
      </div>
    </div>

    <div class="field-card ${r.decisions.length ? "rule-bad" : ""}">
      <div class="field-head"><span class="fname">Details · Blogs — ${r.decisions.length} posts with ${s.deadImages} dead images
        (${r.decisions.filter((d) => d.published && !d.draft).length} published with live-site impact · ${r.decisions.filter((d) => d.draft || !d.published).length} never-published draft · ${r.decisions.filter((d) => d.importBlocked).length} still awaiting re-import)</span></div>
      <div class="field-body">
        ${(() => {
          let n = 0;
          const rows = r.decisions.flatMap((d) => d.deadSrcs.map((x, i) => {
            const span = d.deadSrcs.length;
            const lead = i === 0 ? `
              <td rowspan="${span}" class="num">${++n}</td>
              <td rowspan="${span}"><b>${esc(d.title)}</b><br/>${d.draft || !d.published
                  ? `<span class="muted">/${esc(d.slug)} (no live page — draft)</span>`
                  : extLink(d.liveUrl, "/" + esc(d.slug))}
                <button class="minibtn goto-item" data-file="${esc(d.file)}" data-row="${d.row}">portal</button>
                <br/><span class="muted">${span} image${span > 1 ? "s" : ""} to fix</span></td>
              <td rowspan="${span}">${d.draft || !d.published
                ? `<span class="badge pending" title="never published — the dead image has no live-site impact">draft</span>`
                : `<span class="badge verified" title="live on the site — the dead image is visible to visitors">published</span>`}</td>` : "";
            return `<tr class="${i === 0 ? "post-start" : ""}">${lead}
              <td class="fieldname">${esc(x.field)}</td>
              <td>${extLink(x.url)}${x.alt ? `<br/><span class="muted">alt: "${esc(x.alt)}"</span>` : ""}</td>
              <td class="ctx">${x.placedAfter.startsWith("(") ? `<span class="muted">${esc(x.placedAfter)}</span>` : `<span class="muted">…</span>${esc(x.placedAfter)}`}</td>
              <td class="muted">${esc(x.note)}</td>
            </tr>`;
          }));
          return `<table class="changes dead-table"><thead><tr>
            <th>#</th><th>Blog post</th><th>Status</th><th>Field</th><th>Broken image URL</th><th>Where it sits — appears right after this text</th><th>Why it is dead</th>
          </tr></thead><tbody>${rows.join("")}</tbody></table>`;
        })()}
      </div>
    </div>

    <div class="field-card">
      <div class="field-head"><span class="fname">Details · Not on Webflow — ${r.deps.files.length} files on the HubSpot CDN + ${r.deps.embeds.length} embedded videos</span></div>
      <div class="field-body report-body">
        <p class="muted">These could not move to Webflow (no video uploads; 10MB document / 4MB image limits). They work today via HubSpot.
        Direction needed: keep them on HubSpot, or move them to another host.</p>
        ${(() => {
          const usedInCell = (usedIn, fallback) => usedIn.length
            ? usedIn.map((u) => `${u.draft
                ? `${esc(u.itemName)} <span class="badge pending" title="never published — no live page to open">draft</span>`
                : `${extLink(u.liveUrl, esc(u.itemName))} <span class="badge verified">published</span>`}`).join("<br/>")
            : `<span class="muted">${fallback}</span>`;
          let n = 0;
          const fileRows = r.deps.files.map((f) => `<tr>
            <td class="num">${++n}</td>
            <td>${extLink(f.url)}</td>
            <td class="fieldname">${esc(f.type)}</td>
            <td class="muted">not on Webflow — ${esc(f.reason)}</td>
            <td>${usedInCell(f.usedIn, f.source.includes("public-PDF") ? "from the HubSpot public-PDFs list — not referenced in CMS content" : "not referenced in CMS content")}</td>
          </tr>`).join("");
          let m = 0;
          const embedRows = r.deps.embeds.map((e) => `<tr>
            <td class="num">${++m}</td>
            <td>${extLink(e.exampleUrl, "HubSpot video " + esc(e.videoId))}</td>
            <td class="fieldname">video embed</td>
            <td class="muted">not on Webflow — HubSpot video-player embed; plays via HubSpot's service</td>
            <td>${usedInCell(e.usedIn, "—")}</td>
          </tr>`).join("");
          return `
            <h3>Files (${r.deps.files.length})</h3>
            <table class="changes dead-table"><thead><tr><th>#</th><th>File URL</th><th>Type</th><th>Status / why</th><th>Used in (CMS item · live link · state)</th></tr></thead>
            <tbody>${fileRows}</tbody></table>
            <h3>Video embeds (${r.deps.embeds.length} unique videos, ${r.videoEmbedRefs} references)</h3>
            <table class="changes dead-table"><thead><tr><th>#</th><th>Video</th><th>Type</th><th>Status / why</th><th>Embedded in (CMS item · live link · state)</th></tr></thead>
            <tbody>${embedRows}</tbody></table>`;
        })()}
      </div>
    </div>

    ${r.redirectFix ? `<div class="field-card">
      <div class="field-head"><span class="fname">Details · Redirects — ${r.redirectFix.count} row pending upload <span class="badge pending">temporary fix on record</span></span></div>
      <div class="field-body report-body">
        <p class="muted">${esc(r.redirectFix.reason)}</p>
        <p><b>Corrected row (${esc(r.redirectFix.file)}):</b></p>
        ${r.redirectFix.rows.map((row) => `<p><code>${esc(row)}</code></p>`).join("")}
      </div>
    </div>` : ""}

    <div class="field-card">
      <div class="field-head"><span class="fname">Collections covered</span></div>
      <div class="field-body report-body"><ul>${r.collections.map((c) => `<li><b>${esc(c.collection)}</b> — ${esc(c.note)}</li>`).join("")}</ul></div>
    </div>`;

  for (const b of view.querySelectorAll(".goto-item")) {
    b.onclick = () => {
      switchView("items");
      openItem(b.dataset.file, Number(b.dataset.row), document.createElement("div"));
    };
  }

  $("#dl-html", view).onclick = async () => {
    const css = await fetch("/style.css").then((x) => x.text());
    // snapshot the rendered view; strip portal-only controls
    const clone = view.cloneNode(true);
    clone.querySelectorAll(".goto-item, #dl-html").forEach((el) => el.remove());
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>HubSpot → Webflow Migration Report — ${esc(r.generatedAt.slice(0, 10))}</title>
<style>${css}
body { display: block; height: auto; overflow: auto; background: #f6f7f9; }
.report-wrap { max-width: 1100px; margin: 0 auto; padding: 28px 32px; }
</style></head>
<body><div class="report-wrap">${clone.innerHTML}</div></body></html>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    a.download = `hubspot-migration-report-${r.generatedAt.slice(0, 10)}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

/* ---------- audit log ---------- */

async function renderLog() {
  const view = $("#log-view");
  const log = await fetch("/api/log").then((r) => r.json());
  view.innerHTML = `<h2>Audit log (${log.length})</h2>` +
    log.slice().reverse().map((l) =>
      `<div class="log-line"><span class="muted">${esc(l.ts ?? "")}</span> <b>${esc(l.stage ?? "")}</b> ` +
      `${esc(l.file ?? "")} ${esc(l.item ?? "")} ${esc(l.field ?? "")} ` +
      `${l.oldUrl ? esc(l.oldUrl) + " → " + esc(l.newUrl ?? "?") : ""} ` +
      `${l.error ? `<span style="color:#dc2626">${esc(l.error)}</span>` : ""} ${esc(l.note ?? "")}</div>`
    ).join("");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
