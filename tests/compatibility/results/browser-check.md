# Compatibility and performance results

Date: 2026-10-25T05:25:17.190Z  
Machine: Intel(R) Xeon(R) Processor, 2 cores, 8 GB, Linux 6.18.44-fc-v153

## Screens and browsers

| Browser | Screen | Portal | Works | Sideways scroll (px) | Ready in (ms) |
|---|---|---|---|---|---|
| chromium 153.0.8010.12 | Desktop 1920×1080 | Government console | yes | 0 | 821 |
| chromium 153.0.8010.12 | Desktop 1920×1080 | Rights-holder portal | yes | 0 | 756 |
| chromium 153.0.8010.12 | Desktop 1920×1080 | Licensee portal | yes | 0 | 731 |
| chromium 153.0.8010.12 | Desktop 1920×1080 | Public dashboard | yes | 0 | 602 |
| chromium 153.0.8010.12 | Laptop 1366×768 | Government console | yes | 0 | 752 |
| chromium 153.0.8010.12 | Laptop 1366×768 | Rights-holder portal | yes | 0 | 740 |
| chromium 153.0.8010.12 | Laptop 1366×768 | Licensee portal | yes | 0 | 745 |
| chromium 153.0.8010.12 | Laptop 1366×768 | Public dashboard | yes | 0 | 602 |
| chromium 153.0.8010.12 | Tablet (iPad Mini) | Government console | yes | 0 | 753 |
| chromium 153.0.8010.12 | Tablet (iPad Mini) | Rights-holder portal | yes | 0 | 726 |
| chromium 153.0.8010.12 | Tablet (iPad Mini) | Licensee portal | yes | 0 | 726 |
| chromium 153.0.8010.12 | Tablet (iPad Mini) | Public dashboard | yes | 0 | 608 |
| chromium 153.0.8010.12 | Phone (iPhone 13) | Government console | yes | 0 | 761 |
| chromium 153.0.8010.12 | Phone (iPhone 13) | Rights-holder portal | yes | 0 | 722 |
| chromium 153.0.8010.12 | Phone (iPhone 13) | Licensee portal | yes | 0 | 728 |
| chromium 153.0.8010.12 | Phone (iPhone 13) | Public dashboard | yes | 0 | 604 |
| chromium 153.0.8010.12 | Phone (Pixel 5) | Government console | yes | 0 | 761 |
| chromium 153.0.8010.12 | Phone (Pixel 5) | Rights-holder portal | yes | 0 | 765 |
| chromium 153.0.8010.12 | Phone (Pixel 5) | Licensee portal | yes | 0 | 722 |
| chromium 153.0.8010.12 | Phone (Pixel 5) | Public dashboard | yes | 0 | 594 |
| firefox | - | - | not tested | - | - |
| webkit | - | - | not tested | - | - |

## Simulated hardware and networks (Chromium, 1366×768)

| Hardware profile | Page | First paint (ms) | DOM ready (ms) | Load (ms) | Usable after login (ms) | JS memory (MB) | DOM nodes | Data (KB) |
|---|---|---|---|---|---|---|---|---|
| High-end (no throttling) | Public dashboard | 116 | 55 | 80 | 608 | 2.3 | 618 | 78 |
| High-end (no throttling) | Government console | 80 | 69 | 72 | 756 | 2.9 | 1726 | 127 |
| Mid-range (CPU ×4, Fast 3G) | Public dashboard | 776 | 762 | 939 | 1598 | 2.3 | 618 | 78 |
| Mid-range (CPU ×4, Fast 3G) | Government console | 904 | 903 | 1055 | 2296 | 2.9 | 1726 | 127 |
| Low-end (CPU ×6, Slow 3G) | Public dashboard | 2104 | 2104 | 2576 | 3481 | 2.3 | 618 | 78 |
| Low-end (CPU ×6, Slow 3G) | Government console | 2472 | 2515 | 2911 | 5093 | 2.4 | 1726 | 127 |
