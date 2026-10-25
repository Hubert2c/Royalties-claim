# Load test results

Date: 2026-10-25T05:35:33.268Z  
Machine: Intel(R) Xeon(R) Processor, 2 cores, 8 GB RAM, Linux 6.18.44-fc-v153, Node v22.23.4  
Each scenario ran for 10 s. Server start-up (including demo data): 23 ms.

| Endpoint | Users | Req/s | p50 ms | p97.5 ms | p99 ms | Errors | CPU % | RAM MB |
|---|---|---|---|---|---|---|---|---|
| GET /api/public/summary (public dashboard) | 10 | 7630 | 1 | 2 | 3 | 0 | 42 | 78 |
| GET /api/admin/overview (login + 12 queries) | 10 | 2835 | 3 | 5 | 6 | 0 | null | null |
| POST /api/open/v1/fingerprint-matches (matching) | 10 | 1309 | 6 | 16 | 18 | 0 | null | null |
| POST /api/open/v1/usage (10-play report) | 10 | 571 | 16 | 31 | 33 | 2 | null | null |
| GET /api/public/summary (public dashboard) | 50 | 7625 | 5 | 9 | 10 | 0 | null | null |
| GET /api/admin/overview (login + 12 queries) | 50 | 2781 | 16 | 25 | 28 | 0 | null | null |
| POST /api/open/v1/fingerprint-matches (matching) | 50 | 1268 | 38 | 54 | 62 | 2 | null | null |
| POST /api/open/v1/usage (10-play report) | 50 | 554 | 87 | 105 | 172 | 1 | null | null |
| GET /api/public/summary (public dashboard) | 100 | 7832 | 11 | 16 | 18 | 0 | null | null |
| GET /api/admin/overview (login + 12 queries) | 100 | 2898 | 34 | 43 | 45 | 0 | null | null |
| POST /api/open/v1/fingerprint-matches (matching) | 100 | 1311 | 73 | 92 | 105 | 0 | null | null |
| POST /api/open/v1/usage (10-play report) | 100 | 546 | 134 | 203 | 1914 | 3 | null | null |

Big database: 100,000 extra plays inserted through the Open API in 12.1 s (8298 plays/s). Then, with 50 users:

| Endpoint | Users | Req/s | p50 ms | p97.5 ms | p99 ms | Errors | CPU % | RAM MB |
|---|---|---|---|---|---|---|---|---|
| GET /api/public/summary (public dashboard) | 50 | 7538 | 6 | 10 | 12 | 0 | null | null |
| GET /api/admin/overview (login + 12 queries) | 50 | 2839 | 16 | 24 | 27 | 0 | null | null |

Stress test: 1000 requests from 50 users against a limit of 200: 199 accepted, 801 refused with HTTP 429.
