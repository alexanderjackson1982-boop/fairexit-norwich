# FairExit live monitor (Build 2.2)

The public site at https://alexanderjackson1982-boop.github.io/fairexit-norwich/ is updated automatically by `.github/workflows/monitor.yml`. Your Mac doesn't need to be on.

## Schedule

- **When:** every 15 minutes, 06:00 to 23:59 UTC (`7,22,37,52 6-23 * * *`). In winter that is 06:00 to midnight UK time; in summer, 07:00 to 01:00.
- **Reliability:** best effort. GitHub may delay or skip scheduled runs. The site shows the last successful update and marks it **STALE** after 45 minutes.
- **Manual run:** Actions → **FairExit live monitor** → Run workflow. Tick *probe* to also health-check the restricted news sources. That records only status and item counts; nothing from them is displayed.
- **Deployment:** each run publishes `site/` plus the freshly generated `site/data/live/` files to Pages. Those files are never committed.
- **Work's workflow:** `pages.yml` still works. A deploy from it doesn't include live files, so the live panel says "not yet published" until the next monitor run, at most 15 minutes later.

## What it does

1. Fetches each permitted source in `monitor/sources.json`: 20 s timeout, 2 MB cap, one retry. One failure never stops the others.
2. Keeps only reports in the Norwich area (coordinates in the box, or county Norfolk).
3. Classifies each report: collision, closure, fire, roadworks, congestion, breakdown or other. Marks it active, planned or cleared.
4. Matches reports to the six 805 m zones using the same rules as the app:
   - **Located at a mapped exit, on a road the exits join** → exit connector.
   - **Names a road the exits join** → access road.
   - **Major road inside the zone** → possible only.
   - Anything else in a zone stays "possible" at most. Distant or vague reports match nothing.
5. Removes duplicates within a source (same event ID) and across sources (same road or within 200 m, within 30 minutes). Copies from the same original producer count once.
6. Keeps the source's own time strings. A time is converted to UTC only when the source states its time zone. Publication time is never treated as the start of the incident.
7. Keeps the "first seen" time across runs. Incidents the source stops listing show as "no longer listed" for 6 hours, then drop off.
8. Runs `monitor/check_public.py` before publishing. It fails the run if it finds any secret, any TomTom field, synthetic data marked as live, or content from a source that isn't cleared for display.

## Sources

| Source | Status | Why |
|---|---|---|
| National Highways unplanned events RSS (OGL v3) | **Pending address** | Checked 22 Oct 2026 from GitHub runners: `m.highwaysengland.co.uk` certificate expired 8 Oct 2026 (HTTP 404 on the feed path); `m.highways.gov.uk` and `m.nationalhighways.co.uk` don't resolve; `www.trafficengland.com` returns 404. |
| National Highways planned events RSS (OGL v3) | **Pending address** | Same as above. |
| Met Office East of England warnings | **Operational** | RSS terms allow any use, with content unchanged and a link to the source. Shown as weather context only. |
| BBC Norfolk RSS | Reachable, restricted | Feed works (26 items), but BBC terms restrict commercial reuse. Not displayed. |
| Eastern Daily Press RSS | Reachable, restricted | Feed works (50 items). No syndication licence. Not displayed. |
| Norwich Evening News RSS | Reachable, restricted | Feed works (50 items). No syndication licence. Not displayed. |
| Norfolk Live RSS | Restricted | No licence. Not displayed. |
| Norfolk Constabulary | Not polled | No feed or API; the site returns HTTP 403 to automated requests. |
| Norfolk Fire and Rescue | Not polled | Web page only; no feed, API or reuse terms published. |
| Norfolk County Council roadworks | Not polled | Public map only. The machine route is DfT Street Manager, which needs a receiver. |
| TomTom | Not used here | No storage or redistribution allowed. Live speeds only appear on the owner's local app. |

### Turning National Highways on (no code change)

Ask Work for the exact feed address they tested. Then go to Settings → Secrets and variables → Actions → **Variables** and add:

- `FAIREXIT_NH_RSS_URL` = the unplanned events feed address (must start `https://`)
- `FAIREXIT_NH_PLANNED_RSS_URL` = the planned events feed address (optional)

These are public addresses, not secrets. The next run picks them up automatically.

## Credentials

None are needed. The workflow uses only GitHub's built-in, short-lived deployment token. If a keyed source is added later (for example the National Highways v2 closures API), store its key as a repository **secret** and pass it only to the collect step.

## Cost

- **GitHub Actions:** standard runners are free for public repositories. About 72 runs a day at roughly 1 minute each.
- **Pages:** free.
- **Data sources:** all free; no paid APIs are called.
- **Expected monthly cost:** £0.

## Tests

```bash
python3 -m unittest discover -s tests_monitor -t .
```

The tests cover parsing, time handling, the Norfolk filter, zone matching (exit, access road, major road), duplicates, one source failing, all sources failing, first-seen tracking and expiry, restricted sources never being displayed, the pending state, and the registry's required fields. They use hand-written feeds and make no network calls.
