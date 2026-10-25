# Royalty Hub — National Music Royalty Tracking Platform (prototype)

Royalty Hub is the software prototype for the capstone proposal
**"Investigating Digital Infrastructure for Bridging Fragmented Distribution Networks in Africa: A Case Study of Music Royalty Management"**
(MUNEZERO Hubert, BSc. Software Engineering, African Leadership University).

It implements the system described in Chapter Three of the document: a platform
**administered by the Government of Rwanda** (Rwanda Intellectual Property Office, within RDB)
that tracks every use of music — radio, TV, concerts, adverts, public venues, telecoms and
streaming — collects licence fees, and pays royalties transparently to every songwriter,
composer, publisher and performer according to their confirmed splits.

> **Prototype notice.** Payments and payouts are **simulated** (no money moves).
> Tariff amounts are **demo values** until the Ministerial Order on royalties (2026) figures are entered.
> Connections to RURA, RRA and Irembo are designed but simulated. All organisation names in the demo data are fictional.

---

## 1. Quick start (Windows, macOS or Linux)

You need **Node.js 22** or newer (Node 20 also works if `better-sqlite3` installs).

```bash
cd "Royalties claim"
copy .env.example .env        # Windows   (use: cp .env.example .env on macOS/Linux)
npm install
npm start
```

Then open:

| Portal | URL | Demo login |
|---|---|---|
| Government console (admin) | http://localhost:3001 | admin@royaltyhub.com / admin123 |
| Government console (auditor, read-only) | http://localhost:3001 | auditor@royaltyhub.com / auditor123 |
| Rights-holder portal (artists) | http://localhost:8000 (or :3001/artist) | artist@royaltyhub.com / artist123 · cowriter@royaltyhub.com / artist123 |
| Licensee portal (music users) | http://localhost:3002 (or :3001/licensee) | radio@royaltyhub.com / licensee123 · venue@royaltyhub.com / licensee123 |
| Public transparency dashboard | http://localhost:3001/public | no login |
| Open API documentation | http://localhost:3001/docs | no login |

The database (`data/royalty_hub.db`) is created with demo data on the first start.
To start again from fresh demo data: `npm run reset-db`.

> **Database driver.** The app uses `better-sqlite3` when it installs. If it cannot be
> compiled on your machine, `npm install` still succeeds (it is optional) and the app
> automatically uses Node's built-in `node:sqlite` (Node 22.5+) instead.

Run the automated tests:

```bash
npm test
```

---

## 2. What's in the interface

**Design.** The look is based on *Imigongo*, the geometric black, white and earth-red art of Rwanda's
eastern province: one patterned band on the sidebar and login screens, with quiet layouts so the
numbers lead. Headings use Bricolage Grotesque and text uses IBM Plex Sans (from Google Fonts; the
app falls back to system fonts offline). Works on phones (the sidebar becomes a slide-in menu),
supports keyboard navigation, and respects "reduce motion".

**Features**

| Feature | Where |
|---|---|
| **Money flow bar** — collected → paid to creators / held / admin fee / not yet distributed | Console overview, public dashboard |
| **12-month charts** of fees collected and royalties paid | Console overview, public dashboard |
| **Live airplay feed**, refreshed every 5 seconds | Console overview |
| **Quick search** with **Ctrl + K** (works, ISRCs, licensees, runs, clearance codes, pages) | Console |
| **Notification bell** — split requests, licence approvals, payouts, claim and dispute decisions | All portals |
| **Earnings by month**, where songs are played, top music users, recently detected plays | Rights-holder overview |
| **Earnings estimator** — plays per month × value of one play in the latest run × your share | Rights-holder overview |
| **Printable royalty statement** | Rights-holder → Statements |
| **Printable licence certificate** with the clearance code | Licensee → Licences (paid) |
| **Dark mode** (follows your system, or use the moon/sun button) | All pages |

The demo data includes five months of history (licence payments, plays and paid distribution runs,
calculated by the real royalty engine) so the charts have something to show.

## 3. A 10-minute demo script (for the presentation)

1. **Licensee portal** (radio@royaltyhub.com) → *Apply for a licence* → choose "Advertisement (sync) – per advert", 4 adverts → submit.
2. **Government console** (admin) → *Licences* → *Approve & invoice*. A clearance code is issued.
3. **Licensee portal** → *Pay* (simulated mobile money). The clearance code is now valid —
   check it on the **Public dashboard** → *Check a clearance code*.
4. **Government console** → *Usage & monitoring* → *Simulate airplay*. A few seconds of a registered
   song's fingerprint, with added radio noise, go through the real matching code.
5. **Licensee portal** → *Report usage* → upload a CSV play log (there is a *Download a sample CSV* link).
   Unknown songs appear on the public **Unclaimed plays** list.
6. **Rights-holder portal** (artist@royaltyhub.com) → *Register a work* with a 70/30 split with Aline Kay.
   Its status is *pending splits* — royalties for it will be **held**, not lost.
7. Log in as **cowriter@royaltyhub.com** → *Confirm splits*.
8. **Rights-holder portal** → *Unclaimed plays* → *This is mine* → the admin approves it under *Claims & disputes*.
9. **Government console** → *Distributions* → *Calculate draft run* → *Approve run* → *Pay rights holders*.
10. **Rights-holder portal** → *Statements*: every line shows the station, time, detection method,
    play value and share. **Public dashboard** shows collected / paid / admin fee / held.
11. **Government console** → *Audit log* → *Verify chain*. Log in as the **auditor** to show read-only access.
12. Show the extras: press **Ctrl + K** and search an ISRC, open the **bell**, watch the **live airplay** feed, try the artist **earnings estimator**, print a **statement** and a **licence certificate**, and switch to **dark mode**.

---

## 4. How the code matches the document

| Document (Chapter 3) | Where in the code |
|---|---|
| ERD (Figure 4): RightsHolder, MusicalWork, Recording, Split, Licensee, Licence, Tariff, UsageEvent, Payment, DistributionRun, RoyaltyLine, AuditLog | `database.js` (schema + demo data) |
| Use cases (Figure 6) — rights holder, licensee, government administrator, monitoring system | `routes/rightsholder.js`, `routes/licensee.js`, `routes/admin.js`, `routes/open.js` |
| Flowchart (Figure 7) — usage → match → licence paid? → pool − capped fee → splits → approval → payout | `lib/usage.js`, `routes/admin.js` (compliance), `lib/royalty-engine.js` |
| Sequence diagram (Figure 8) — radio airplay to artist payout | `lib/fingerprint.js` → `lib/usage.js` → `lib/royalty-engine.js` → `routes/admin.js` (approve, pay) |
| Table 7 — collection methods per revenue stream | Tariffs (`lib/tariffs.js`), licences + clearance codes, play logs / set lists / cue sheets / DDEX, fingerprinting |
| 70/30 rule — admin fee capped at 30% and published | `MAX_ADMIN_FEE_RATE` in `lib/royalty-engine.js`, Settings view, public dashboard |
| ONDC lesson (2.2.6) — government owns registry & rules, others plug in via open APIs | `routes/open.js`, API keys, `/docs` |

### Functional requirements

| FR | Requirement | Implemented in |
|---|---|---|
| 1 | Register, add works, recordings, ISWC/ISRC/IPI | Rights-holder portal → *Register a work*; `POST /api/rightsholder/works` |
| 2 | Declare and confirm splits; reject if not 100% | `validateSplits()`; *Confirm splits* view |
| 3 | Licence applications and invoices from approved tariffs | Licensee portal; `lib/tariffs.js`; admin *Licences* |
| 4 | Ingest fingerprints, play logs, set lists, cue sheets, CSV/DDEX | `lib/usage.js`, `lib/csv.js`, `POST /api/licensee/usage(/csv)`, Open API |
| 5 | Identify broadcast songs by fingerprint, store station/time/confidence | `lib/fingerprint.js` (Chromaprint-style bit-error-rate matching) |
| 6 | Calculate royalties per period after the published admin fee | `lib/royalty-engine.js` (whole-franc, largest-remainder allocation) |
| 7 | Administrator approves tariffs, licences and runs before payment | Government console |
| 8 | Itemised statements and payouts (mobile money / bank) | *Statements* view (+ CSV); *Pay rights holders* (simulated) |
| 9 | Public unclaimed list; rights holders can claim | `/api/public/unclaimed`; *Unclaimed plays*; admin *Claims* |
| 10 | Disputes raised and resolved | `routes/disputes.js`; admin *Claims & disputes* |
| 11 | Audit log of every action | `lib/audit.js` (append-only, SHA-256 hash chain, *Verify chain*) |
| 12 | Public dashboard | `/public` |
| 13 | Open APIs for third-party systems | `/api/open/v1/*`, `tools/monitor-report.js`, `/docs` |

### Non-functional requirements

- **Security & privacy:** JWT login, four roles (admin, auditor, rightsholder, licensee), bcrypt passwords,
  AES-256-GCM encryption of payout numbers (`lib/crypto-box.js`), API keys stored only as hashes,
  Helmet security headers, rate limiting, and only the public folders are served (the original
  version served the whole project folder, including `.env` and the database).
- **Transparency & auditability:** every royalty line links to the exact usage event; hash-chained audit log.
- **Accuracy:** integer Rwandan francs; allocations always add up exactly (tested).
- **Interoperability:** ISRC / ISWC / IPI identifiers, CSV and DDEX-style JSON usage reports, open API.

---

## 5. Using real audio fingerprints (optional)

The demo data uses synthetic fingerprints. To use real ones, install
[Chromaprint](https://acoustid.org/chromaprint) (`fpcalc`):

1. Register a song: run `fpcalc -raw -length 600 song.mp3` and paste the numbers after `FINGERPRINT=`
   into *Audio fingerprint* when registering the work.
2. Create an API key (Government console → *Settings & API keys* → *Monitor key*).
3. Record a clip of the radio stream and report it:

```bash
set ROYALTY_HUB_API_KEY=rh_live_...        # Windows  (export ... on macOS/Linux)
node tools/monitor-report.js clip.mp3 LIC-RADIO
```

---

## 6. Project structure

```
server.js              API + all portal pages (port 3001)
artist-server.js       rights-holder portal on its own port (8000)
licensee-server.js     licensee portal on its own port (3002)
start-all.js           starts all three (npm start)
database.js            SQLite/Postgres connection, schema (ERD), demo data
lib/                   core logic: royalty-engine, fingerprint, tariffs, usage, audit, auth, csv, crypto-box,
                       notify (notifications), periods (monthly charts)
routes/                API routes per portal (auth, rightsholder, licensee, disputes, notifications, admin, public, open)
index.html, app.js     Government console
artist/                Rights-holder portal
licensee/              Licensee portal
public/                Public transparency dashboard
docs/                  Open API documentation page
shared/                ui.js (helpers), widgets.js (bell, charts, flow bar, search, print, theme),
                       icons.js, imigongo.svg (pattern), storage-keys.js
tools/                 monitor-report.js (real fingerprint reporting)
tests/                 unit.test.js, api.test.js  (npm test)
```

---

## 7. PostgreSQL / Supabase, Docker and Vercel

**Postgres (no Docker):** `copy .env.postgres.example .env`, set `DATABASE_URL` (local Postgres or Supabase), `npm start`.
The same schema is created automatically.

**Docker (optional):** `npm run docker:up` starts the app (ports 3001, 8000, 3002) and a PostgreSQL container.

**Vercel:** set `DATABASE_URL` (Supabase), `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `NODE_ENV=production`,
`ALLOWED_ORIGINS`, then `npm run vercel:deploy`. On Vercel all portals are served from one domain
(`/`, `/artist`, `/licensee`, `/public`, `/docs`). SQLite does not persist on Vercel — use Postgres.

## 8. Production checklist

- Set strong `JWT_SECRET` and `DATA_ENCRYPTION_KEY` values (the app warns if they are missing).
- Use PostgreSQL and S3-compatible storage for evidence files; back both up daily.
- Replace simulated payments with the mobile-money / bank / Irembo integrations.
- Enter the official tariffs and their Official Gazette references.
- Put the app behind HTTPS and set `ALLOWED_ORIGINS` to the real domains.
