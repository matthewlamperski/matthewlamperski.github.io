# Flight Price Checker

One-off scraper to find the cheapest one-way flight from the Miami area
(MIA, FLL) to Chicago (ORD, MDW) on Saturday May 9, 2026.

Hits Google Flights, Southwest, and Frontier directly. Aggregates,
sorts by price, prints a table, writes raw scrape data to
`flights_results.json`.

## Run

```
npm install
npx playwright install chromium
node flight-checker.js
```

The first run launches a real Chromium window (`HEADLESS = false` in
`flight-checker.js`). If Google shows a captcha or consent screen, solve
it in the window and press Enter in the terminal — the script will
resume. Once you're confident the scrape is stable, flip `HEADLESS` to
`true` at the top of `flight-checker.js`.

## Spirit filter

`FILTER_SPIRIT` (top of `flight-checker.js`) is `true` because the user
told me Spirit shut down on 2026-05-02. I cannot independently verify
that. Filtered Spirit rows are still written to
`flights_results.json` under `filtered_spirit` so nothing is silently
lost — if the shutdown claim is wrong, set `FILTER_SPIRIT = false` and
re-run, or just inspect the JSON.

## What gets scraped

| Site | Pairs |
| --- | --- |
| Google Flights | MIA→ORD, MIA→MDW, FLL→ORD, FLL→MDW |
| Southwest | FLL→MDW, MIA→MDW (only Chicago hub Southwest serves) |
| Frontier | MIA→ORD, MIA→MDW, FLL→ORD, FLL→MDW |

## Notes

- Selectors on these sites change frequently. If a scraper returns 0
  rows, open the URL it logs in your browser and inspect the DOM to
  update the selectors in the relevant `scrape*` function.
- 2-second delay between page loads (`PAGE_DELAY_MS`) to keep things
  polite. Don't lower this.
- Errors per scraper are collected and written to the `errors` field of
  `flights_results.json` rather than crashing the run — partial results
  always print.
