"""Common incident record, correlation and evidence labels (Build 2).

Deterministic, transparent rules. Labels describe the strength of evidence for
a road disruption near a site. They are never proof that vehicles were trapped
or that a parking charge should be cancelled.

TomTom content is never fed into correlation while the
automated_tomtom_correlation gate is closed.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

class PersistenceRefused(PermissionError):
    """Raised when restricted content is offered to correlation."""

ZONE_RADIUS_M = 805.0
CLUSTER_DISTANCE_M = 200.0
EXIT_MATCH_M = 40.0
CLUSTER_WINDOW = timedelta(minutes=30)
MAJOR_ROADS = ("A47", "A11", "A140", "A146", "A1074", "A147")

LABEL_CONFIRMED = "confirmed disruption"
LABEL_PROBABLE = "probable disruption"
LABEL_POSSIBLE = "possible disruption"
LABEL_INSUFFICIENT = "insufficient evidence"
LABEL_NONE = "no significant disruption detected within measured coverage"
LABEL_ORDER = [LABEL_CONFIRMED, LABEL_PROBABLE, LABEL_POSSIBLE, LABEL_INSUFFICIENT, LABEL_NONE]
LABEL_NOTE = "Evidence labels describe road conditions near a site. They do not prove a vehicle was trapped or that a charge should be cancelled."

IMPACT_RANK = {"exit_connector": 0, "access_road": 1, "zone_road": 2, "major_road_in_zone": 3, "zone_only": 4}


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat0 = math.radians((a[0] + b[0]) / 2)
    return math.hypot(math.radians(b[1] - a[1]) * 6_371_000 * math.cos(lat0), math.radians(b[0] - a[0]) * 6_371_000)


def _norm(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


@dataclass
class Report:
    """One normalised report from one source (input to correlation)."""

    source_id: str
    lineage_family: str
    authoritative: bool
    source_event_id: str | None
    title: str | None
    kind: str                 # closure | roadworks | accident | congestion | weather | other
    status: str               # active | cleared | planned | unknown
    fetched_at_utc: str
    roads: list[str] = field(default_factory=list)
    point: dict | None = None  # {"lat":..,"lon":..}
    event_time: dict | None = None  # {"raw":..,"utc":..}
    published: dict | None = None
    link: str | None = None
    synthetic: bool = False


@dataclass
class IncidentRecord:
    incident_id: str
    site_ids: list[str]
    roads: list[str]
    first_observed_utc: str
    reported_event_time: dict | None
    last_checked_utc: str
    sources: list[dict]
    severity: str | None
    potential_exit_impact: dict[str, str]
    contradictions: list[str]
    confidence_basis: list[str]
    evidence_label: dict[str, str]
    investigation_status: str = "not opened"
    synthetic: bool = False

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class SiteGeography:
    """Per-site zone centre, exits and road names by tier, from the static map data."""

    def __init__(self, sites_raw: dict, zone_roads: dict | None):
        self.sites = {s["id"]: s for s in sites_raw["sites"]}
        self.centre = {sid: (s["feature_reference"]["latitude"], s["feature_reference"]["longitude"]) for sid, s in self.sites.items()}
        self.exit_roads: dict[str, set[str]] = {}
        self.exit_points: dict[str, list[tuple[float, float]]] = {}
        for sid, s in self.sites.items():
            pts = [(x["latitude"], x["longitude"]) for x in s.get("confirmed_exits", [])]
            for c in s.get("individual_parking_candidates", []) or []:
                pts += [(x["latitude"], x["longitude"]) for x in c.get("exit_connections", [])]
            self.exit_points[sid] = pts
        self.zone_roads: dict[str, set[str]] = {sid: set() for sid in self.sites}
        for sid, s in self.sites.items():
            names = set()
            for x in s.get("confirmed_exits", []):
                names.add(_norm(x["road_reached"].replace(" roundabout", "")))
            for c in s.get("individual_parking_candidates", []) or []:
                for x in c.get("exit_connections", []):
                    names.add(_norm(x["road_reached"]))
            for r in s.get("access_roads", []):
                for part in r.replace("(mapped candidate)", "").split("/"):
                    names.add(_norm(part))
            self.exit_roads[sid] = {n for n in names if n}
        for f in (zone_roads or {}).get("features", []):
            p = f["properties"]
            for sid in p["site_ids"]:
                for n in (p.get("name"), p.get("ref")):
                    if n:
                        self.zone_roads.setdefault(sid, set()).add(_norm(n))

    def impact(self, sid: str, rep: Report) -> tuple[str | None, list[str]]:
        """Return (impact category or None if not relevant, reasons)."""
        reasons: list[str] = []
        roads = {_norm(r) for r in rep.roads if r}
        in_zone = None
        if rep.point:
            d = dist_m(self.centre[sid], (rep.point["lat"], rep.point["lon"]))
            in_zone = d <= ZONE_RADIUS_M
            reasons.append(f"location {round(d)} m from site centre ({'inside' if in_zone else 'outside'} 805 m zone)")
            if not in_zone:
                return None, reasons
        at_exit = bool(rep.point) and any(dist_m((rep.point["lat"], rep.point["lon"]), e) <= EXIT_MATCH_M for e in self.exit_points[sid])
        if roads & self.exit_roads[sid]:
            if at_exit:
                reasons.append(f"located within {EXIT_MATCH_M:.0f} m of a mapped exit on a road the exits join")
                return "exit_connector", reasons
            reasons.append("names a road the mapped exits join (not located at the exit itself)")
            return "access_road", reasons
        major = {r for r in roads if r.upper() in MAJOR_ROADS}
        if major:
            if in_zone and major & self.zone_roads.get(sid, set()):
                reasons.append(f"major road {', '.join(sorted(m.upper() for m in major))} inside the zone")
                return "major_road_in_zone", reasons
            reasons.append("major road named without a location inside the zone: not automatically relevant")
            return None, reasons
        if roads & self.zone_roads.get(sid, set()):
            if in_zone is False:
                return None, reasons
            reasons.append("names a road inside the zone")
            return "zone_road", reasons
        if in_zone:
            reasons.append("inside the zone but road not identified")
            return "zone_only", reasons
        reasons.append("no road or location match (vague place names never match a site)")
        return None, reasons


def _time_of(rep: Report) -> datetime | None:
    for t in (rep.event_time, rep.published):
        if t and t.get("utc"):
            return datetime.fromisoformat(t["utc"])
    try:
        return datetime.fromisoformat(rep.fetched_at_utc)
    except (TypeError, ValueError):
        return None


def _same_event(a: Report, b: Report) -> bool:
    if a.kind != b.kind and "other" not in (a.kind, b.kind):
        return False
    ra, rb = {_norm(r) for r in a.roads}, {_norm(r) for r in b.roads}
    geo = False
    if a.point and b.point:
        geo = dist_m((a.point["lat"], a.point["lon"]), (b.point["lat"], b.point["lon"])) <= CLUSTER_DISTANCE_M
    if not (geo or (ra & rb)):
        return False
    ta, tb = _time_of(a), _time_of(b)
    if ta and tb and abs(ta - tb) > CLUSTER_WINDOW:
        return False
    return True


def correlate(reports: list[Report], geo: SiteGeography, gates: Any, sources_ok: dict[str, bool]) -> dict[str, Any]:
    """Cluster reports into incident records per site and label each site."""
    for r in reports:
        if r.source_id.startswith("tomtom") and not r.synthetic and not getattr(gates, "automated_tomtom_correlation", False):
            raise PersistenceRefused("automated TomTom correlation gate is closed; TomTom reports cannot be correlated")
    # 1. dedupe within a source on event id
    seen, uniq, dupes = set(), [], 0
    for r in reports:
        k = (r.source_id, r.source_event_id or r.title)
        if k in seen:
            dupes += 1
            continue
        seen.add(k)
        uniq.append(r)
    # 2. cluster
    clusters: list[list[Report]] = []
    for r in uniq:
        for c in clusters:
            if any(_same_event(r, x) for x in c):
                c.append(r)
                break
        else:
            clusters.append([r])
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    records: list[IncidentRecord] = []
    for c in clusters:
        site_impacts: dict[str, str] = {}
        basis: list[str] = []
        for sid in geo.sites:
            best = None
            for r in c:
                imp, why = geo.impact(sid, r)
                if imp and (best is None or IMPACT_RANK[imp] < IMPACT_RANK[best]):
                    best = imp
                    basis.append(f"{sid}: {r.source_id}: " + "; ".join(why))
            if best:
                site_impacts[sid] = best
        families = sorted({r.lineage_family for r in c if r.lineage_family and r.lineage_family != "unknown"})
        auth = any(r.authoritative for r in c)
        statuses = {r.status for r in c}
        contradictions = []
        if "active" in statuses and "cleared" in statuses:
            contradictions.append("sources disagree: one reports active, another reports cleared")
        if len({r.kind for r in c}) > 1:
            contradictions.append("sources disagree on incident type")
        labels = {sid: _label(imp, c, families, auth, contradictions) for sid, imp in site_impacts.items()}
        basis.append(f"independent upstream producers: {len(families)} ({', '.join(families) or 'none known'})")
        if len(c) > len(families):
            basis.append(f"{len(c) - len(families)} report(s) share an upstream producer and were not counted as extra confirmation")
        ev = [t for t in (_time_of(r) for r in c) if t]
        first_raw = next((r.event_time for r in c if r.event_time and r.event_time.get("raw")), None)
        key = "|".join(sorted(f"{r.lineage_family}:{r.source_event_id or r.title}" for r in c))
        records.append(IncidentRecord(
            incident_id="INC-" + hashlib.sha1(key.encode()).hexdigest()[:10],
            site_ids=sorted(site_impacts),
            roads=sorted({x for r in c for x in r.roads}),
            first_observed_utc=min(r.fetched_at_utc for r in c),
            reported_event_time=first_raw,
            last_checked_utc=now,
            sources=[{"source_id": r.source_id, "lineage_family": r.lineage_family, "authoritative": r.authoritative,
                      "title": r.title, "link": r.link, "status": r.status, "kind": r.kind,
                      "published": r.published, "event_time": r.event_time} for r in c],
            severity=None,
            potential_exit_impact=site_impacts,
            contradictions=contradictions,
            confidence_basis=basis,
            evidence_label=labels,
            synthetic=all(r.synthetic for r in c),
        ))
    # 3. site summaries
    any_source_ok = any(sources_ok.values())
    site_summary = {}
    for sid in geo.sites:
        mine = [rec.evidence_label[sid] for rec in records if sid in rec.evidence_label]
        if mine:
            site_summary[sid] = min(mine, key=LABEL_ORDER.index)
        else:
            site_summary[sid] = LABEL_NONE if any_source_ok else LABEL_INSUFFICIENT
    return {
        "records": [r.as_dict() for r in records if r.site_ids],
        "unmatched": [r.as_dict() for r in records if not r.site_ids],
        "site_labels": site_summary,
        "duplicates_suppressed": dupes,
        "sources_responding": sources_ok,
        "label_note": LABEL_NOTE,
        "synthetic": bool(reports) and all(r.synthetic for r in reports),
    }


def _label(impact: str, cluster: list[Report], families: list[str], auth: bool, contradictions: list[str]) -> str:
    active = [r for r in cluster if r.status == "active"]
    auth_active = any(r.authoritative for r in active)
    if not active:
        lab = LABEL_POSSIBLE  # planned, cleared or unknown status
    elif auth_active and (len(families) >= 2 and impact in ("exit_connector", "access_road")
                          or impact == "exit_connector" and any(r.kind == "closure" for r in active if r.authoritative)):
        # Confirmed = authority + independent corroboration on a road the exits join,
        # or an authoritative closure located on the exit connector itself.
        lab = LABEL_CONFIRMED
    elif impact in ("exit_connector", "access_road") and (auth_active or len(families) >= 2):
        lab = LABEL_PROBABLE
    else:  # zone roads, major roads and zone-only locations never rise above "possible"
        lab = LABEL_POSSIBLE
    if contradictions and lab != LABEL_POSSIBLE:
        lab = LABEL_ORDER[LABEL_ORDER.index(lab) + 1]  # downgrade one level
    return lab


# ---------------------------------------------------------------------------
# Site status for the dashboard cards
# ---------------------------------------------------------------------------

STATUS_GATED = "live readings shown; status classification gated"


def site_status(site_id: str, refresh: dict | None, gates: Any, point_sites: dict[str, list[str]] | None = None) -> dict[str, Any]:
    """Card status. Derived congestion classes only for synthetic data while the gate is closed.

    point_sites maps point id -> site ids from configuration (authoritative over the payload).
    """
    if not refresh:
        return {"state": "no data loaded", "class": "none", "detail": "Press Refresh to load live readings."}
    ps = point_sites or {}
    pts = [p for pid, p in refresh.get("points", {}).items() if site_id in (ps.get(pid) or p.get("site_ids") or [])]
    ok = [p for p in pts if p.get("status") == "ok" and p.get("geometry_check", "pass") == "pass"]
    total = len(pts)
    coverage = f"{len(ok)} of {total} road samples returned usable readings"
    if not ok:
        return {"state": "insufficient data", "class": "insufficient", "detail": coverage, "ok": 0, "total": total}
    if any(p["fields"].get("roadClosure") is True for p in ok):
        return {"state": "provider reports closure on a sampled road", "class": "closure", "detail": coverage, "ok": len(ok), "total": total}
    if refresh.get("synthetic"):
        ratios = [p["fields"]["currentSpeed"] / p["fields"]["freeFlowSpeed"] for p in ok if p["fields"].get("freeFlowSpeed")]
        r = min(ratios) if ratios else 1.0
        cls = "normal" if r >= 0.75 else ("congested" if r >= 0.5 else "severe")
        delay = sum(max(0, p["fields"]["currentTravelTime"] - p["fields"]["freeFlowTravelTime"]) for p in ok)
        return {"state": cls, "class": cls, "detail": coverage, "ok": len(ok), "total": total,
                "synthetic_delay_s": delay, "basis": "SYNTHETIC: lowest current/free-flow ratio (≥0.75 normal, ≥0.5 congested, else severe)"}
    if getattr(gates, "derived_congestion_indicators", False):  # pragma: no cover - gate cannot open in this build
        raise PersistenceRefused("derived indicator gate open but not supported")
    return {"state": STATUS_GATED, "class": "live", "detail": coverage, "ok": len(ok), "total": total,
            "basis": "TomTom terms do not yet permit FairExit to derive congestion classes. Read the provider values in the site detail."}
