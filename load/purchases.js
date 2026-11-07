// Busy mandi hours: SHOPS shops × OPERATORS operators save purchases
// (parchis) at the same time for DURATION. Run with Docker (see load/README.md):
//   docker run --rm --add-host=host.docker.internal:host-gateway -v "$PWD/load:/load" \
//     -e API_URL -e LOAD_TEST_PASSWORD grafana/k6:2.3.0 run /load/purchases.js
//
// Pass/fail (the ticket's peak-load scenario):
//   - p95 of the save request under 500 ms
//   - no failed save (http_req_failed = 0, every check passes)
// Duplicate bill numbers and gaps are checked afterwards with
// `npm run load:verify` (SQL over the saved rows).
//
// Pace: every operator saves one parchi every THINK_MIN..THINK_MAX seconds
// (default 45–75 s, about one a minute) without a break — 250 parchis a
// minute over the 50 shops, several times a real busy morning (typing a
// parchi with its weights takes a minute or two). Operators start at random
// moments in the first interval, not all in the same second. Lower
// THINK_MIN/THINK_MAX to find the ceiling (a stress run).
//
// Rate limits stay as in production. Each shop is one client IP (its
// operators share the shop's internet connection), sent the way the host's
// proxy sends it: X-Forwarded-For, which the API reads with
// `trust proxy = 1`. A shop must stay under THROTTLE_LIMIT (100 requests a
// minute): 5 operators × 1 save a minute by default; keep
// OPERATORS × 60 / THINK_MIN under 100 in a stress run. Each operator signs in
// once, in setup(), so the login limit (5 a minute per phone and IP) is never
// reached.
import { check, fail, sleep } from 'k6';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const API = (__ENV.API_URL || 'http://host.docker.internal:4000').replace(
  /\/$/,
  '',
);
const PASSWORD = __ENV.LOAD_TEST_PASSWORD;
const SHOPS = Number(__ENV.LOAD_SHOPS || 50);
const OPERATORS = Number(__ENV.LOAD_OPERATORS || 5);
const DURATION = __ENV.DURATION || '10m';
const THINK_MIN = Number(__ENV.THINK_MIN || 45);
const THINK_MAX = Number(__ENV.THINK_MAX || 75);

const saved = new Counter('purchases_saved');

export const options = {
  setupTimeout: '10m',
  scenarios: {
    operators: {
      executor: 'constant-vus',
      vus: SHOPS * OPERATORS,
      duration: DURATION,
      gracefulStop: '30s',
    },
  },
  thresholds: {
    'http_req_duration{name:save_purchase}': ['p(95)<500'],
    'http_req_failed{name:save_purchase}': ['rate==0'],
    checks: ['rate==1'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

const pad = (n, width) => String(n).padStart(width, '0');
/** Same rule as load/seed.ts. */
const phoneOf = (shop, member) => `0398${pad(shop, 3)}${pad(member, 4)}`;
/** One private-range address per shop. */
const ipOf = (shop) => `10.50.${Math.floor(shop / 250)}.${(shop % 250) + 1}`;

const json = (shop, token) => ({
  'Content-Type': 'application/json',
  'X-Forwarded-For': ipOf(shop),
  ...(token && { Authorization: `Bearer ${token}` }),
});

export function setup() {
  if (!PASSWORD) fail('Set LOAD_TEST_PASSWORD (the one used by load:seed)');
  const operators = [];
  const shops = {};
  for (let shop = 1; shop <= SHOPS; shop += 1) {
    // A shop's operators sign in together, as they would at opening time.
    const logins = http.batch(
      Array.from({ length: OPERATORS }, (_, i) => [
        'POST',
        `${API}/auth/login`,
        JSON.stringify({
          identifier: phoneOf(shop, i + 1),
          password: PASSWORD,
        }),
        { headers: json(shop), tags: { name: 'login' } },
      ]),
    );
    logins.forEach((res, i) => {
      if (res.status !== 200) {
        fail(`login ${phoneOf(shop, i + 1)}: ${res.status} ${res.body}`);
      }
      operators.push({ shop, token: res.json('accessToken') });
    });

    const token = operators[operators.length - 1].token;
    const get = (path) =>
      http.get(`${API}${path}`, {
        headers: json(shop, token),
        tags: { name: 'setup_lookup' },
      });
    const kissans = get('/traders?type=kissan&limit=100');
    const goods = get('/commodities?limit=100');
    if (kissans.status !== 200 || goods.status !== 200) {
      fail(`shop ${shop} lookups: ${kissans.status} ${goods.status}`);
    }
    shops[shop] = {
      kissans: kissans.json('data').map((t) => t.id),
      commodities: goods.json('data').map((c) => c.id),
    };
    if (!shops[shop].kissans.length || !shops[shop].commodities.length) {
      fail(`shop ${shop} has no kissans or commodities: run load:seed`);
    }
  }
  return { operators, shops };
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (min, max) => min + Math.random() * (max - min);

/** A realistic parchi: 1–3 lines of grain, 10–80 bags, rate per maund. */
function purchaseBody(shop) {
  const lines = 1 + Math.floor(Math.random() * 3);
  return {
    traderId: pick(shop.kissans),
    items: Array.from({ length: lines }, () => {
      const bags = 10 + Math.floor(Math.random() * 71);
      return {
        commodityId: pick(shop.commodities),
        bags,
        weightKg: (bags * between(95, 105)).toFixed(3),
        rate: String(3800 + Math.floor(Math.random() * 600)),
        rateUnit: 'maund',
      };
    }),
    paidAmount: '0',
  };
}

export default function (data) {
  // Operators start at different moments, as in a real shop.
  if (__ITER === 0) sleep(Math.random() * THINK_MAX);
  const me = data.operators[(__VU - 1) % data.operators.length];
  const res = http.post(
    `${API}/purchases`,
    JSON.stringify(purchaseBody(data.shops[me.shop])),
    {
      headers: {
        ...json(me.shop, me.token),
        'Idempotency-Key': crypto.randomUUID(),
      },
      tags: { name: 'save_purchase' },
    },
  );
  const ok = check(res, {
    'saved (201)': (r) => r.status === 201,
    'has a bill number': (r) => r.status === 201 && !!r.json('billNo'),
  });
  if (ok) saved.add(1);
  else console.error(`save failed: ${res.status} ${res.body}`);
  sleep(between(THINK_MIN, THINK_MAX));
}
