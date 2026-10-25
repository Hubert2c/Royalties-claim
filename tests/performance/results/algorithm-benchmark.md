# Algorithm benchmark

Date: 2026-10-25T05:57:10.851Z  
Machine: Intel(R) Xeon(R) Processor, 2 cores, Node v22.23.4

## Fingerprint matching (60-value clip vs. catalogue of 240-value fingerprints)

| Recordings | First search (ms) | With cache (ms) | Correct song found | Confidence |
|---|---|---|---|---|
| 10 | 0.78 | 0.24 | yes | 0.8927 |
| 100 | 4.96 | 1.96 | yes | 0.8854 |
| 1000 | 45.75 | 21.44 | yes | 0.8854 |
| 5000 | 246.67 | 125.55 | yes | 0.8896 |

## Matching accuracy (600 clips vs. 1,000 registered songs)

Precision 100.0% · recall 100.0% · 300 correct, 0 wrong matches, 0 missed, 300 strangers correctly rejected. Note: synthetic fingerprints with random bit noise; real broadcast audio must be re-measured in the pilot.

## Largest-remainder allocation of Rwf 987,654,321

| Shares | Time (ms) | Adds up exactly |
|---|---|---|
| 10 | 0.01 | yes |
| 1,000 | 0.37 | yes |
| 100,000 | 37.68 | yes |
| 1,000,000 | 332.56 | yes |

## Monthly royalty calculation (500 songs, 2 writers each, 10% unconfirmed)

| Plays | Royalty lines | Time (ms) | Fee + paid + held = pool |
|---|---|---|---|
| 1,000 | 1,900 | 1.2 | yes |
| 10,000 | 19,000 | 4.2 | yes |
| 100,000 | 190,000 | 51.8 | yes |

## Audit hash chain

| Entries | Append (ms each) | Verify whole chain (ms) | Valid |
|---|---|---|---|
| 1,000 | 0.027 | 2.5 | yes |
| 10,000 | 0.027 | 20.8 | yes |
