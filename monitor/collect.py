"""FairExit public monitor: scheduled collection from permitted feeds.

Runs in GitHub Actions. Python standard library only. No credentials.

For each source in monitor/sources.json with publish=true:
  fetch (timeout, size cap, one retry) -> parse RSS -> Norfolk geo filter ->
  classify -> correlate against the six 805 m zones -> merge with the
  previously published state (first-observed times) -> write
  site/data/live/incidents.json and site/data/live/monitor-status.json.

One failed source never stops the others. A failed source is reported as
"unavailable", never as "no incidents". TomTom is never used here.

Usage:
  python -m monitor.collect --site site [--previous URL_OR_FILE] [--probe]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

from .incidents import (LABEL_INSUFFICIENT, LABEL_NONE, LABEL_NOTE, LABEL_ORDER, Report, SiteGeography, correlate)

UA = "FairExit-Norwich-Monitor/1.0 (+https://github.com/alexanderjackson1982-boop/fairexit-norwich)"
MAX_BYTES = 2_000_000
TIMEOUT_S = 20
NORWICH_BOX = (1.05, 52.55, 1.45, 52.72)  # min lon, min lat, max lon, max lat (wider than the zones)
NORFOLK_ROADS = {"A47", "A11", "A140", "A146", "A1074", "A1042", "A1067", "A1151", "A1270", "A143", "A12"}
KEEP_UNLISTED_HOURS = 6  # show "no longer listed" this long, then drop
STALE_AFTER_MIN = 45

KIND_RULES = [
    ("closure", re.compile(r"\b(closed|closure|road closed|carriageway closed|blocked)\b", re.I)),
    ("accident", re.compile(r"\b(accident|collision|crash|rtc|overturned)\b", re.I)),
    ("fire", re.compile(r"\b(fire|blaze)\b", re.I)),
    ("roadworks", re.compile(r"\b(roadworks?|lane closure|resurfacing|maintenance|works)\b", re.I)),
    ("congestion", re.compile(r"\b(congestion|queue|queuing|queueing|delays?|gridlock|slow traffic|stationary)\b", re.I)),
    ("breakdown", re.compile(r"\b(broken down|breakdown|vehicle fire|debris|obstruction|animal)\b", re.I)),
]
ROAD_RE = re.compile(r"\b([AMB]\d{1,4})\b")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def fetch(url: str, timeout: int = TIMEOUT_S) -> dict[str, Any]:
    """GET with size cap. Never raises. Returns status, content type, body, error class."""
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            body = r.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                return {"status": r.status, "error": "too_large", "body": b"", "ctype": r.headers.get("Content-Type"), "final_url": r.geturl()}
            return {"status": r.status, "error": None, "body": body, "ctype": r.headers.get("Content-Type"),
                    "final_url": r.geturl(), "http_date": r.headers.get("Date")}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "error": "http", "body": b"", "ctype": None, "final_url": url}
    except (socket.timeout, TimeoutError):
        return {"status": None, "error": "timeout", "body": b"", "ctype": None, "final_url": url}
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", None)
        cls = type(reason).__name__ if reason is not None else "URLError"
        if isinstance(reason, ssl.SSLError):
            cls = "SSL:" + (getattr(reason, "reason", None) or type(reason).__name__)
        elif isinstance(reason, socket.gaierror):
            cls = "DNS"
        return {"status": None, "error": "network:" + str(cls), "body": b"", "ctype": None, "final_url": url}
    except Exception as e:  # noqa: BLE001 - classify, never leak details
        return {"status": None, "error": "network:" + type(e).__name__, "body": b"", "ctype": None, "final_url": url}


def fetch_with_retry(url: str) -> dict[str, Any]:
    r = fetch(url)
    if r["error"] and (r["status"] is None or (r["status"] or 0) >= 500):
        time.sleep(3)
        r = fetch(url)
    return r


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def _local(tag: str) -> str:
    return tag.split("}")[-1].lower()


def parse_time(raw: str | None) -> dict[str, Any]:
    """Keep the source string; parse only when the time zone is explicit. Never invent UTC."""
    out = {"raw": raw, "utc": None}
    if not raw:
        return out
    s = raw.strip()
    try:
        dt = parsedate_to_datetime(s)
        if dt is not None and dt.tzinfo is not None:
            out["utc"] = dt.astimezone(timezone.utc).isoformat(timespec="seconds")
            return out
    except (TypeError, ValueError, IndexError):
        pass
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            out["utc"] = dt.astimezone(timezone.utc).isoformat(timespec="seconds")
    except ValueError:
        pass
    return out


def parse_rss(body: bytes) -> tuple[list[dict] | None, str | None, dict]:
    """Namespace-agnostic RSS parse. Returns (items, error, channel_meta)."""
    if b"<!doctype" in body[:4096].lower() or b"<!entity" in body.lower():
        return None, "DOCTYPE/ENTITY refused", {}
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None, "not well-formed XML", {}
    ch = next((c for c in root if _local(c.tag) == "channel"), None)
    if _local(root.tag) != "rss" or ch is None:
        return None, f"unexpected root <{_local(root.tag)}>", {}
    meta = {}
    for c in ch:
        t = _local(c.tag)
        if t in ("title", "copyright", "lastbuilddate", "pubdate", "ttl") and c.text:
            meta[t] = c.text.strip()[:300]
    items = []
    for it in ch:
        if _local(it.tag) != "item":
            continue
        f: dict[str, Any] = {}
        cats = []
        for c in it:
            t = _local(c.tag)
            txt = (c.text or "").strip()
            if t == "category" and txt:
                cats.append(txt)
            elif t == "point" and txt:  # georss:point "lat lon"
                parts = txt.replace(",", " ").split()
                if len(parts) >= 2:
                    f.setdefault("lat", parts[0]); f.setdefault("lon", parts[1])
            elif t in ("lat", "latitude"):
                f["lat"] = txt
            elif t in ("long", "lon", "longitude"):
                f["lon"] = txt
            elif txt:
                f[t] = txt
        f["categories"] = cats
        items.append(f)
    return items, None, meta


def _float(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def normalise(item: dict, src: dict, fetched_at: str) -> dict:
    title = (item.get("title") or "")[:300]
    desc = re.sub(r"<[^>]+>", " ", item.get("description") or "")
    desc = re.sub(r"\s+", " ", desc).strip()[:600]
    text = " ".join([title, desc, " ".join(item.get("categories") or []), item.get("road") or ""])
    kind = next((k for k, rx in KIND_RULES if rx.search(text)), "other")
    low = text.lower()
    if re.search(r"\b(cleared|reopened|re-opened|now open)\b", low):
        status = "cleared"
    elif re.search(r"\b(planned|will be closed|from \d|overnight closures?)\b", low) or src["kind"] == "roadworks":
        status = "planned_or_active"
    else:
        status = "active"
    roads = sorted(set(ROAD_RE.findall(" ".join([title, item.get("road") or "", " ".join(item.get("categories") or [])]))))
    lat, lon = _float(item.get("lat")), _float(item.get("lon"))
    point = {"lat": lat, "lon": lon} if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180 else None
    link = item.get("link") or ""
    link = link if link.startswith("https://") or link.startswith("http://") else None
    start = item.get("eventstart") or item.get("overallstart") or item.get("startdate") or item.get("start")
    end = item.get("eventend") or item.get("overallend") or item.get("enddate") or item.get("end")
    eid = item.get("guid") or item.get("reference") or link or hashlib.sha1(title.encode()).hexdigest()
    return {
        "source_id": src["id"], "lineage_family": src["lineage_family"], "authoritative": src["authoritative"],
        "source_event_id": eid[:200], "title": title, "summary": desc, "link": link,
        "kind": kind, "status": status, "roads": roads, "point": point,
        "county": item.get("county"), "region": item.get("region"),
        "published": parse_time(item.get("pubdate")), "event_start": parse_time(start), "event_end": parse_time(end),
        "fetched_at_utc": fetched_at,
    }


def in_norfolk(n: dict) -> bool:
    p = n.get("point")
    if p:
        return NORWICH_BOX[0] <= p["lon"] <= NORWICH_BOX[2] and NORWICH_BOX[1] <= p["lat"] <= NORWICH_BOX[3]
    if (n.get("county") or "").strip().lower() == "norfolk":
        return True
    # no coordinates and no county: keep only if it names a Norwich-area road AND mentions Norwich/Norfolk
    text = (n["title"] + " " + n["summary"]).lower()
    return bool(set(n["roads"]) & NORFOLK_ROADS) and ("norwich" in text or "norfolk" in text)


# ---------------------------------------------------------------------------
# Main collection
# ---------------------------------------------------------------------------

def load_previous(ref: str | None) -> dict:
    if not ref:
        return {}
    try:
        if ref.startswith("https://"):
            r = fetch(ref)
            return json.loads(r["body"]) if r["status"] == 200 and r["body"] else {}
        p = Path(ref)
        return json.loads(p.read_text()) if p.exists() else {}
    except (ValueError, OSError):
        return {}


def collect(site_dir: Path, previous: dict, registry: dict, now: datetime | None = None,
            fetcher=fetch_with_retry, probe: bool = False) -> tuple[dict, dict]:
    now = now or datetime.now(timezone.utc)
    now_s = now.isoformat(timespec="seconds")
    sites_raw = json.loads((site_dir / "data" / "sites.json").read_text())
    zone_roads = json.loads((site_dir / "data" / "map.json").read_text()).get("zone_roads")
    geo = SiteGeography(sites_raw, zone_roads)
    prev_status = {s["id"]: s for s in (previous.get("status", {}).get("sources") or [])}
    prev_items = {i["key"]: i for i in (previous.get("incidents", {}).get("items") or [])}

    source_status, normalised, weather = [], [], []
    for src in registry["sources"]:
        var = src.get("endpoint_variable")
        if var and os.environ.get(var, "").startswith("https://"):
            src = {**src, "endpoints": [os.environ[var]] + list(src["endpoints"])}
        st = {"id": src["id"], "provider": src["provider"], "kind": src["kind"], "publish": src["publish"],
              "authentication": src["authentication"], "refresh_minutes": src["refresh_minutes"],
              "licence": src["licence"], "licence_url": src["licence_url"], "retention": src["retention"],
              "coverage": src["coverage"], "error_handling": src["error_handling"],
              "endpoint": src["endpoints"][0] if src["endpoints"] else None,
              "last_successful_check_utc": (prev_status.get(src["id"]) or {}).get("last_successful_check_utc")}
        if not src["endpoints"]:
            if src.get("pending_reason"):
                st.update(operational_status="pending: feed address needed", detail=src["pending_reason"])
            else:
                st.update(operational_status="not polled", detail=src["licence"])
            source_status.append(st)
            continue
        if not src["publish"] and not probe:
            st.update(operational_status="restricted (not polled on schedule)", detail=src["licence"])
            source_status.append(st)
            continue
        result = None
        attempts = []
        for url in src["endpoints"]:
            r = fetcher(url)
            attempts.append({"url": url, "http_status": r["status"], "error": r["error"], "final_url": r.get("final_url")})
            items, err, meta = (parse_rss(r["body"]) if r["status"] == 200 and r["body"] else (None, r["error"] or f"HTTP {r['status']}", {}))
            result = {"url": url, "http_status": r["status"], "error": err, "items": items, "meta": meta,
                      "final_url": r.get("final_url"), "ctype": r.get("ctype")}
            if items is not None:
                break
        st["endpoint"] = result["url"]
        st["http_status"] = result["http_status"]
        st["attempts"] = attempts
        if result["items"] is None:
            st.update(operational_status="unavailable", detail=f"Fetch or parse failed ({result['error']}). Status unknown, not clear.")
            source_status.append(st)
            continue
        st["last_successful_check_utc"] = now_s
        st["items_in_feed"] = len(result["items"])
        st["channel_copyright"] = result["meta"].get("copyright")
        if not src["publish"]:
            st.update(operational_status="reachable; restricted (content not displayed)", detail=src["licence"])
            source_status.append(st)
            continue
        if src["kind"] == "weather":
            for it in result["items"]:
                weather.append({"title": (it.get("title") or "")[:200], "link": it.get("link"), "published": parse_time(it.get("pubdate")),
                                "source_id": src["id"], "attribution": src["attribution"]})
            st.update(operational_status="operational", detail=f"{len(result['items'])} regional warning(s)")
            source_status.append(st)
            continue
        norm = [normalise(it, src, now_s) for it in result["items"]]
        local = [n for n in norm if in_norfolk(n)]
        st.update(operational_status="operational", detail=f"{len(result['items'])} item(s) in feed; {len(local)} in the Norwich area")
        st["items_norwich_area"] = len(local)
        normalised.extend(local)
        source_status.append(st)

    # correlate (TomTom never present here)
    # named roads: match mapped zone street names in the report text (e.g. "Hall Road")
    names = sorted({(f["properties"].get("name") or "") for f in (zone_roads or {}).get("features", [])
                    if f["properties"].get("name") and len(f["properties"]["name"]) >= 6}, key=len, reverse=True)
    name_rx = [(nm, re.compile(r"\b" + re.escape(nm) + r"\b", re.I)) for nm in names]
    for n in normalised:
        text = n["title"] + " " + n["summary"]
        n["roads"] = sorted(set(n["roads"]) | {nm for nm, rx in name_rx if rx.search(text)})

    reports = [Report(source_id=n["source_id"], lineage_family=n["lineage_family"], authoritative=n["authoritative"],
                      source_event_id=n["source_event_id"], title=n["title"],
                      kind=n["kind"] if n["kind"] in ("closure", "roadworks", "accident", "congestion") else "other",
                      status="cleared" if n["status"] == "cleared" else ("planned" if n["status"] == "planned_or_active" else "active"),
                      fetched_at_utc=now_s, roads=n["roads"], point=n["point"],
                      event_time=n["event_start"] if n["event_start"]["raw"] else None, published=n["published"], link=n["link"])
               for n in normalised]
    incident_sources_ok = {s["id"]: s.get("operational_status") == "operational" for s in source_status
                           if s["publish"] and s["kind"] != "weather" and s.get("endpoint")}
    corr = correlate(reports, geo, None, incident_sources_ok)

    # build published items: one per correlated record, keeping first-observed across runs
    by_event = {(n["source_id"], n["source_event_id"]): n for n in normalised}
    items = []
    for rec in corr["records"] + corr["unmatched"]:
        key = rec["incident_id"]
        prev = prev_items.get(key, {})
        srcs = []
        for s in rec["sources"]:
            n = next((v for (sid, _), v in by_event.items() if sid == s["source_id"] and v["title"] == s["title"]), None)
            srcs.append({"source_id": s["source_id"], "lineage_family": s["lineage_family"], "authoritative": s["authoritative"],
                         "title": s["title"], "summary": (n or {}).get("summary"), "link": s["link"],
                         "published": s["published"], "event_start": (n or {}).get("event_start"), "event_end": (n or {}).get("event_end"),
                         "kind": (n or {}).get("kind", s["kind"]), "status": (n or {}).get("status", s["status"])})
        pt = next((n["point"] for n in normalised if n["title"] in {s["title"] for s in rec["sources"]} and n["point"]), None)
        items.append({
            "key": key, "listed": True, "first_observed_utc": prev.get("first_observed_utc") or now_s, "last_seen_utc": now_s,
            "site_ids": rec["site_ids"], "evidence_label": rec["evidence_label"], "potential_exit_impact": rec["potential_exit_impact"],
            "roads": rec["roads"], "point": pt, "contradictions": rec["contradictions"], "confidence_basis": rec["confidence_basis"],
            "reported_event_time": rec["reported_event_time"], "sources": srcs,
            "status": "cleared" if all(s["status"] == "cleared" for s in srcs) else ("planned or active" if all(s["status"] == "planned_or_active" for s in srcs) else "active"),
            "relevant": bool(rec["site_ids"]),
        })
    seen = {i["key"] for i in items}
    for k, p in prev_items.items():
        if k in seen or not p.get("last_seen_utc"):
            continue
        if now - datetime.fromisoformat(p["last_seen_utc"]) <= timedelta(hours=KEEP_UNLISTED_HOURS):
            items.append({**p, "listed": False, "status": "no longer listed by source"})

    # site summaries (only currently listed incidents count)
    site_summary = {}
    for sid in geo.sites:
        labs = [i["evidence_label"][sid] for i in items if i["listed"] and sid in i["evidence_label"]]
        n_rel = sum(1 for i in items if i["listed"] and sid in i["site_ids"])
        label = min(labs, key=LABEL_ORDER.index) if labs else corr["site_labels"][sid]
        site_summary[sid] = {"label": label, "incidents": n_rel}

    published = {
        "generated_at_utc": now_s,
        "synthetic": False,
        "kind": "live_public_monitor",
        "label_note": LABEL_NOTE,
        "traffic_measurements": "Unavailable on the public site. TomTom speed data may not be stored or redistributed under its licence; it is shown only on the owner's local app.",
        "coverage_note": "Incidents come from National Highways open data (strategic roads such as the A47 and A11). Local streets, police, fire, council and news sources are not yet covered. No listed incident does not mean no disruption.",
        "site_summary": site_summary,
        "items": sorted(items, key=lambda i: (not i["relevant"], not i["listed"], i["first_observed_utc"])),
        "weather": weather,
        "duplicates_suppressed": corr["duplicates_suppressed"],
    }
    status = {
        "generated_at_utc": now_s,
        "last_successful_update_utc": now_s if any(s.get("operational_status") == "operational" for s in source_status) else (previous.get("status") or {}).get("last_successful_update_utc"),
        "incident_sources_operational": sum(1 for v in incident_sources_ok.values() if v),
        "last_incident_update_utc": now_s if any(incident_sources_ok.values()) else (previous.get("status") or {}).get("last_incident_update_utc"),
        "stale_after_minutes": STALE_AFTER_MIN,
        "schedule": "Every 15 minutes, 06:00 to 23:59 UTC, best effort (GitHub may delay or skip runs).",
        "sources": source_status,
        "tomtom_used": False,
        "synthetic": False,
    }
    return published, status


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", type=Path, default=Path("site"))
    ap.add_argument("--registry", type=Path, default=Path(__file__).with_name("sources.json"))
    ap.add_argument("--previous-incidents", default=None)
    ap.add_argument("--previous-status", default=None)
    ap.add_argument("--probe", action="store_true", help="also health-check restricted sources (status only)")
    a = ap.parse_args(argv)
    registry = json.loads(a.registry.read_text())
    prev = {"incidents": load_previous(a.previous_incidents), "status": load_previous(a.previous_status)}
    pub, status = collect(a.site, prev, registry, probe=a.probe)
    out = a.site / "data" / "live"
    out.mkdir(parents=True, exist_ok=True)
    (out / "incidents.json").write_text(json.dumps(pub, ensure_ascii=False, separators=(",", ":")))
    (out / "monitor-status.json").write_text(json.dumps(status, ensure_ascii=False, separators=(",", ":")))
    # Job summary: operational facts only
    for s in status["sources"]:
        print(f"{s['id']}: {s.get('operational_status')} http={s.get('http_status')} items={s.get('items_in_feed')} norwich={s.get('items_norwich_area')}")
    rel = [i for i in pub["items"] if i["relevant"] and i["listed"]]
    print(f"incidents published: {len(pub['items'])} (relevant to a site: {len(rel)}); duplicates suppressed: {pub['duplicates_suppressed']}")
    print("site labels: " + "; ".join(f"{k}={v['label']}" for k, v in pub["site_summary"].items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
