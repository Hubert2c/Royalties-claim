# Load test results

Date: 2026-10-25T04:52:28.957Z  
Machine: Intel(R) Xeon(R) Processor, 2 cores, 8 GB RAM, Linux 6.18.44-fc-v153, Node v22.23.4  
Each scenario ran for 8 s. Server start-up (including demo data): 913 ms.

| Endpoint | Users | Req/s | p50 ms | p97.5 ms | p99 ms | Errors | CPU % | RAM MB |
|---|---|---|---|---|---|---|---|---|
| GET /api/public/summary (public dashboard) | 10 | 1316 | 6 | 14 | 16 | 0 | 101 | 163 |
| GET /api/admin/overview (login + 12 queries) | 10 | 1172 | 7 | 15 | 19 | 0 | 102 | 165 |
| POST /api/open/v1/fingerprint-matches (matching) | 10 | 189 | 48 | 98 | 104 | 0 | 31 | 166 |
| POST /api/open/v1/usage (10-play report) | 10 | 37 | 233 | 558 | 868 | 0 | 18 | 167 |
| GET /api/public/summary (public dashboard) | 50 | 1085 | 43 | 55 | 69 | 0 | 99 | 178 |
| GET /api/admin/overview (login + 12 queries) | 50 | 579 | 82 | 103 | 152 | 0 | 101 | 178 |
| POST /api/open/v1/fingerprint-matches (matching) | 50 | 183 | 203 | 635 | 3593 | 0 | 30 | 178 |
| POST /api/open/v1/usage (10-play report) | 50 | 39 | 462 | 4222 | 6103 | 0 | 18 | 178 |
| GET /api/public/summary (public dashboard) | 100 | 744 | 87 | 122 | 2270 | 0 | 88 | 178 |
| GET /api/admin/overview (login + 12 queries) | 100 | 355 | 149 | 301 | 3142 | 0 | 101 | 179 |
| POST /api/open/v1/fingerprint-matches (matching) | 100 | 180 | 196 | 1214 | 4519 | 0 | 31 | 179 |
| POST /api/open/v1/usage (10-play report) | 100 | 38 | 448 | 4194 | 6137 | 0 | 18 | 179 |

Stress test: 1000 requests from 50 users against a limit of 200: 199 accepted, 801 refused with HTTP 429.
