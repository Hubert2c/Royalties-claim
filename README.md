# Royalty Hub — National Music Royalty Tracking Platform

Royalty Hub is the software product of the capstone project
**"Investigating Digital Infrastructure for Bridging Fragmented Distribution Networks in Africa: A Case Study of Music Royalty Management"**
by **MUNEZERO Hubert** (BSc Software Engineering, African Leadership University; supervisor: Emmanuel Annor).

It is a platform **administered by the Government of Rwanda** (Rwanda Intellectual Property Office, RIPO) that
records every public use of music — radio, TV, concerts, adverts, hotels and venues, telecoms and streaming —
collects licence fees, and pays every songwriter, composer, publisher and performer their confirmed share,
with a public dashboard and a tamper-evident audit log.

| | Link |
|---|---|
| 🎬 **Walkthrough video** (about 12 min) | (It is found in the files) |
| 📄 **Technical report** (PDF, 5 pages) | — also in this repository: [`docs/Royalty Hub - Technical Report.pdf`](docs/Royalty%20Hub%20-%20Technical%20Report.pdf) |
| 📊 Test results | [`tests/performance/results/`](tests/performance/results/) · [`tests/compatibility/results/`](tests/compatibility/results/) |

> **Prototype notice.** Payments and payouts run in **simulated** mode (no money moves); the payment-gateway
> classes are ready for live providers. Tariff amounts are **demo values** until the 2026 Ministerial Order
> figures are entered. Links to RURA, RRA and Irembo are designed but not connected. Demo organisations are fictional.

---

## 1. Technical requirements

| Item | Version / detail |
|---|---|
| Runtime | **Node.js 22.5 or newer** (tested on v22.23) — npm 10+ |
| Operating systems | Windows 10/11, macOS 13+, Linux (tested on Linux 6.x) |
| Backend | Express 5, jsonwebtoken 9, bcryptjs 3, helmet 8, express-rate-limit 8, multer 2, cors 2 |
| Database | SQLite (default; `better-sqlite3` if it compiles, otherwise Node's built-in `node:sqlite`) or PostgreSQL 14+ (`pg`) |
| Frontend | Plain HTML, CSS and JavaScript (no framework, no build step); works in current Chrome, Edge, Firefox, Safari |
| Testing | `node:test` (built in), ESLint 9, autocannon 8 + pidusage 4 (load), Playwright (browser checks, optional) |
| Optional | Docker 24+ and Docker Compose; Chromaprint `fpcalc` for real audio fingerprints |
| Hardware | Any machine that runs Node 22; 2 CPU cores and 1 GB free RAM are plenty for the demo |

## 2. Installation and running

```bash
git clone https://github.com/Hubert2c/Royalties-claim.git
cd Royalties-claim
cp .env.example .env        # Windows: copy .env.example .env
npm install
npm start
```

| Portal | URL | Demo login |
|---|---|---|
| Government console (admin) | http://localhost:3001 | admin@royaltyhub.com / admin123 |
| Government console (auditor, read-only) | http://localhost:3001 | auditor@royaltyhub.com / auditor123 |
| Rights-holder portal (artists) | http://localhost:8000 (or :3001/artist) | artist@royaltyhub.com / artist123 · cowriter@royaltyhub.com / artist123 |
| Licensee portal (music users) | http://localhost:3002 (or :3001/licensee) | radio@royaltyhub.com / licensee123 · venue@royaltyhub.com / licensee123 |
| Public transparency dashboard | http://localhost:3001/public | no login |
| Open API documentation | http://localhost:3001/docs | no login |

The database (`data/royalty_hub.db`) is created with demo data on first start. Start again from fresh data with `npm run reset-db`.
The app also opens from other devices on the same network (e.g. `http://192.168.1.20:3001` on a phone).

**PostgreSQL:** set `DATABASE_URL` in `.env` (see `.env.postgres.example`). **Docker:** `npm run docker:up` (app + PostgreSQL).
**Vercel:** set `DATABASE_URL`, `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `NODE_ENV=production`, `ALLOWED_ORIGINS`, then `npm run vercel:deploy`.

## 3. Testing

| Command | What it does | Result (latest run) |
|---|---|---|
| `npm test` | 29 unit + 18 integration tests (real server, throw-away database, 40+ wrong inputs) | **47 / 47 pass in ≈ 3 s** |
| `npm run lint` | ESLint code-quality checks | **0 problems** |
| `npm run test:load` | Load test: 10 / 50 / 100 users on 4 endpoints, 100,000-play database, rate-limit flood | [`load-test.md`](tests/performance/results/load-test.md) |
| `npm run test:bench` | Algorithm benchmark: fingerprint scaling and precision, money split, royalty run, audit chain | [`algorithm-benchmark.md`](tests/performance/results/algorithm-benchmark.md) |
| `npm run test:browsers` | 5 screen sizes × 4 portals + high/mid/low-end hardware profiles (needs `npm i -D playwright && npx playwright install`) | [`browser-check.md`](tests/compatibility/results/browser-check.md) |

Run Firefox and Safari (WebKit) too: `BROWSERS=chromium,firefox,webkit npm run test:browsers`.

**What testing changed** (before → after, 50 users at once): usage reports 39 → 554 requests/s (SQLite WAL),
fingerprint matching 183 → 1,268 requests/s (parsed-fingerprint cache), dashboards protected with 20 indexes and a
3-second cache, audit writes queued, and logging in from a phone via the computer's IP address fixed (CORS same-origin rule).

## 4. Repository structure

```
server.js                 Express app: security middleware, API routes, static portals, error handler
artist-server.js          rights-holder portal on its own port (8000)
licensee-server.js        licensee portal on its own port (3002)
start-all.js              starts all three (npm start)
database.js               shared connection, newId(), nowIso(), initializeDatabase()
db/
  adapters.js             DatabaseAdapter → SqliteAdapter | PostgresAdapter
  schema.js               the 18 tables of the ERD + 20 indexes
  seed.js                 demo data (5 months of history, calculated by the real engine)
lib/
  services.js             composition root: builds each service once (dependency injection)
  errors.js               AppError → ValidationError, AuthenticationError, ForbiddenError, NotFoundError, ConflictError, NotConfiguredError
  royalties/              RoyaltyEngine (pure calculation), DistributionService (draft → approve → pay)
  money/                  MoneyAllocator (largest-remainder method)
  fingerprint/            FingerprintMatcher (bit-error-rate search), DemoFingerprints
  usage/                  UsageService, MatchStrategies (Strategy pattern), ReportParsers (CSV, JSON)
  licensing/              LicensingService (apply → approve → pay)
  tariffs/                TariffRule → FlatAnnualRule | PercentGrossRule | PerUnitRule, TariffRuleFactory
  payments/               PaymentGateway → MobileMoneyGateway | BankTransferGateway | IremboGateway, factory
  audit/                  AuditLog (SHA-256 hash chain, queued writes)
  security/               auth (TokenService, ApiKeyService, middleware), FieldEncryptor (AES-256-GCM)
  notifications/          NotificationService
  util/                   format, periods, TtlCache
routes/
  auth.js rightsholder.js licensee.js disputes.js notifications.js public.js open.js
  admin/                  index.js + overview, tariffs, licences, usage, claims, runs, settings, access
index.html, app.js        Government console
artist/ licensee/ public/ docs/   other portals and the Open API documentation
shared/                   ui.js, widgets.js (bell, charts, flow bar, search, print, theme), icons, Imigongo pattern
tools/monitor-report.js   send real `fpcalc` fingerprints from a radio monitor
tests/
  unit/                   core.test.js, oop.test.js
  integration/            api.test.js (full flow), errors.test.js (wrong inputs)
  performance/            load-test.js, algorithm-benchmark.js, results/
  compatibility/          browser-check.js, results/ (+ screenshots)
docs/                     Open API page + technical report (PDF)
```

## 5. Design: how the code is organised

- **Layers:** portals → Express API (JWT, 4 roles, CORS, Helmet, rate limit) → thin routes → **service classes** → **domain classes** → **database adapter**.
- **OOP:** six abstract base classes with subclasses (payment gateways, match strategies, tariff rules, report parsers, database adapters, errors).
  Factories choose the subclass, so callers never switch on types (polymorphism). Services receive their collaborators
  in the constructor (dependency injection), which is how tests inject a fake payment gateway.
- **Algorithms:** fingerprint matching by sliding bit-error rate with a branch-free popcount (linear in catalogue size;
  100% precision and recall on 600 synthetic test clips — to be re-measured on real broadcasts in the pilot), the largest-remainder method for exact whole-franc shares (O(n log n)), and a SHA-256
  hash chain for the audit log (O(n) verification).
- **Data:** money in whole francs (integers); payout numbers encrypted; passwords hashed; API keys stored as hashes;
  every royalty line points to the exact play that earned it.

## 6. How the code matches the capstone document

| Requirement | Implemented in |
|---|---|
| FR1 register works, recordings, ISWC/ISRC/IPI | `routes/rightsholder.js` |
| FR2 splits must total 100% and be confirmed | `RoyaltyEngine.splitsAreComplete`, Confirm splits view |
| FR3 licences and tariff invoices | `LicensingService`, `lib/tariffs/TariffRules.js` |
| FR4 ingest fingerprints, logs, set lists, cue sheets, CSV/DDEX | `UsageService`, `ReportParsers`, `/api/open/v1` |
| FR5 fingerprint identification with station/time/confidence | `FingerprintMatcher`, `FingerprintMatchStrategy` |
| FR6 royalties after the published admin fee (≤ 30%) | `RoyaltyEngine`, `MoneyAllocator`, `DistributionService` |
| FR7 government approval before payment | `routes/admin/*` (auditor is read-only) |
| FR8 statements and payouts | Statements view, `DistributionService.payRun` → `PaymentGateway` |
| FR9 public unclaimed list and claims | `/api/public/unclaimed`, `routes/admin/claims.js` |
| FR10 disputes | `routes/disputes.js` |
| FR11 audit log | `lib/audit/AuditLog.js` |
| FR12 public dashboard | `/public` |
| FR13 open APIs (ONDC approach) | `routes/open.js`, API keys, `/docs` |

## 7. Ten-minute demo script

1. **Licensee** (radio) → *Apply for a licence* → "Advertisement (sync) – per advert", 4 adverts.
2. **Government console** (admin) → *Licences* → *Approve & invoice* → a clearance code is issued.
3. **Licensee** → *Pay* (simulated mobile money); check the code on the **public dashboard**.
4. **Console** → *Usage & monitoring* → *Simulate airplay* (real matching code on noisy fingerprints).
5. **Licensee** → *Report usage* → upload a CSV play log; unknown songs go to the public unclaimed list.
6. **Rights holder** (artist) → *Register a work* with a 70/30 split; money is held until confirmed.
7. **cowriter@royaltyhub.com** → *Confirm splits*.
8. **Artist** → *Unclaimed plays* → *This is mine*; admin approves under *Claims & disputes*.
9. **Console** → *Distributions* → *Calculate draft run* → *Approve run* → *Pay rights holders*.
10. **Artist** → *Statements*; **console** → *Audit log* → *Verify chain*; log in as the auditor (read-only).

## 8. Using real audio fingerprints (optional)

Install [Chromaprint](https://acoustid.org/chromaprint), register a song with the numbers from `fpcalc -raw -length 600 song.mp3`,
create a monitor API key (*Settings & API keys*), then `ROYALTY_HUB_API_KEY=rh_live_... node tools/monitor-report.js clip.mp3 LIC-RADIO`.

## 9. Production checklist

Strong `JWT_SECRET` and `DATA_ENCRYPTION_KEY`; PostgreSQL with daily encrypted backups; S3-compatible storage for evidence files;
`PAYMENTS_MODE=live` only after the provider adapters are connected; official tariffs with Gazette references; HTTPS and `ALLOWED_ORIGINS`.
