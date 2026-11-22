# Bellhaven → CRM ownership sync

Keeps the facility → parent-company links in the CRM in line with what Bellhaven Senior Living publishes on its website.
A daily job scrapes the website, matches each community to a CRM account, and puts every proposed change in a **review queue**.
A person approves or rejects each item in a small local web app; **only approved items are written to the CRM.**

Zero dependencies: Node 18+ only.

```bash
cp .env.example .env          # add CRM_TOKEN
npm test                      # 12 tests against a real snapshot of the CRM + website
npm run pipeline              # scrape + match -> data/state.json (never writes to the CRM)
npm run review                # http://localhost:3000  -> approve / reject
```

```
src/
  scraper.js    crawl the website (BFS over its own links), parse each community page
  crm.js        CRM API client (paginated reads, PATCH, POST)
  normalize.js  address / name normalisation (Rd = Road, NW = Northwest, Centre = Center, …)
  matcher.js    pure function: (communities, accounts, contacts) -> proposals with evidence
  state.js      review queue + idempotency (approved/rejected keys are never re-queued)
  apply.js      executes an approved proposal: precondition checks, resumable multi-step writes
  pipeline.js   the daily job
  server.js     review app (plain http) + ui.html
.github/workflows/daily-sync.yml   daily schedule (cron alternative in schedule/crontab.txt)
test/          node:test suite + fixtures captured from the sandbox on 2026-11-22
```

## How it works

### 1. Scraping
The directory can't be trusted on its own. The homepage says **35** communities but the directory lists **34**:
*Bellhaven Meadows of Findlay* is only linked from the homepage's "new this year" banner. The pager also never ends
(asking for a page past the last one returns the last page again). So the scraper does a bounded breadth-first crawl
of the site's own links (`/`, `/communities?page=N`, `/about`), keyed by URL, and collects every `/communities/<slug>`
page it reaches. Each detail page gives name, street, city, state, ZIP, care offerings, administrator and phone.
Every community records where it was found (`in_directory: false` is flagged in the UI). The job refuses to run if
fewer than 5 communities come back (protects against a site redesign quietly marking everything as "not on website").

### 2. Matching
Each community is compared with every live CRM account (accounts with `duplicate_of_account` or
`chow_current_account` set are treated as superseded and ignored). A pair is a **match** if any of these hold:

| Signal | Example it catches |
|---|---|
| Same normalised street + same ZIP or city | `4850 NW Sylvania Ave` = `4850 Northwest Sylvania Avenue` |
| Same street number + mostly same street + same ZIP/city | `3313 Wilmington Pk` vs `Pike` |
| Same canonical name in the same city | Ashtabula, where the CRM only has a PO Box |
| Website administrator is a contact on the account, same city | tie-breaks Owosso |

Name similarity on its own is **never** enough. Same-name/different-city and same-city/different-address pairs are
shown to the reviewer as "considered and rejected" instead of being linked. That avoids the decoys in the data:
*Amberly Manor* (same name, but the CRM one is in Colorado under Juniper Point), *Bellhaven of Carlisle, PA* vs
*Bellhaven of New Carlisle, OH*, and *Bellhaven at Union Square* vs Juniper Point's *Union Square Senior Living*
(same city, different street, different administrator).

When several accounts match one community they are duplicates. The **survivor** is chosen by: already under Bellhaven ›
has the website's administrator as a contact › exact name › has revenue history › Active › exact address string ›
has any parent › account id. Every other copy gets `duplicate_of_account = survivor`, `status = Inactive`. Reviewers
get a ⚠ if a losing copy has revenue/AR, and are told if it has contacts.

### 3. Classification → proposal types

| Type | When | What gets written on approval |
|---|---|---|
| *(confirmed)* | Matched, under Bellhaven, nothing differs | nothing (listed in the "confirmed" tab) |
| `UPDATE_FIELDS` | Under Bellhaven but outdated name / address / ZIP / care type | PATCH those fields + note |
| `REPARENT` | Wrong parent and **not** (revenue > 0 **and** AR > 0) | PATCH `parent_id` (+ any field fixes) + note |
| `CHOW_NEW_ACCOUNT` | Wrong parent **and** revenue > 0 **and** AR > 0 | POST new account under Bellhaven, then PATCH old `chow_current_account` = new id. Nothing else on the old account changes |
| `CHOW_EXISTING` | Under Bellhaven, not on website, a different owner already has an account at the same address, revenue **and** AR > 0 | PATCH old `chow_current_account` = existing new-owner account (no second copy is created) |
| `MARK_DUPLICATE` | Extra copies of a matched facility | `duplicate_of_account`, `Inactive`, note |
| `CREATE_ACCOUNT` | No match | POST new account under Bellhaven |
| `NOT_ON_WEBSITE` | Under Bellhaven, not on website, no successor found | `status = Needs Review` + note. Parent is left alone because absence from a website is weak evidence and the new owner is unknown |

Care type: the CRM field holds one value but the website can list several (Erie, Findlay list Assisted Living + Memory Support).
It is only changed when the current value isn't one of the offerings. Phone numbers are not synced: CRM phones don't
look like reliable facility numbers, and they're out of scope.

Every write appends a `[bellhaven-sync YYYY-MM-DD] …` line to `note`, so a rep looking at the account can see what changed and why.
The exception is the old account in a CHOW, which the SOP says must stay exactly as it is apart from `chow_current_account`.

### 4. Review app
Each card shows the website record next to the CRM record(s), the reasons for the match, the billing check, a
field-by-field *current → proposed* table, and similar accounts that were considered and rejected. Approve writes to
the CRM straight away; reject records who and why. Account ids link to the CRM browser.

### 5. Safe to re-run
* Every proposal has a deterministic key: `sha1(type, community, operations)`. Notes and dates are left out of the key, so tomorrow's run produces the same key.
* Approved and rejected keys are never queued again. Pending items the latest run no longer produces become `obsolete`.
* A reviewer can **reopen** a rejected item if they change their mind (logged in its history). Approved items can't be reopened: they are already in the CRM.
* After approvals, the CRM itself matches the website, so a re-run produces nothing for those items anyway (tested: after approving everything, all 35 communities come back as *confirmed* and 0 new proposals).
* **Precondition check:** before every PATCH the app re-reads the account. If a field it's about to change no longer has the value the reviewer saw, it stops and asks for a re-run instead of overwriting someone's edit.
* **Resumable:** a CHOW is two writes (create + patch). Progress is saved after each step, so retrying after a failure never creates a second account.
* Approvals are serialised (one write at a time) and the GitHub workflow uses a `concurrency` group.

### 6. Scheduling
`.github/workflows/daily-sync.yml` runs tests and then the pipeline at 11:15 UTC each day, and commits `data/state.json`
back so decisions persist between runs. `schedule/crontab.txt` is the same thing for a plain server (`flock` stops runs
from overlapping). Neither needs to be live for this exercise.

## What I found in the sandbox (2026-11-22)
35 communities on the website → **16 confirmed, 9 field updates, 4 re-parents, 2 CHOWs, 4 new accounts**, plus
**7 duplicates**, **1 sale to another operator (Sandusky → Millstone, CHOW)** and **2 not-on-website** accounts.

* Re-parent: Crossings of Lima (Harborview, AR 0), Meadows of Findlay (no parent, AR 0), Zanesville (Cedar Trail, renamed), Kettering (Harborview copy survives, renamed)
* CHOW → new account: Tiffin ($84k rev / $12.4k AR), Marietta ($51k / $3.8k), both under Cedar Trail
* CHOW → existing account: Bellhaven of Sandusky ($130k / $5.2k AR) → Millstone Care of Sandusky
* Duplicates: Port Clinton & Erie (old Harborview copies), Monroe (Harborview + Cedar Trail copies), Kettering (no-parent + Cedar Trail copies), Owosso (two Bellhaven copies)
* Renames: Riverbend Manor → Bellhaven of Chagrin Falls, Sunny Acres → Bellhaven Willow Creek, Chesterton Senior Commons → Bellhaven of Chesterton, + 4 cosmetic name fixes
* Address: Ashtabula (PO Box → 3156 W Prospect Rd), Portsmouth ZIP 45626 → 45662
* New: Batavia, Carlisle PA, Union Square (New Albany), Amberly Manor (Hudson OH)
* Needs Review: Bellhaven Care Center of Alliance, Bellhaven of Coldwater

## What I'd build next
* Store the queue in Postgres and give the review app logins, so several reviewers can work on it and every decision is audited by user.
* Auto-approve rules for low-risk, high-confidence items (e.g. cosmetic name fixes) once reviewers trust them. CHOW, duplicate and re-parent stay manual.
* Run the same pipeline for every operator: config-driven parent and site adapters, with an LLM-assisted extractor only for sites whose HTML can't be parsed reliably.
* Bring in outside signals (state licensing databases, CMS ownership data) as a second source of truth for ownership changes.
* Move contacts from duplicate copies to the survivor, and add a merge view.
* Alerting: Slack summary after each run, and an alert if the scraped count drops sharply.
