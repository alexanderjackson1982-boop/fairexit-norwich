/* FairExit Norwich UI (Build 2).
 * Traffic data lives only in the `view` variable for one render. No web storage,
 * no client database, no offline worker cache, and no timers that fetch. The only
 * timer clears the view when it expires.
 * Mode "local": talks to the loopback backend. Mode "static": public preview built
 * for GitHub Pages; reads bundled JSON (no traffic data) and hides live controls.
 */
"use strict";

const TOKEN = document.querySelector('meta[name="fairexit-token"]').content;
const MODE = (document.querySelector('meta[name="fairexit-mode"]') || {}).content === "static" ? "static" : "local";
const VIEW_TTL_MS = 10 * 60 * 1000;
const TZ = "Europe/London";

let SITES = null, STATUS = null, MAPDATA = null, INVS = [];
let view = null, viewExpiresAt = 0, clearTimer = null;
let map = null; const L_ = {};  // layer groups
let activeTab = "dash";

// ---------- helpers ----------------------------------------------------------
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) { if (k === null || k === undefined || k === false) continue; e.appendChild(typeof k === "string" ? document.createTextNode(k) : k); }
  return e;
}
function link(href, text) {
  if (!href || !/^https:\/\//.test(href)) return el("span", { text });
  return el("a", { href, target: "_blank", rel: "noopener noreferrer", text });
}
function fmtTime(iso) {
  if (!iso) return "unknown";
  const d = new Date(iso); if (isNaN(d)) return String(iso);
  return d.toLocaleString("en-GB", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " UK";
}
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
const STATIC_ROUTES = {
  "/api/status": "data/status.json", "/api/sites": "data/sites.json", "/api/map": "data/map.json",
  "/api/sources": "data/sources.json", "/api/health": "data/health.json",
  "/api/synthetic?scenario=mixed": "data/synthetic-mixed.json", "/api/synthetic?scenario=empty": "data/synthetic-empty.json",
  "/api/synthetic?scenario=auth_error": "data/synthetic-auth_error.json", "/api/synthetic/metoffice": "data/synthetic-metoffice.json",
  "/api/synthetic/evidence": "data/synthetic-evidence.json", "/api/synthetic/correlation": "data/synthetic-correlation.json",
};
async function api(path, opts = {}) {
  if (MODE === "static") {
    if (path === "/api/investigations") return { investigations: [] };
    const f = STATIC_ROUTES[path];
    if (!f) throw new Error("Not available in the public preview. Run FairExit locally for live data.");
    const r = await fetch(f, { cache: "no-store" }); return r.json();
  }
  const r = await fetch(path, { cache: "no-store", credentials: "same-origin", ...opts,
    headers: { "X-FairExit-Token": TOKEN, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({ error: "bad response" }));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function siteName(id) { const s = SITES && SITES.sites.find(x => x.id === id); return s ? s.name : id; }
function allPoints() {
  const core = SITES.monitoring_points.map(p => ({ ...p, tier: p.request_eligible ? "core" : "excluded" }));
  const ext = (MAPDATA && MAPDATA.extended_points || []).map(p => ({ ...p, tier: "extended" }));
  return [...core, ...ext];
}
function reading(pid) { return view && (view.points[pid] || (view.excluded_points || {})[pid]) || null; }

// ---------- tabs --------------------------------------------------------------------
function showTab(t) {
  activeTab = t;
  for (const b of document.querySelectorAll('[role="tab"]')) b.setAttribute("aria-selected", String(b.dataset.tab === t));
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== "tab-" + t;
  if (t === "dash" && map) setTimeout(() => map.invalidateSize(), 0);
  if (t === "health") loadHealth();
}
for (const b of document.querySelectorAll('[role="tab"]')) b.onclick = () => showTab(b.dataset.tab);

// ---------- banner & attribution -----------------------------------------------------
function renderBanner(msg, cls) {
  const b = document.getElementById("mode-banner"); clear(b);
  const at = document.getElementById("attrib-traffic");
  if (msg) { b.className = "banner " + cls; b.textContent = msg; return; }
  if (!view) {
    b.className = "banner banner-none";
    if (MODE === "static") b.append(el("strong", { text: "Public preview. " }), "Map, zones, coverage plan and synthetic tests only. No live traffic data is published here. Run FairExit on the owner's computer for live readings.");
    else b.append("No traffic data loaded. Press ", el("strong", { text: "Refresh live" }), " or load synthetic data.");
    at.textContent = ""; return;
  }
  if (view.synthetic) {
    b.className = "banner banner-syn";
    b.append(el("strong", { text: "SYNTHETIC TEST DATA" }), " — invented values. Not real traffic. Scenario: " + view.scenario);
  } else {
    const stale = Date.now() - new Date(view.cycle_finished_at_utc).getTime() > 5 * 60 * 1000;
    b.className = "banner " + (stale ? "banner-stale" : "banner-live");
    b.append(el("strong", { text: stale ? "LIVE, AGEING" : "LIVE provider data" }),
      ` — ${view.scope === "extended" ? "extended" : "core"} refresh received ${fmtTime(view.cycle_finished_at_utc)}. Transient, not stored. Cycle: ${view.cycle_status}.`);
    for (const m of view.cycle_messages || []) b.append(el("div", { class: "bmsg", text: m }));
  }
  at.textContent = view.attribution;
}

// ---------- map ----------------------------------------------------------------------
const LAYERS = [
  ["carparks", "Car parks", true], ["zones", "Half-mile zones (805 m)", true], ["exits", "Mapped exits & entrances", true],
  ["monitored", "Roads with a sample point", true], ["unmonitored", "Zone roads without samples (gaps)", true],
  ["minor", "Minor/residential roads", false], ["samples", "Sample points", true], ["live", "Segments returned this refresh", true],
  ["incidents", "Incidents", true], ["invs", "Investigations", true],
];
function tipEl(t) { return el("span", { text: t }); }
function arrowIcon(bearing, cls) {
  const d = el("div", { class: "arrow " + cls }); d.style.transform = `rotate(${bearing}deg)`; d.textContent = "➤";
  return L.divIcon({ html: d, className: "arrow-wrap", iconSize: [16, 16], iconAnchor: [8, 8] });
}
function bearing(a, b) {
  const toR = x => x * Math.PI / 180, y = Math.sin(toR(b[1] - a[1])) * Math.cos(toR(b[0])),
    x = Math.cos(toR(a[0])) * Math.sin(toR(b[0])) - Math.sin(toR(a[0])) * Math.cos(toR(b[0])) * Math.cos(toR(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function orient(geom, pt, endAtPoint) {
  const g = (geom || []).map(c => [c.lat, c.lon]); if (g.length < 2) return g;
  const d = a => Math.hypot(a[0] - pt[0], a[1] - pt[1]);
  const firstNear = d(g[0]) <= d(g[g.length - 1]);
  if (endAtPoint === firstNear) g.reverse();
  return g;
}

function initMap() {
  map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([52.632, 1.245], 12);
  const t = MAPDATA.tiles;
  L.tileLayer(t.url, { maxZoom: t.max_zoom, attribution: t.attribution, referrerPolicy: "strict-origin-when-cross-origin" }).addTo(map);
  for (const [k] of LAYERS) L_[k] = L.layerGroup();
  const tg = document.getElementById("layer-toggles");
  for (const [k, label, on] of LAYERS) {
    const cb = el("input", { type: "checkbox", id: "ly-" + k }); cb.checked = on;
    cb.onchange = () => cb.checked ? L_[k].addTo(map) : map.removeLayer(L_[k]);
    tg.appendChild(el("label", { class: "ly" }, cb, " " + label));
    if (on) L_[k].addTo(map);
  }
  const zt = document.getElementById("zoomto");
  zt.appendChild(el("button", { type: "button", class: "small", text: "All" }));
  zt.lastChild.onclick = () => map.fitBounds(L.latLngBounds(SITES.sites.map(s => [s.feature_reference.latitude, s.feature_reference.longitude])).pad(0.25));
  for (const s of SITES.sites) {
    const b = el("button", { type: "button", class: "small", text: s.name.replace(" Car Park", "").replace(" Retail Park", "").replace("Norwich", "").trim() });
    b.onclick = () => zoomSite(s.id); zt.appendChild(b);
  }
  drawStatic();
  renderLegend();
  map.fitBounds(L.latLngBounds(SITES.sites.map(s => [s.feature_reference.latitude, s.feature_reference.longitude])).pad(0.25));
}
function zoomSite(id) {
  const s = SITES.sites.find(x => x.id === id);
  if (activeTab !== "dash") showTab("dash");
  map.fitBounds(L.latLng(s.feature_reference.latitude, s.feature_reference.longitude).toBounds(1700));
}

function sitePopup(s) {
  const st = view && view.site_status ? view.site_status[s.id] : null;
  return el("div", { class: "pop" },
    el("strong", { text: s.name }), el("div", { class: "meta", text: "Desk-verified mapping · not field inspected" }),
    el("div", { text: "Status: " + (st ? st.state : "no data loaded") }),
    el("div", { class: "meta", text: st ? st.detail : "" }),
    el("div", null, link(s.identity_source, "Operator page")));
}
function drawStatic() {
  const pts = allPoints();
  const sampledWays = new Map(pts.filter(p => p.tier !== "excluded").map(p => [p.osm_way_id, p]));
  for (const s of SITES.sites) {
    const c = [s.feature_reference.latitude, s.feature_reference.longitude];
    L.circle(c, { radius: 805, fx: 1, color: "#1f5f8b", weight: 1.5, dashArray: "6 6", fillOpacity: 0.03 }).bindTooltip(tipEl(s.name + " · 805 m zone")).addTo(L_.zones);
    const m = L.circleMarker(c, { radius: 9, color: "#fff", weight: 2, fillColor: "#1d2327", fillOpacity: 1 });
    m.bindTooltip(tipEl(s.name), { direction: "top" }); m.bindPopup(() => sitePopup(s)); m.addTo(L_.carparks);
    const exits = [...(s.confirmed_exits || [])];
    for (const p of s.individual_parking_candidates || []) for (const x of p.exit_connections || []) exits.push(x);
    for (const [arr, kind] of [[exits, "exit"], [s.entrances || [], "entry"]]) for (const x of arr) {
      const g = orient(x.connector_geometry, [x.latitude, x.longitude], kind === "exit");
      if (g.length < 2) continue;
      const oneway = x.oneway === "yes";
      const line = L.polyline(g, { color: kind === "exit" ? "#1b7f4b" : "#2b62c4", weight: 5, dashArray: oneway ? (kind === "entry" ? "6 5" : null) : "2 6" });
      line.bindPopup(() => el("div", { class: "pop" }, el("strong", { text: (kind === "exit" ? "Exit " : "Entrance ") + x.id }),
        el("div", { text: "Joins " + x.road_reached + " · one-way: " + x.oneway }),
        el("div", { class: "meta", text: x.verification_level.replaceAll("_", " ") + " · field inspected: no" }), link(x.source_url, "OSM way " + x.connector_osm_way_id)));
      line.addTo(L_.exits);
      if (oneway) L.marker(g[g.length - 1], { icon: arrowIcon(bearing(g[g.length - 2], g[g.length - 1]) - 90, kind), interactive: false }).addTo(L_.exits);
    }
  }
  // zone roads
  for (const f of (MAPDATA.zone_roads || {}).features || []) {
    const p = f.properties;
    const sp = sampledWays.get(p.osm_way_id);
    const lines = f.geometry.coordinates.map(l => l.map(c => [c[1], c[0]]));
    const minor = p.rank >= 7 && !sp && p.tier === 3;
    const layer = sp ? L_.monitored : (minor ? L_.minor : L_.unmonitored);
    const style = sp ? { color: sp.tier === "core" ? "#c46a12" : "#7a3fb0", weight: 6, opacity: 0.85 }
      : minor ? { color: "#9aa0a6", weight: 1.5, opacity: 0.6 }
      : { color: p.tier === 1 ? "#1b7f4b" : "#4b5359", weight: p.tier === 2 ? 3.5 : 2, opacity: p.tier === 2 ? 0.9 : 0.6, dashArray: "2 6" };
    const pl = L.polyline(lines, style);
    pl.bindPopup(() => el("div", { class: "pop" }, el("strong", { text: p.name || p.ref || "Unnamed " + p.highway }),
      el("div", { class: "meta", text: `${p.highway}${p.ref ? " · " + p.ref : ""} · one-way: ${p.oneway} · priority tier ${p.tier}` }),
      el("div", { text: sp ? `Sample point ${sp.id} (${sp.tier === "core" ? "tested core" : "untested candidate"}) on this way` : "No sample point on this way: not monitored." }),
      el("div", { class: "meta", text: "Zones: " + p.site_ids.map(siteName).join(", ") }), link(p.source_url, "OSM way " + p.osm_way_id)));
    pl.addTo(layer);
  }
  drawSamples();
}
function drawSamples() {
  L_.samples.clearLayers(); L_.live.clearLayers(); L_.incidents.clearLayers();
  for (const p of allPoints()) {
    const r = reading(p.id);
    const col = p.tier === "core" ? "#c46a12" : p.tier === "extended" ? "#7a3fb0" : "#9aa0a6";
    let fill = p.tier === "extended" ? "#ffffff" : col;
    if (r && r.status === "ok") fill = col; else if (r && r.status === "unknown") fill = "#ffffff";
    const m = L.circleMarker([p.latitude, p.longitude], { radius: 6, color: col, weight: 2.5, fillColor: fill, fillOpacity: 1 });
    m.bindTooltip(tipEl(p.id + (r ? " · " + r.status : "")));
    m.bindPopup(() => samplePopup(p));
    m.addTo(L_.samples);
    if (r && r.segment && r.segment.length > 1) {
      L.polyline(r.segment, { color: view.synthetic ? "#d4a900" : "#1f5f8b", weight: 9, opacity: 0.35 })
        .bindTooltip(tipEl("Segment returned by " + (view.synthetic ? "SYNTHETIC fixture" : "TomTom") + " for " + p.id + " (this refresh only)")).addTo(L_.live);
    }
  }
  if (view && view.incidents && view.incidents.items) for (const i of view.incidents.items) {
    if (!i.firstPoint) continue;
    const m = L.circleMarker([i.firstPoint.lat, i.firstPoint.lon], { radius: 7, color: "#a3141c", weight: 2, fillColor: view.synthetic ? "#ffd84d" : "#ff7a80", fillOpacity: 0.9 });
    m.bindPopup(() => el("div", { class: "pop" }, el("strong", { text: `${i.iconCategoryLabel ?? ""} (${i.iconCategory})` }),
      el("div", { text: (i.events || []).map(e => e.description).join("; ") }),
      el("div", { class: "meta", text: `${i.from ?? "?"} → ${i.to ?? "?"} · delay ${i.delay ?? "?"} s · magnitude ${i.magnitudeLabel ?? ""}` }),
      el("div", { class: "meta", text: view.synthetic ? "SYNTHETIC" : "TomTom, transient. Not matched to sites (gated)." })));
    m.addTo(L_.incidents);
  }
  drawInvestigations();
}
function drawInvestigations() {
  L_.invs.clearLayers();
  for (const inv of INVS.filter(i => !["closed", "invalidated"].includes(i.status))) for (const sid of inv.site_ids) {
    const s = SITES.sites.find(x => x.id === sid); if (!s) continue;
    const m = L.circleMarker([s.feature_reference.latitude + 0.0009, s.feature_reference.longitude], { radius: 8, color: "#8a1c1c", weight: 3, fillColor: "#fde8e8", fillOpacity: 1 });
    m.bindTooltip(tipEl(inv.id + ": " + inv.title)); m.on("click", () => showTab("inv")); m.addTo(L_.invs);
  }
}
function samplePopup(p) {
  const r = reading(p.id);
  const box = el("div", { class: "pop" }, el("strong", { text: p.road }), el("div", { class: "meta", text: p.id + " · " + (p.tier === "core" ? "tested core point" : p.tier === "extended" ? "untested candidate (extended refresh)" : "excluded") }));
  if (p.note) box.appendChild(el("div", { class: "meta", text: p.note }));
  if (!r) box.appendChild(el("div", { class: "muted", text: p.tier === "excluded" ? (p.test_status || "") : "No reading loaded." }));
  else if (r.status !== "ok") box.appendChild(el("div", { text: "Unknown: " + r.reason }));
  else { box.appendChild(fieldTable(r)); if (r.geometry_warning) box.appendChild(el("div", { class: "reason", text: r.geometry_warning })); box.appendChild(el("div", { class: "meta", text: "Received " + fmtTime(r.received_at_utc) + " · source time unknown" })); }
  box.appendChild(link(p.source_url, "OSM way " + p.osm_way_id));
  return box;
}
function renderLegend() {
  const lg = document.getElementById("legend"); clear(lg);
  const item = (cls, t) => el("span", { class: "li" }, el("span", { class: "sw " + cls }), t);
  lg.append(item("sw-cp", "Car park"), item("sw-zone", "805 m zone"), item("sw-exit", "Exit (arrow = one-way)"), item("sw-entry", "Entrance"),
    item("sw-core", "Road with tested sample"), item("sw-ext", "Road with candidate sample"), item("sw-gap", "Zone road, not monitored"),
    item("sw-live", "Segment returned this refresh"), item("sw-inc", "Incident"));
}

// ---------- compact cards ------------------------------------------------------------
const STATUS_CLASS = { normal: "st-normal", congested: "st-cong", severe: "st-severe", insufficient: "st-insuff", closure: "st-severe", live: "st-live", none: "st-none" };
function renderCards() {
  const host = document.getElementById("cards"); clear(host);
  for (const s of SITES.sites) {
    const st = view && view.site_status ? view.site_status[s.id] : { state: "no data loaded", class: "none", detail: MODE === "static" ? "Public preview: no live data." : "Press Refresh." };
    const pts = allPoints().filter(p => (p.site_ids || []).includes(s.id) && p.tier !== "excluded");
    const roads = [...new Set(pts.map(p => p.road.replace(/ \(.*\)$/, "")))];
    const open = INVS.filter(i => i.site_ids.includes(s.id) && !["closed", "invalidated"].includes(i.status)).length;
    const card = el("article", { class: "ccard" + (view && view.synthetic ? " syn" : "") },
      el("div", { class: "ccard-h" }, el("h3", { text: s.name }), el("span", { class: "pill " + (STATUS_CLASS[st.class] || "st-none"), text: st.state })),
      el("div", { class: "meta", text: st.detail || "" }),
      el("div", { class: "kv2" },
        el("span", { class: "k", text: "Roads" }), el("span", { text: roads.join(", ") || "none" }),
        el("span", { class: "k", text: "Delay" }), el("span", { text: st.synthetic_delay_s !== undefined ? `${st.synthetic_delay_s} s (SYNTHETIC)` : (view && !view.synthetic ? "not derived (licence); see readings" : "—") }),
        el("span", { class: "k", text: "Investigations" }), el("span", { text: open ? `${open} open` : "none open" }),
        el("span", { class: "k", text: "Last refresh" }), el("span", { text: view ? fmtTime(view.cycle_finished_at_utc) + (view.synthetic ? " (synthetic)" : "") : "—" }),
        el("span", { class: "k", text: "Coverage" }), el("span", { text: `${pts.filter(p => p.tier === "core").length} tested + ${pts.filter(p => p.tier === "extended").length} candidate samples` })),
      s.id === "castle_quarter_2" ? el("div", { class: "notice notice-warn", text: "Direct exit flow unavailable (provider returned HTTP 400). Nearby context only." }) : null,
      s.id === "ikea_hall_road" ? el("div", { class: "notice notice-info", text: "Hall Road sample = surrounding road, not exit flow." }) : null,
      el("div", { class: "ccard-a" }, btn("Map", () => zoomSite(s.id)), btn("Detail", () => { showTab("detail"); document.getElementById("site-" + s.id).open = true; document.getElementById("site-" + s.id).scrollIntoView(); })));
    host.appendChild(card);
  }
}
function btn(t, f) { const b = el("button", { type: "button", class: "small", text: t }); b.onclick = f; return b; }

// ---------- site detail (Build 1 views, kept for traceability) -------------------------
const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; }
function schematic(site, points) {
  const lines = [], dots = [];
  const exits = [...(site.confirmed_exits || [])];
  for (const c of site.individual_parking_candidates || []) for (const x of c.exit_connections || []) exits.push(x);
  for (const x of exits) lines.push({ kind: "exit", oneway: x.oneway === "yes", g: orient(x.connector_geometry, [x.latitude, x.longitude], true), label: x.id });
  for (const x of site.entrances || []) lines.push({ kind: "entry", oneway: x.oneway === "yes", g: orient(x.connector_geometry, [x.latitude, x.longitude], false), label: x.id });
  for (const p of points.filter(p => (p.site_ids || []).includes(site.id))) dots.push({ kind: p.tier === "core" ? "sample" : p.tier === "extended" ? "ext" : "excl", lat: p.latitude, lon: p.longitude, label: p.id });
  const fr = site.feature_reference;
  const all = [...lines.flatMap(l => l.g), ...dots.map(d => [d.lat, d.lon]), [fr.latitude, fr.longitude]];
  const lat0 = all.reduce((a, c) => a + c[0], 0) / all.length, k = Math.cos(lat0 * Math.PI / 180);
  const xs = all.map(c => c[1] * k), ys = all.map(c => c[0]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.0012);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const W = 320, H = 200, pad = 22, scale = Math.min((W - 2 * pad) / span, (H - 2 * pad) / span);
  const P = (lat, lon) => [W / 2 + (lon * k - cx) * scale, H / 2 - (lat - cy) * scale];
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "schem", role: "img", "aria-label": `Schematic of ${site.name}` });
  const defs = svg("defs");
  for (const [id, cls] of [["ah-exit-" + site.id, "m-exit"], ["ah-entry-" + site.id, "m-entry"]]) {
    const m = svg("marker", { id, viewBox: "0 0 10 10", refX: "7", refY: "5", markerUnits: "userSpaceOnUse", markerWidth: "11", markerHeight: "11", orient: "auto-start-reverse" });
    m.appendChild(svg("path", { d: "M0,0 L10,5 L0,10 z", class: cls })); defs.appendChild(m);
  }
  s.appendChild(defs); s.appendChild(svg("rect", { x: 0, y: 0, width: W, height: H, class: "schem-bg" }));
  const [px, py] = P(fr.latitude, fr.longitude); const tp = svg("text", { x: px, y: py + 4, class: "plabel", "text-anchor": "middle" }); tp.textContent = "P"; s.appendChild(tp);
  for (const l of lines) {
    if (l.g.length < 2) continue;
    const pl = svg("polyline", { points: l.g.map(c => P(c[0], c[1]).map(v => v.toFixed(1)).join(",")).join(" "), class: "ln ln-" + l.kind + (l.oneway ? "" : " ln-untagged"), "marker-end": l.oneway ? `url(#ah-${l.kind}-${site.id})` : "none" });
    const t = svg("title"); t.textContent = l.label; pl.appendChild(t); s.appendChild(pl);
  }
  for (const d of dots) { const [x, y] = P(d.lat, d.lon); const c = svg("circle", { cx: x, cy: y, r: 5, class: "dot dot-" + d.kind }); const t = svg("title"); t.textContent = d.label; c.appendChild(t); s.appendChild(c); }
  const px50 = 50 / 111320 * scale;
  s.appendChild(svg("line", { x1: 10, y1: H - 10, x2: 10 + px50, y2: H - 10, class: "scale" }));
  const st = svg("text", { x: 12 + px50, y: H - 7, class: "slabel" }); st.textContent = "50 m"; s.appendChild(st);
  return s;
}
function fieldTable(r) {
  const t = el("table", { class: "fields" }), f = r.fields, u = r.units || {};
  for (const k of ["currentSpeed", "freeFlowSpeed", "currentTravelTime", "freeFlowTravelTime", "confidence", "roadClosure"])
    t.appendChild(el("tr", null, el("th", { scope: "row", text: k }), el("td", { class: (k === "roadClosure" && f[k] === true) ? "closure" : null, text: String(f[k]) + (["mph", "s"].includes(u[k]) ? " " + u[k] : "") })));
  return t;
}
function sampleBlock(p) {
  const r = reading(p.id);
  const box = el("div", { class: "sample" + (p.tier === "extended" ? " ext" : "") },
    el("div", { class: "sample-h" }, el("strong", { text: p.road }), " ", el("span", { class: "pid", text: p.id }), " ",
      el("span", { class: "tag " + (p.tier === "core" ? "" : "tag-muted"), text: p.tier === "core" ? "tested" : p.tier === "extended" ? "candidate" : "excluded" })),
    el("div", { class: "role", text: (r && r.role_label) || p.role.replaceAll("_", " ") }));
  if (p.note) box.appendChild(el("div", { class: "meta", text: p.note }));
  if (p.tier === "excluded") { box.classList.add("excluded"); box.appendChild(el("p", { class: "reason", text: "Excluded from requests: " + p.test_status })); return box; }
  if (!r) { box.appendChild(el("p", { class: "muted", text: p.tier === "extended" && view ? "Not in this refresh (extended refresh only)." : "No data loaded." })); return box; }
  if (r.status !== "ok") { box.classList.add("unknown"); box.appendChild(el("p", { class: "reason" }, el("strong", { text: "Unknown. " }), r.reason)); }
  else {
    box.appendChild(fieldTable(r));
    if (r.fields.roadClosure === true) box.appendChild(el("p", { class: "closure-note", text: "Provider reports roadClosure = true on the sampled segment. Verify before treating the exit as blocked." }));
    if (r.geometry_warning) box.appendChild(el("p", { class: "reason", text: r.geometry_warning }));
    else if (r.geometry_residual_m != null) box.appendChild(el("p", { class: "meta", text: `Segment ${r.geometry_residual_m} m from sample point (≤30 m check passed)` }));
  }
  box.appendChild(el("p", { class: "meta", text: `Received ${fmtTime(r.received_at_utc)}${r.http_date ? " · HTTP Date " + r.http_date : ""} · Source observation time: unknown${r.attempts > 1 ? " · " + r.attempts + " attempts" : ""}` }));
  return box;
}
function exitRow(x, kind) {
  return el("li", null, el("span", { class: "ar " + kind, text: x.oneway !== "yes" ? "↔" : (kind === "exit" ? "↗" : "↘") }), " ",
    el("strong", { text: x.id }), ` → ${x.road_reached} · one-way: ${x.oneway} · `, link(x.source_url, "OSM way " + x.connector_osm_way_id),
    el("div", { class: "meta", text: `${x.verification_level.replaceAll("_", " ")} · field inspected: no · temporary restrictions: not verified` }));
}
function renderDetail() {
  const host = document.getElementById("sites"); clear(host);
  const pts = allPoints();
  for (const s of SITES.sites) {
    const d = el("details", { class: "card", id: "site-" + s.id });
    d.appendChild(el("summary", null, el("h3", { text: s.name }), el("span", { class: "tag", text: "Desk-verified mapping" }), el("span", { class: "tag tag-muted", text: "Not field inspected" })));
    const body = el("div", { class: "detail-body" });
    body.appendChild(el("div", null, schematic(s, pts)));
    const right = el("div");
    const ex = el("ul", { class: "exits" });
    for (const x of s.confirmed_exits || []) ex.appendChild(exitRow(x, "exit"));
    for (const x of s.entrances || []) ex.appendChild(exitRow(x, "entry"));
    right.append(el("h4", { text: "Mapped exits and entrances" }), ex);
    if (s.individual_parking_candidates) {
      const ul = el("ul", { class: "children" });
      for (const c of s.individual_parking_candidates) ul.appendChild(el("li", null, el("strong", { text: c.name }), ` (${c.id}) · exits: ${(c.exit_connections || []).map(x => x.id + " → " + x.road_reached).join("; ") || (c.mapped_exit_ids || []).join(", ")}`));
      right.append(el("h4", { text: "Adjoining parking areas (shared road context)" }), ul);
    }
    body.appendChild(right);
    d.appendChild(body);
    d.appendChild(el("h4", { text: "Road samples" }));
    const sm = el("div", { class: "samples grid2" });
    for (const p of pts.filter(p => (p.site_ids || []).includes(s.id))) sm.appendChild(sampleBlock(p));
    d.appendChild(sm);
    const src = el("p", { class: "meta" }, "Identity: ");
    for (const [i, u] of (s.identity_sources || [s.identity_source]).entries()) { if (i) src.append(" · "); src.appendChild(link(u, new URL(u).hostname)); }
    d.appendChild(src);
    host.appendChild(d);
  }
}

// ---------- incidents list -----------------------------------------------------------
function renderIncidents() {
  const host = document.getElementById("incidents"); clear(host);
  if (!view) { host.appendChild(el("p", { class: "muted", text: "No incident data loaded." })); return; }
  const inc = view.incidents;
  if (!inc || inc.status !== "ok") { host.appendChild(el("p", { class: "reason" }, el("strong", { text: "Unknown. " }), (inc && inc.reason) || "No result.")); return; }
  host.appendChild(el("p", { class: "meta", text: `Received ${fmtTime(inc.received_at_utc)} · source time unknown · ${inc.items.length} incident(s)` }));
  if (!inc.items.length) { host.appendChild(el("p", { class: "muted", text: inc.empty_note })); return; }
  const t = el("table", { class: "tbl" });
  t.appendChild(el("thead", null, el("tr", null, ...["Type", "Magnitude", "Description", "From → To", "Roads", "delay s", "Start / end"].map(h => el("th", { text: h })))));
  const tb = el("tbody");
  for (const i of inc.items) tb.appendChild(el("tr", null, el("td", { text: `${i.iconCategoryLabel ?? ""} (${i.iconCategory})` }), el("td", { text: `${i.magnitudeLabel ?? ""} (${i.magnitudeOfDelay})` }),
    el("td", { text: (i.events || []).map(e => e.description).join("; ") }), el("td", { text: `${i.from ?? "?"} → ${i.to ?? "?"}` }),
    el("td", { text: (i.roadNumbers || []).join(", ") }), el("td", { text: i.delay ?? "" }), el("td", { text: `${i.startTime ? fmtTime(i.startTime) : "unknown"} / ${i.endTime ? fmtTime(i.endTime) : "unknown"}` })));
  t.appendChild(tb); host.appendChild(el("div", { class: "scroll" }, t));
}

// ---------- investigations -----------------------------------------------------------
function invCard(inv, compact) {
  const box = el("div", { class: "inv" + (inv.synthetic ? " syn" : "") },
    el("div", { class: "inv-h" }, el("strong", { text: inv.id + " · " + inv.title }), el("span", { class: "pill st-" + (inv.status === "open" ? "cong" : inv.status === "monitoring" ? "live" : "none"), text: inv.status })),
    el("div", { class: "meta", text: `${inv.site_ids.map(siteName).join(", ")} · roads: ${inv.roads.join(", ") || "not given"} · origin: ${inv.origin.replaceAll("_", " ")}` }),
    el("div", { class: "meta", text: `Reported time (as stated): ${inv.reported_time_raw || "not given"} · opened ${fmtTime(inv.created_at_utc)} · updated ${fmtTime(inv.updated_at_utc)}` }),
    el("div", { class: "meta", text: `${inv.evidence.length} evidence item(s) · ${inv.independent_families} independent producer(s)` }));
  if (!compact) {
    const ul = el("ul", { class: "plain ev" });
    for (const e of inv.evidence) ul.appendChild(el("li", null, el("span", { class: "meta", text: fmtTime(e.added_at_utc) + " · " + e.source_id + (e.lineage_family ? " (" + e.lineage_family + ")" : "") + " · " }),
      e.title ? el("span", { text: e.title + " " }) : null, e.link ? link(e.link, "source") : null, e.source_time_raw ? el("span", { class: "meta", text: " · source time: " + e.source_time_raw }) : null,
      e.note ? el("div", { text: e.note }) : null));
    box.appendChild(ul);
    if (MODE === "local") {
      const note = el("input", { type: "text", maxlength: "1000", placeholder: "Add a note", "aria-label": "Note" });
      const a = btn("Add note", async () => { if (!note.value.trim()) return; await invPost(`/api/investigations/${inv.id}/evidence`, { source_id: "owner_note", note: note.value }); });
      const t = btn("TomTom view inspected", async () => invPost(`/api/investigations/${inv.id}/evidence`, { source_id: "tomtom_flow", lineage_family: "tomtom", note: note.value || null }));
      const sel = el("select", { "aria-label": "Status" }, ...["open", "monitoring", "closed", "invalidated"].map(s => { const o = el("option", { value: s, text: s }); if (s === inv.status) o.selected = true; return o; }));
      sel.onchange = () => invPost(`/api/investigations/${inv.id}/status`, { status: sel.value });
      box.appendChild(el("div", { class: "inv-a" }, note, a, t, sel));
    }
  } else {
    box.appendChild(el("div", null, btn("Open", () => showTab("inv"))));
  }
  return box;
}
async function invPost(path, body) {
  try { const r = await api(path, { method: "POST", body: JSON.stringify(body) }); INVS = r.investigations; renderInvs(); }
  catch (e) { renderBanner("Investigation update failed: " + e.message, "banner-err"); }
}
function renderInvs() {
  const act = document.getElementById("active-inv"); clear(act);
  const open = INVS.filter(i => !["closed", "invalidated"].includes(i.status));
  if (!open.length) act.appendChild(el("p", { class: "muted", text: MODE === "static" ? "Investigations are private and stay on the owner's computer." : "None open. Open one from the Investigations tab." }));
  for (const i of open) act.appendChild(invCard(i, true));
  const all = document.getElementById("inv-list"); clear(all);
  if (!INVS.length) all.appendChild(el("p", { class: "muted", text: "None yet." }));
  for (const i of INVS) all.appendChild(invCard(i, false));
  renderCards(); if (map) drawInvestigations();
}
function initInvForm() {
  const host = document.getElementById("inv-sites");
  for (const s of SITES.sites) host.appendChild(el("label", { class: "chk" }, el("input", { type: "checkbox", value: s.id, name: "site" }), " " + s.name));
  document.getElementById("inv-note").textContent = (STATUS && STATUS.label_note || "") + " TomTom values are never stored; for TomTom you can only record that you inspected the live view.";
  const f = document.getElementById("inv-form");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(f);
    const body = { title: fd.get("title"), roads: String(fd.get("roads") || "").split(",").map(s => s.trim()).filter(Boolean),
      reported_time_raw: fd.get("reported_time_raw"), origin: fd.get("origin"), site_ids: [...f.querySelectorAll('input[name="site"]:checked')].map(c => c.value),
      source_id: fd.get("source_id"), link: fd.get("link") || null, source_time_raw: fd.get("source_time_raw") || null, note: fd.get("note") || null,
      lineage_family: { tomtom_flow: "tomtom", national_highways_rss: "national_highways", metoffice_rss: "met_office", owner_note: "owner" }[fd.get("source_id")] };
    if (body.source_id === "tomtom_flow") { body.link = null; body.source_time_raw = null; }
    if (body.source_id !== "tomtom_flow" && body.source_id !== "owner_note") body.evidence_title = body.title;
    const msg = document.getElementById("inv-msg");
    try { const r = await api("/api/investigations", { method: "POST", body: JSON.stringify(body) }); INVS = r.investigations; renderInvs(); msg.textContent = "Opened " + r.id + "."; f.reset(); }
    catch (e) { msg.textContent = "Not saved: " + e.message; }
  };
}

// ---------- correlation demo, evidence demo -----------------------------------------------
function renderCorr(d) {
  const host = document.getElementById("corr"); clear(host);
  host.appendChild(el("p", { class: "banner banner-syn small", text: d.banner + " — invented reports" }));
  for (const [k, c] of Object.entries(d.cases)) {
    const r = c.result;
    const labels = Object.entries(r.site_labels).filter(([, v]) => !v.startsWith("no significant") || k === "provider_failure");
    const box = el("div", { class: "case" }, el("strong", { text: k.replaceAll("_", " ") }), el("p", { class: "meta", text: c.description }));
    const ul = el("ul", { class: "plain" });
    if (!labels.length) ul.appendChild(el("li", { text: "No site matched: every site stays 'no significant disruption detected within measured coverage'." }));
    for (const [sid, lab] of labels) ul.appendChild(el("li", null, el("strong", { text: siteName(sid) + ": " }), lab));
    box.appendChild(ul);
    const extra = [];
    if (r.duplicates_suppressed) extra.push(`${r.duplicates_suppressed} duplicate report(s) suppressed`);
    for (const rec of r.records) { for (const x of rec.contradictions) extra.push(x); const b = rec.confidence_basis.filter(x => x.startsWith("independent") || x.includes("share an upstream")); extra.push(...b); }
    if (r.unmatched.length) extra.push(`${r.unmatched.length} report(s) matched no site`);
    if (extra.length) box.appendChild(el("p", { class: "meta", text: [...new Set(extra)].join(" · ") }));
    host.appendChild(box);
  }
  host.appendChild(el("p", { class: "caveat", text: Object.values(d.cases)[0].result.label_note }));
}
function renderEvidence(d) {
  const host = document.getElementById("evidence"); clear(host);
  const r = d.report;
  host.appendChild(el("p", { class: "banner banner-syn small", text: r.banner }));
  const dl = el("dl", { class: "kv" });
  const add = (k, v) => { dl.appendChild(el("dt", { text: k })); dl.appendChild(el("dd", { text: v })); };
  add("Case", `${r.case_id} · ${r.site_id} / ${r.exit_id}`); add("Final state", r.state); add("Evidence level", r.evidence_level);
  add("Onset interval", r.onset_interval_utc.map(fmtTime).join(" → ")); add("End interval", r.end_interval_utc.map(fmtTime).join(" → "));
  add("Monitoring gaps", r.monitoring_gaps_utc.map(fmtTime).join(", ") || "none");
  host.appendChild(dl);
  const ol = el("ol", { class: "hist" }); for (const [t, h] of r.state_history) ol.appendChild(el("li", null, el("span", { class: "meta", text: fmtTime(t) + " " }), h)); host.appendChild(ol);
}

// ---------- sources, Met Office, NH ---------------------------------------------------------
async function renderSources() {
  const d = await api("/api/sources");
  const t = document.getElementById("src-table"); clear(t);
  t.appendChild(el("thead", null, el("tr", null, ...["Source", "Status", "Type", "Retention", "Upstream producer", "Why / next step"].map(h => el("th", { text: h })))));
  const tb = el("tbody");
  for (const s of d.sources) tb.appendChild(el("tr", null, el("td", null, el("strong", { text: s.name }), s.links && s.links[0] ? el("div", null, link(s.links[0], "link")) : null),
    el("td", null, el("span", { class: "pill src-" + s.status, text: s.status })), el("td", { text: s.kind.replaceAll("_", " ") }),
    el("td", { text: s.retention.replaceAll("_", " ") }), el("td", { text: s.lineage_family + (s.authoritative ? " (authority)" : "") }),
    el("td", null, el("div", { text: s.reason }), el("div", { class: "meta", text: "Next: " + s.next_step }), s.tested ? el("div", { class: "meta", text: "Tested: " + s.tested }) : null)));
  t.appendChild(tb);
  const ms = document.getElementById("manual-sources"); clear(ms);
  for (const s of d.manual_sources) ms.appendChild(el("li", null, link(s.url, s.name), el("div", { class: "meta", text: s.note })));
}
function renderMet(m) {
  const host = document.getElementById("metoffice"); clear(host);
  if (m.synthetic) host.appendChild(el("p", { class: "banner banner-syn small", text: "SYNTHETIC feed fixture — not a real Met Office warning." }));
  if (m.status !== "ok") host.appendChild(el("p", { class: "reason" }, el("strong", { text: "Unknown. " }), m.reason));
  else {
    host.appendChild(el("p", { class: "meta" }, `${m.channel_title || "Feed"} · received ${fmtTime(m.received_at_utc)} · ${m.items.length} item(s) · `, link(m.source_url, "direct feed link")));
    if (!m.items.length) host.appendChild(el("p", { class: "muted", text: "The feed currently lists no warnings." }));
    for (const it of m.items) host.appendChild(el("div", { class: "met-item" }, el("strong", { text: it.title || "(untitled)" }), " ", it.link ? link(it.link, "open") : null, el("p", { text: it.description || "" }), el("p", { class: "meta", text: it.pubDate || "" })));
  }
  host.appendChild(el("p", { class: "caveat", text: m.scope_note }));
  host.appendChild(el("p", { class: "meta" }, m.attribution + " ", link(m.guide_url, "Met Office RSS terms")));
}
function renderNH(d) {
  const host = document.getElementById("nh"); clear(host);
  if (d.status !== "ok") { host.appendChild(el("p", { class: "reason" }, el("strong", { text: d.status === "pending" ? "Pending. " : "Unknown. " }), d.reason)); return; }
  host.appendChild(el("p", { class: "meta", text: `Received ${fmtTime(d.received_at_utc)} · ${d.items.length} item(s) · manual refresh only (Work runs the 15-minute watcher)` }));
  const labels = Object.entries(d.correlation.site_labels);
  host.appendChild(el("ul", { class: "plain" }, ...labels.map(([sid, l]) => el("li", null, el("strong", { text: siteName(sid) + ": " }), l))));
  for (const it of d.items.slice(0, 30)) host.appendChild(el("div", { class: "met-item" }, el("strong", { text: it.title || "" }), " ", it.link ? link(it.link, "source") : null,
    el("p", { class: "meta", text: "Published (as stated): " + ((it.published && it.published.raw) || "unknown") })));
  host.appendChild(el("p", { class: "caveat", text: "Missing alerts never prove the absence of disruption. A distant A47/A11 alert is not automatically relevant." }));
}

// ---------- health ------------------------------------------------------------------------
async function loadHealth() {
  const host = document.getElementById("health"); clear(host);
  let h; try { h = await api("/api/health"); } catch (e) { host.appendChild(el("p", { class: "reason", text: e.message })); return; }
  const sec = (title, ...kids) => el("section", { class: "panel" }, el("h2", { text: title }), ...kids);
  const q = el("table", { class: "tbl" }, el("thead", null, el("tr", null, ...["Product", "Month used / cap", "Today / cap", "Failed this month", "Last attempt", "Last success", "State"].map(x => el("th", { text: x })))));
  const tb = el("tbody");
  for (const [p, u] of Object.entries(h.quota)) {
    const la = (h.last_requests || {})[p] || {};
    tb.appendChild(el("tr", null, el("td", { text: p }), el("td", { text: `${u.month_used} / ${u.month_cap ?? "—"}` }), el("td", { text: `${u.day_used} / ${u.day_cap ?? "—"}` }),
      el("td", { text: String(u.month_failed_attempts) }), el("td", { text: la.last_attempt_utc ? fmtTime(la.last_attempt_utc) + " (" + la.last_status_class + ")" : "never" }),
      el("td", { text: la.last_success_utc ? fmtTime(la.last_success_utc) : "never" }), el("td", { text: u.state.disabled ? "DISABLED: " + u.state.disabled_reason : u.state.halted_until_utc ? "halted until " + fmtTime(u.state.halted_until_utc) : "available" })));
  }
  q.appendChild(tb);
  const budget = STATUS ? el("p", { class: "meta", text: `Per refresh: core ${STATUS.cycle_cost.tomtom_flow} flow + 1 incident; extended ${STATUS.cycle_cost_extended.tomtom_flow} flow + 1 incident. At the 19,000 / 2,400 monthly caps that is at most ${Math.min(Math.floor(19000 / STATUS.cycle_cost.tomtom_flow), 2400)} core or ${Math.min(Math.floor(19000 / STATUS.cycle_cost_extended.tomtom_flow), 2400)} extended refreshes a month, whichever cap runs out first (daily caps: 600 flow, 90 incident).` }) : null;
  const errs = el("ul", { class: "plain" }, ...(h.recent_errors.length ? h.recent_errors.map(e => el("li", { text: `${fmtTime(e.created_at_utc)} · ${e.product} · ${e.http_status_class} · ${e.mode}` })) : [el("li", { class: "muted", text: "No failed requests recorded." })]));
  const cred = el("ul", { class: "plain" }, ...Object.entries(h.credentials).map(([k, v]) => el("li", null, el("code", { text: k }), ": " + v)));
  const ret = el("ul", { class: "plain" }, ...Object.entries(h.retention).filter(([k]) => k !== "gates").map(([k, v]) => el("li", null, el("strong", { text: k + ": " }), v)),
    el("li", null, el("strong", { text: "Gates: " }), Object.entries(h.retention.gates).map(([k, v]) => `${k}=${v}`).join(", ")));
  host.append(sec("API quota and provider status", q, budget), sec("Scheduling", el("p", { text: h.scheduling.status }), el("p", { class: "meta", text: "Missed checks: " + h.scheduling.missed_checks })),
    sec("Recent request errors", errs), sec("Credentials (values never shown)", cred), sec("Data retention", ret));
}

// ---------- status bar in header subtitle -----------------------------------------------------
function renderSubtitle() {
  const s = document.getElementById("subtitle"); if (!STATUS || MODE === "static") return;
  const u = STATUS.usage;
  s.textContent = `${STATUS.credential.TOMTOM_API_KEY_loaded ? "TomTom key loaded" : "No TomTom key loaded"} · flow ${u.tomtom_flow.month_used}/${u.tomtom_flow.month_cap} this month · incidents ${u.tomtom_incident.month_used}/${u.tomtom_incident.month_cap} · monitoring off`;
}

// ---------- view lifecycle ------------------------------------------------------------------------
function setView(v) {
  view = v; viewExpiresAt = Date.now() + VIEW_TTL_MS;
  if (clearTimer) clearInterval(clearTimer);
  clearTimer = setInterval(() => { if (Date.now() >= viewExpiresAt) clearView(); else renderBanner(); }, 30000);
  renderAll();
}
function clearView() { view = null; if (clearTimer) { clearInterval(clearTimer); clearTimer = null; } renderAll(); }
function renderAll() { renderBanner(); renderCards(); renderDetail(); renderIncidents(); if (map) drawSamples(); renderSubtitle(); }
async function loadStatus() { STATUS = await api("/api/status"); renderSubtitle(); }

// ---------- wiring -----------------------------------------------------------------------------------
function armButton(b, labelIdle, labelArmed, run) {
  let armed = false;
  b.onclick = async () => {
    if (!armed) { armed = true; b.textContent = labelArmed(); b.classList.add("armed"); setTimeout(() => { armed = false; b.textContent = labelIdle; b.classList.remove("armed"); }, 6000); return; }
    armed = false; b.classList.remove("armed"); b.disabled = true; b.textContent = "Refreshing…";
    try { await run(); } catch (e) { renderBanner("Refresh failed: " + e.message, "banner-err"); }
    finally { b.disabled = false; b.textContent = labelIdle; await loadStatus(); }
  };
}
armButton(document.getElementById("btn-live"), "Refresh live (7 roads)", () => `Confirm: ${STATUS.cycle_cost.tomtom_flow} flow + 1 incident requests`, async () => setView(await api("/api/refresh?scope=core", { method: "POST" })));
armButton(document.getElementById("btn-live-ext"), "Extended refresh (17 roads)", () => `Confirm: ${STATUS.cycle_cost_extended.tomtom_flow} flow + 1 incident requests`, async () => setView(await api("/api/refresh?scope=extended", { method: "POST" })));
document.getElementById("btn-syn").onclick = async () => setView(await api("/api/synthetic?scenario=" + encodeURIComponent(document.getElementById("syn-scenario").value)));
document.getElementById("btn-clear").onclick = clearView;
document.getElementById("btn-met").onclick = async (ev) => { ev.target.disabled = true; try { renderMet(await api("/api/metoffice/refresh", { method: "POST" })); } catch (e) { renderBanner(e.message, "banner-err"); } finally { ev.target.disabled = false; } };
document.getElementById("btn-met-syn").onclick = async () => renderMet(await api("/api/synthetic/metoffice"));
document.getElementById("btn-nh").onclick = async (ev) => { ev.target.disabled = true; try { renderNH(await api("/api/sources/national_highways_rss/refresh", { method: "POST" })); } catch (e) { renderBanner(e.message, "banner-err"); } finally { ev.target.disabled = false; } };
document.getElementById("btn-ev").onclick = async () => renderEvidence(await api("/api/synthetic/evidence"));
document.getElementById("btn-corr").onclick = async () => renderCorr(await api("/api/synthetic/correlation"));
window.addEventListener("pagehide", () => { view = null; });

(async function init() {
  if (MODE === "static") { document.body.classList.add("static"); for (const n of document.querySelectorAll(".live-only")) n.hidden = true; }
  [SITES, STATUS, MAPDATA] = await Promise.all([api("/api/sites"), api("/api/status"), api("/api/map")]);
  try { INVS = (await api("/api/investigations")).investigations; } catch (e) { INVS = []; }
  initMap(); initInvForm(); renderAll(); renderInvs(); renderSources().catch(() => {});
})();
