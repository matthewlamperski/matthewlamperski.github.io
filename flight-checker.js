// Flight price checker for Miami area -> Chicago, Sat May 9, 2026 (one-way, 1 adult).
//
// Scrapes Google Flights, Southwest, and Frontier directly. Aggregates,
// sorts by price, prints a table, writes flights_results.json.
//
// Usage:
//   node flight-checker.js
//
// First run: HEADLESS is false so you can watch and solve any captchas
// manually. Flip to true once you're confident the selectors still work.

const { chromium } = require('playwright');
const fs = require('fs');

// ---------- Config ----------

const HEADLESS = false;          // set true once captchas are no longer an issue
const PAGE_DELAY_MS = 2000;      // delay between page loads to avoid rate limiting
const NAV_TIMEOUT_MS = 45000;
const RESULTS_TIMEOUT_MS = 5000; // soft fallback for waitForSelector on results lists
const DATE = '2026-05-09';

// User-asserted: Spirit shut down 2026-05-02. Flip to false if that turns
// out to be wrong; filtered Spirit rows are still written to the JSON file
// under `filtered_spirit` so nothing is silently lost.
const FILTER_SPIRIT = true;

const OUTPUT_FILE = 'flights_results.json';

// Origin/destination pairs.
const GOOGLE_PAIRS = [
  { origin: 'MIA', dest: 'ORD' },
  { origin: 'MIA', dest: 'MDW' },
  { origin: 'FLL', dest: 'ORD' },
  { origin: 'FLL', dest: 'MDW' },
];

// Southwest only flies into MDW for Chicago; FL hubs are FLL and MIA.
const SOUTHWEST_PAIRS = [
  { origin: 'FLL', dest: 'MDW' },
  { origin: 'MIA', dest: 'MDW' },
];

const FRONTIER_PAIRS = [
  { origin: 'FLL', dest: 'ORD' },
  { origin: 'FLL', dest: 'MDW' },
  { origin: 'MIA', dest: 'ORD' },
  { origin: 'MIA', dest: 'MDW' },
];

// ---------- Helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePrice(s) {
  if (!s) return null;
  const m = String(s).replace(/[, ]/g, '').match(/\$?(\d{2,5})/);
  return m ? Number(m[1]) : null;
}

function isSpirit(airline) {
  return airline && /spirit/i.test(airline);
}

function newResult(partial) {
  return {
    airline: null,
    route: null,
    departure_time: null,
    arrival_time: null,
    duration: null,
    stops: null,
    price: null,
    source: null,
    booking_url: null,
    ...partial,
  };
}

async function safeWait(page, selector, timeout = RESULTS_TIMEOUT_MS) {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

// Detect Google's "I'm not a robot" / consent / unusual-traffic interstitials.
async function maybePauseForCaptcha(page, label) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const captchaHit =
    /sorry\/index|consent\.google|recaptcha/i.test(url) ||
    /unusual traffic|before you continue|are you a robot/i.test(title);
  if (captchaHit) {
    console.log(
      `\n[!] Captcha/consent detected on ${label} (${url}).` +
        '\n    Solve it in the browser window, then press <Enter> here to continue.\n'
    );
    await new Promise((resolve) => {
      process.stdin.once('data', () => resolve());
    });
  }
}

// ---------- Scraper: Google Flights ----------

async function scrapeGoogle(page, origin, dest) {
  const route = `${origin}->${dest}`;
  const url =
    `https://www.google.com/travel/flights?q=` +
    encodeURIComponent(`Flights to ${dest} from ${origin} on ${DATE} oneway`);

  console.log(`[google] ${route}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (e) {
    console.log(`[google] ${route}: navigation failed: ${e.message}`);
    return [];
  }

  await maybePauseForCaptcha(page, `Google ${route}`);

  // Results live in role=list with role=listitem children, or in a <ul> with
  // <li> rows. Selectors change frequently; we try a few.
  const found =
    (await safeWait(page, 'ul[role="list"] li', RESULTS_TIMEOUT_MS)) ||
    (await safeWait(page, 'div[role="list"] div[role="listitem"]', RESULTS_TIMEOUT_MS)) ||
    (await safeWait(page, '[data-test-id="offer-listing"]', RESULTS_TIMEOUT_MS));

  if (!found) {
    console.log(`[google] ${route}: results selector never appeared`);
    return [];
  }

  const rows = await page.evaluate(() => {
    // Grab every list-item-ish container and pull text. We'll regex it
    // out below in Node — DOM structure on GF is volatile.
    const items = Array.from(
      document.querySelectorAll(
        'ul[role="list"] li, div[role="list"] div[role="listitem"]'
      )
    );
    return items
      .map((el) => (el.innerText || '').trim())
      .filter((t) => /\$\d/.test(t)); // must contain a price
  });

  const results = [];
  for (const text of rows) {
    // Typical block looks like:
    //   "7:55 AM – 10:25 AM\nAmerican\n3 hr 30 min\nMIA–ORD\nNonstop\n$184"
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const joined = lines.join(' | ');

    const timeMatch = joined.match(
      /(\d{1,2}:\d{2}\s?[AP]M)\s*[–\-]\s*(\d{1,2}:\d{2}\s?[AP]M)/i
    );
    const durMatch = joined.match(/(\d+\s*hr(?:\s*\d+\s*min)?)/i);
    const stopsMatch = joined.match(/(Nonstop|\d+\s+stop[s]?)/i);
    const priceMatch = joined.match(/\$([\d,]+)/);
    // Airline: first line that isn't a time/duration/price/route.
    const airline = lines.find(
      (l) =>
        !/\d{1,2}:\d{2}\s?[AP]M/i.test(l) &&
        !/\d+\s*hr/i.test(l) &&
        !/\$\d/.test(l) &&
        !/^[A-Z]{3}.{0,3}[A-Z]{3}$/.test(l) &&
        !/Nonstop|stop/i.test(l) &&
        l.length < 60
    );

    if (!priceMatch) continue;
    results.push(
      newResult({
        airline: airline || 'Unknown',
        route,
        departure_time: timeMatch ? timeMatch[1] : null,
        arrival_time: timeMatch ? timeMatch[2] : null,
        duration: durMatch ? durMatch[1] : null,
        stops: stopsMatch ? stopsMatch[1] : null,
        price: parsePrice(priceMatch[0]),
        source: 'google_flights',
        booking_url: url,
      })
    );
  }

  console.log(`[google] ${route}: ${results.length} rows`);
  return results;
}

// ---------- Scraper: Southwest ----------

async function scrapeSouthwest(page, origin, dest) {
  const route = `${origin}->${dest}`;
  const url =
    `https://www.southwest.com/air/booking/select.html` +
    `?originationAirportCode=${origin}` +
    `&destinationAirportCode=${dest}` +
    `&departureDate=${DATE}` +
    `&tripType=oneway` +
    `&adultPassengersCount=1` +
    `&fareType=USD`;

  console.log(`[southwest] ${route}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (e) {
    console.log(`[southwest] ${route}: navigation failed: ${e.message}`);
    return [];
  }

  // Southwest renders results in a list; selector varies, so try a few.
  const found =
    (await safeWait(page, '[data-test="flight-list-item"]', 15000)) ||
    (await safeWait(page, 'li.air-booking-select-detail', 8000)) ||
    (await safeWait(page, 'div[data-test="select-detail-flight"]', 5000));

  if (!found) {
    console.log(`[southwest] ${route}: results never appeared`);
    return [];
  }

  const rows = await page.evaluate(() => {
    const sels = [
      '[data-test="flight-list-item"]',
      'li.air-booking-select-detail',
      'div[data-test="select-detail-flight"]',
    ];
    let items = [];
    for (const s of sels) {
      items = Array.from(document.querySelectorAll(s));
      if (items.length) break;
    }
    return items.map((el) => (el.innerText || '').trim());
  });

  const results = [];
  for (const text of rows) {
    const joined = text.replace(/\s+/g, ' ');
    const timeMatch = joined.match(
      /(\d{1,2}:\d{2}\s?[AP]M)[^\d]{1,20}(\d{1,2}:\d{2}\s?[AP]M)/i
    );
    const durMatch = joined.match(/(\d+h\s*\d*m?)/i);
    const stopsMatch = joined.match(/(Nonstop|\d+\s+stop[s]?)/i);
    // Southwest publishes Wanna Get Away fares — pick the lowest visible price.
    const priceMatches = [...joined.matchAll(/\$(\d{2,4})/g)].map((m) => Number(m[1]));
    if (!priceMatches.length) continue;
    const price = Math.min(...priceMatches);

    results.push(
      newResult({
        airline: 'Southwest',
        route,
        departure_time: timeMatch ? timeMatch[1] : null,
        arrival_time: timeMatch ? timeMatch[2] : null,
        duration: durMatch ? durMatch[1] : null,
        stops: stopsMatch ? stopsMatch[1] : null,
        price,
        source: 'southwest',
        booking_url: url,
      })
    );
  }

  console.log(`[southwest] ${route}: ${results.length} rows`);
  return results;
}

// ---------- Scraper: Frontier ----------

async function scrapeFrontier(page, origin, dest) {
  const route = `${origin}->${dest}`;
  // Frontier deep-links search results via this URL pattern.
  const url =
    `https://booking.flyfrontier.com/Flight/InternalSelect` +
    `?o1=${origin}&d1=${dest}&dd1=${DATE}` +
    `&ADT=1&CHD=0&INL=0&inf=0&TT=OW&mon=true&cur=USD`;

  console.log(`[frontier] ${route}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (e) {
    console.log(`[frontier] ${route}: navigation failed: ${e.message}`);
    return [];
  }

  const found =
    (await safeWait(page, '.flight-card', 15000)) ||
    (await safeWait(page, '[class*="flight-result"]', 8000)) ||
    (await safeWait(page, '[class*="FlightCard"]', 5000));

  if (!found) {
    console.log(`[frontier] ${route}: results never appeared`);
    return [];
  }

  const rows = await page.evaluate(() => {
    const sels = ['.flight-card', '[class*="flight-result"]', '[class*="FlightCard"]'];
    let items = [];
    for (const s of sels) {
      items = Array.from(document.querySelectorAll(s));
      if (items.length) break;
    }
    return items.map((el) => (el.innerText || '').trim());
  });

  const results = [];
  for (const text of rows) {
    const joined = text.replace(/\s+/g, ' ');
    const timeMatch = joined.match(
      /(\d{1,2}:\d{2}\s?[AP]M)[^\d]{1,20}(\d{1,2}:\d{2}\s?[AP]M)/i
    );
    const durMatch = joined.match(/(\d+h\s*\d*m?)/i);
    const stopsMatch = joined.match(/(Nonstop|Direct|\d+\s+stop[s]?)/i);
    const priceMatches = [...joined.matchAll(/\$(\d{2,4})/g)].map((m) => Number(m[1]));
    if (!priceMatches.length) continue;
    const price = Math.min(...priceMatches);

    results.push(
      newResult({
        airline: 'Frontier',
        route,
        departure_time: timeMatch ? timeMatch[1] : null,
        arrival_time: timeMatch ? timeMatch[2] : null,
        duration: durMatch ? durMatch[1] : null,
        stops: stopsMatch ? stopsMatch[1] : null,
        price,
        source: 'frontier',
        booking_url: url,
      })
    );
  }

  console.log(`[frontier] ${route}: ${results.length} rows`);
  return results;
}

// ---------- Output ----------

function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function printTable(results) {
  const cols = [
    ['#', 4],
    ['Airline', 14],
    ['Route', 10],
    ['Depart', 10],
    ['Duration', 11],
    ['Stops', 10],
    ['Price', 8],
  ];
  console.log('\n=== All results, cheapest first ===');
  console.log(cols.map(([h, w]) => pad(h, w)).join(' '));
  console.log(cols.map(([, w]) => '-'.repeat(w)).join(' '));
  results.forEach((r, i) => {
    console.log(
      [
        pad(i + 1, 4),
        pad(r.airline, 14),
        pad(r.route, 10),
        pad(r.departure_time, 10),
        pad(r.duration, 11),
        pad(r.stops, 10),
        pad(r.price != null ? '$' + r.price : '', 8),
      ].join(' ')
    );
  });
}

// ---------- Main ----------

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  const all = [];
  const filteredSpirit = [];
  const errors = [];

  async function runScraper(name, fn) {
    try {
      const rows = await fn();
      for (const r of rows) {
        if (FILTER_SPIRIT && isSpirit(r.airline)) {
          filteredSpirit.push(r);
        } else {
          all.push(r);
        }
      }
    } catch (e) {
      console.log(`[${name}] error: ${e.message}`);
      errors.push({ scraper: name, error: e.message });
    }
    await sleep(PAGE_DELAY_MS);
  }

  for (const { origin, dest } of GOOGLE_PAIRS) {
    await runScraper(`google ${origin}->${dest}`, () => scrapeGoogle(page, origin, dest));
  }
  for (const { origin, dest } of SOUTHWEST_PAIRS) {
    await runScraper(`southwest ${origin}->${dest}`, () =>
      scrapeSouthwest(page, origin, dest)
    );
  }
  for (const { origin, dest } of FRONTIER_PAIRS) {
    await runScraper(`frontier ${origin}->${dest}`, () =>
      scrapeFrontier(page, origin, dest)
    );
  }

  await browser.close();

  // Sort cheapest first; rows missing a price go to the end.
  all.sort((a, b) => {
    if (a.price == null && b.price == null) return 0;
    if (a.price == null) return 1;
    if (b.price == null) return -1;
    return a.price - b.price;
  });

  const out = {
    timestamp: new Date().toISOString(),
    date_searched: DATE,
    config: { FILTER_SPIRIT, HEADLESS, PAGE_DELAY_MS },
    results: all,
    filtered_spirit: filteredSpirit,
    errors,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${all.length} results to ${OUTPUT_FILE} ` +
              `(${filteredSpirit.length} Spirit rows filtered, ${errors.length} errors).`);

  printTable(all);

  const cheapest = all.find((r) => r.price != null);
  if (cheapest) {
    console.log(
      `\nCHEAPEST: ${cheapest.airline} ${cheapest.route} for ` +
        `$${cheapest.price} departing ${cheapest.departure_time || '?'}`
    );
    console.log(`Book: ${cheapest.booking_url}`);
  } else {
    console.log('\nNo priced results found. Check flights_results.json for raw data.');
  }
})();
