"""Tests for the scheduled public monitor. Feeds here are hand-written RSS in the
National Highways shape; no network access is used."""
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from monitor.collect import collect, in_norfolk, normalise, parse_rss, parse_time
from monitor.incidents import LABEL_INSUFFICIENT, LABEL_NONE, LABEL_POSSIBLE, LABEL_PROBABLE

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
REG = json.loads((ROOT / "monitor" / "sources.json").read_text())
NOW = datetime(2026, 10, 22, 13, 0, tzinfo=timezone.utc)
IDS = {"longwater", "castle_quarter_1", "castle_quarter_2", "mcdonalds_riverside", "morrisons_riverside", "ikea_hall_road"}


def rss(*items):
    body = "".join(items)
    return f"""<?xml version="1.0"?><rss version="2.0"><channel><title>TEST NH</title><copyright>OGL</copyright>{body}</channel></rss>""".encode()


def item(guid, title, lat=None, lon=None, road="", county="Norfolk", start="", desc=""):
    geo = f"<latitude>{lat}</latitude><longitude>{lon}</longitude>" if lat is not None else ""
    return (f"<item><title>{title}</title><description>{desc}</description><guid>{guid}</guid>"
            f"<link>https://www.trafficengland.com/x/{guid}</link><pubDate>Thu, 22 Oct 2026 12:40:00 GMT</pubDate>"
            f"<road>{road}</road><county>{county}</county>{geo}<eventStart>{start}</eventStart></item>")


A47_LONGWATER = item("E1", "A47 westbound closed between A1074 and B1535 due to a collision", 52.6509, 1.1841, "A47", start="2026-10-22T12:31:00+01:00")
A47_DUP = item("E1", "A47 westbound closed between A1074 and B1535 due to a collision", 52.6509, 1.1841, "A47")
A11_FAR = item("E2", "A11 northbound congestion near Attleborough", 52.52, 1.02, "A11")
KENT = item("E3", "M20 closed J8", 51.27, 0.62, "M20", county="Kent")
NOCOORD = item("E4", "A47 Norwich southern bypass: lane closed eastbound", None, None, "A47", desc="Norwich")


def fake_fetcher(bodies):
    def f(url):
        b = bodies.get(url)
        if b is None:
            return {"status": None, "error": "timeout", "body": b"", "ctype": None, "final_url": url}
        return {"status": 200, "error": None, "body": b, "ctype": "application/rss+xml", "final_url": url}
    return f


import os
UNPL = "https://feeds.example.test/nh/UnplannedEvents.xml"
PLAN = "https://feeds.example.test/nh/AllEvents.xml"
os.environ["FAIREXIT_NH_RSS_URL"] = UNPL
os.environ["FAIREXIT_NH_PLANNED_RSS_URL"] = PLAN
MET = REG["sources"][2]["endpoints"][0]
MET_RSS = b'<?xml version="1.0"?><rss version="2.0"><channel><title>Met</title></channel></rss>'


class TestParsing(unittest.TestCase):
    def test_times_never_invented(self):
        self.assertEqual(parse_time("Thu, 22 Oct 2026 12:40:00 GMT")["utc"], "2026-10-22T12:40:00+00:00")
        self.assertEqual(parse_time("2026-10-22T12:31:00+01:00")["utc"], "2026-10-22T11:31:00+00:00")
        for raw in ("22/10/2026 12:31", "2026-10-22 12:31", "Thursday lunchtime"):
            r = parse_time(raw)
            self.assertIsNone(r["utc"]); self.assertEqual(r["raw"], raw)

    def test_rss_refuses_entities_and_bad_xml(self):
        self.assertIsNone(parse_rss(b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><rss/>')[0])
        self.assertIsNone(parse_rss(b"<html>not a feed")[0])

    def test_geo_filter(self):
        src = REG["sources"][0]
        items, _, _ = parse_rss(rss(A47_LONGWATER, A11_FAR, KENT, NOCOORD))
        kept = [in_norfolk(normalise(i, src, "t")) for i in items]
        self.assertEqual(kept, [True, False, False, True])

    def test_classification(self):
        src = REG["sources"][0]
        n = normalise(parse_rss(rss(A47_LONGWATER))[0][0], src, "t")
        self.assertEqual(n["kind"], "closure"); self.assertEqual(n["status"], "active"); self.assertEqual(n["roads"], ["A1074", "A47", "B1535"])


class TestCollect(unittest.TestCase):
    def run_collect(self, bodies, previous=None, now=NOW, probe=False):
        return collect(SITE, previous or {}, REG, now=now, fetcher=fake_fetcher(bodies), probe=probe)

    def test_all_six_sites_present_and_not_synthetic(self):
        pub, st = self.run_collect({UNPL: rss(), PLAN: rss(), MET: MET_RSS})
        self.assertEqual(set(pub["site_summary"]), IDS)
        self.assertFalse(pub["synthetic"]); self.assertFalse(st["synthetic"]); self.assertFalse(st["tomtom_used"])
        for v in pub["site_summary"].values():
            self.assertEqual(v["label"], LABEL_NONE)
        self.assertIn("Unavailable", pub["traffic_measurements"])

    def test_match_dedupe_and_distant_alert(self):
        pub, _ = self.run_collect({UNPL: rss(A47_LONGWATER, A47_DUP, A11_FAR, KENT), PLAN: rss(A47_LONGWATER), MET: MET_RSS})
        self.assertEqual(pub["site_summary"]["longwater"]["label"], LABEL_POSSIBLE)  # A47 in zone, not an access road
        self.assertEqual(pub["site_summary"]["longwater"]["incidents"], 1)
        for sid in IDS - {"longwater"}:
            self.assertEqual(pub["site_summary"][sid]["incidents"], 0, sid)
        self.assertGreaterEqual(pub["duplicates_suppressed"], 1)
        rel = [i for i in pub["items"] if i["relevant"]]
        self.assertEqual(len(rel), 1)
        self.assertIn("independent upstream producers: 1", " ".join(rel[0]["confidence_basis"]))
        self.assertEqual(rel[0]["reported_event_time"]["utc"], "2026-10-22T11:31:00+00:00")
        self.assertFalse(any("M20" in s["title"] for i in pub["items"] for s in i["sources"]))  # Kent dropped before publish
        self.assertFalse(any("A11" in s["title"] for i in pub["items"] for s in i["sources"]))  # outside Norwich box

    def test_access_road_match_is_probable(self):
        hall = item("E9", "Hall Road closed due to a collision", 52.6085, 1.2895, "")
        pub, _ = self.run_collect({UNPL: rss(hall), PLAN: rss(), MET: MET_RSS})
        self.assertEqual(pub["site_summary"]["ikea_hall_road"]["label"], LABEL_PROBABLE)

    def test_one_failed_source_does_not_stop_others(self):
        pub, st = self.run_collect({UNPL: rss(A47_LONGWATER), MET: MET_RSS})  # planned feed times out
        by = {s["id"]: s for s in st["sources"]}
        self.assertEqual(by["national_highways_planned"]["operational_status"], "unavailable")
        self.assertIn("not clear", by["national_highways_planned"]["detail"])
        self.assertEqual(by["national_highways_unplanned"]["operational_status"], "operational")
        self.assertEqual(pub["site_summary"]["longwater"]["incidents"], 1)

    def test_all_incident_feeds_failed_is_insufficient_not_clear(self):
        prev_status = {"last_incident_update_utc": "2026-10-22T10:00:00+00:00"}
        pub, st = self.run_collect({MET: MET_RSS}, previous={"status": prev_status})
        for v in pub["site_summary"].values():
            self.assertEqual(v["label"], LABEL_INSUFFICIENT)
        self.assertEqual(st["last_incident_update_utc"], "2026-10-22T10:00:00+00:00")  # kept, not advanced
        self.assertEqual(st["incident_sources_operational"], 0)

    def test_first_observed_kept_and_unlisted_expiry(self):
        pub1, st1 = self.run_collect({UNPL: rss(A47_LONGWATER), PLAN: rss(), MET: MET_RSS})
        later = NOW + timedelta(minutes=15)
        pub2, _ = self.run_collect({UNPL: rss(A47_LONGWATER), PLAN: rss(), MET: MET_RSS}, previous={"incidents": pub1, "status": st1}, now=later)
        i2 = next(i for i in pub2["items"] if i["relevant"])
        self.assertEqual(i2["first_observed_utc"], NOW.isoformat(timespec="seconds"))
        pub3, _ = self.run_collect({UNPL: rss(), PLAN: rss(), MET: MET_RSS}, previous={"incidents": pub2}, now=later + timedelta(hours=1))
        gone = [i for i in pub3["items"] if not i["listed"]]
        self.assertEqual(len(gone), 1); self.assertEqual(gone[0]["status"], "no longer listed by source")
        self.assertEqual(pub3["site_summary"]["longwater"]["incidents"], 0)
        pub4, _ = self.run_collect({UNPL: rss(), PLAN: rss(), MET: MET_RSS}, previous={"incidents": pub3}, now=later + timedelta(hours=8))
        self.assertEqual(pub4["items"], [])

    def test_restricted_sources_not_polled_or_published(self):
        calls = []
        def f(url):
            calls.append(url)
            return {"status": 200, "error": None, "body": rss(item("N1", "Crash on Hall Road", 52.6085, 1.2895)), "ctype": "x", "final_url": url}
        pub, st = collect(SITE, {}, REG, now=NOW, fetcher=f, probe=False)
        self.assertFalse(any("bbci" in c or "edp24" in c or "norfolk-live" in c or "eveningnews" in c for c in calls))
        pub, st = collect(SITE, {}, REG, now=NOW, fetcher=f, probe=True)
        self.assertTrue(any("bbci" in c for c in calls))
        published_sources = {s["source_id"] for i in pub["items"] for s in i["sources"]}
        self.assertTrue(published_sources <= {"national_highways_unplanned", "national_highways_planned"})
        bbc = next(s for s in st["sources"] if s["id"] == "bbc_norfolk")
        self.assertIn("restricted", bbc["operational_status"])

    def test_pending_when_no_feed_address(self):
        saved = os.environ.pop("FAIREXIT_NH_RSS_URL"), os.environ.pop("FAIREXIT_NH_PLANNED_RSS_URL")
        try:
            calls = []
            def f(url):
                calls.append(url)
                return {"status": 200, "error": None, "body": MET_RSS, "ctype": "x", "final_url": url}
            pub, st = collect(SITE, {}, REG, now=NOW, fetcher=f)
            self.assertEqual(calls, [MET])  # dead NH hosts are not polled
            nh = next(s for s in st["sources"] if s["id"] == "national_highways_unplanned")
            self.assertEqual(nh["operational_status"], "pending: feed address needed")
            for v in pub["site_summary"].values():
                self.assertEqual(v["label"], LABEL_INSUFFICIENT)  # weather alone never means "clear"
            self.assertEqual(st["incident_sources_operational"], 0)
            self.assertEqual(st["last_successful_update_utc"], NOW.isoformat(timespec="seconds"))
        finally:
            os.environ["FAIREXIT_NH_RSS_URL"], os.environ["FAIREXIT_NH_PLANNED_RSS_URL"] = saved

    def test_variable_must_be_https(self):
        os.environ["FAIREXIT_NH_RSS_URL"] = "http://insecure.example/feed.xml"
        try:
            calls = []
            collect(SITE, {}, REG, now=NOW, fetcher=lambda u: calls.append(u) or {"status": None, "error": "timeout", "body": b"", "final_url": u})
            self.assertNotIn("http://insecure.example/feed.xml", calls)
        finally:
            os.environ["FAIREXIT_NH_RSS_URL"] = UNPL

    def test_registry_has_required_fields(self):
        need = {"provider", "endpoints", "authentication", "refresh_minutes", "licence", "retention", "publish", "error_handling"}
        for s in REG["sources"]:
            self.assertTrue(need <= set(s), s["id"])
        self.assertFalse(next(s for s in REG["sources"] if s["id"] == "tomtom")["publish"])


if __name__ == "__main__":
    unittest.main()
