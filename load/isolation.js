// Cross-tenant probe against a running API (the staging build), from the
// outside, with two seeded load shops. Every attempt by shop B on shop A's
// records must be blocked: 404 for another shop's ids (never 403, so ids
// can't be probed), 401 for missing or tampered tokens, a tenant_id in the
// body or query ignored. Needs `npm run load:seed` first.
//   docker run --rm --add-host=host.docker.internal:host-gateway -v "$PWD/load:/load" \
//     -e API_URL -e LOAD_TEST_PASSWORD grafana/k6:2.3.0 run /load/isolation.js
import encoding from 'k6/encoding';
import { check, fail, group } from 'k6';
import http from 'k6/http';

const API = (__ENV.API_URL || 'http://host.docker.internal:4000').replace(
  /\/$/,
  '',
);
const PASSWORD = __ENV.LOAD_TEST_PASSWORD;

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1'] },
};

const pad = (n, width) => String(n).padStart(width, '0');
const phoneOf = (shop, member) => `0398${pad(shop, 3)}${pad(member, 4)}`;

function login(shop, member) {
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ identifier: phoneOf(shop, member), password: PASSWORD }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': `10.60.0.${shop}`,
      },
    },
  );
  if (res.status !== 200) fail(`login shop ${shop}: ${res.status}`);
  return res.json('accessToken');
}

function client(token) {
  const params = (extra = {}) => ({
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...extra,
    },
  });
  return {
    get: (path) => http.get(`${API}${path}`, params()),
    post: (path, body, extra) =>
      http.post(`${API}${path}`, JSON.stringify(body), params(extra)),
    patch: (path, body) =>
      http.patch(`${API}${path}`, JSON.stringify(body), params()),
    del: (path) => http.del(`${API}${path}`, null, params()),
  };
}

const is = (status) => (r) => r.status === status;

function purchase(api, kissan, commodity, extra = {}) {
  return api.post(
    '/purchases',
    {
      traderId: kissan,
      items: [
        { commodityId: commodity, bags: 10, weightKg: '1000', rate: '4000' },
      ],
      ...extra,
    },
    { 'Idempotency-Key': crypto.randomUUID() },
  );
}

export default function () {
  if (!PASSWORD) fail('Set LOAD_TEST_PASSWORD (the one used by load:seed)');
  // Owners: every permission, so a refusal can only come from the shop check.
  const tokenA = login(1, 0);
  const tokenB = login(2, 0);
  const a = client(tokenA);
  const b = client(tokenB);

  const kissanA = a.get('/traders?type=kissan&limit=1').json('data.0.id');
  const kissanB = b.get('/traders?type=kissan&limit=1').json('data.0.id');
  const commodityA = a.get('/commodities?limit=1').json('data.0.id');
  const commodityB = b.get('/commodities?limit=1').json('data.0.id');
  const saved = purchase(a, kissanA, commodityA);
  if (saved.status !== 201) fail(`shop A purchase: ${saved.status}`);
  const billA = saved.json();

  group("shop B reads and changes shop A's purchase", () => {
    check(b.get(`/purchases/${billA.id}`), { 'GET → 404': is(404) });
    check(b.patch(`/purchases/${billA.id}`, { notes: 'x' }), {
      'PATCH → 404': is(404),
    });
    check(b.post(`/purchases/${billA.id}/cancel`, {}), {
      'cancel → 404': is(404),
    });
    check(b.get(`/purchases?search=${encodeURIComponent(billA.billNo)}`), {
      'search by bill no finds nothing': (r) =>
        r.status === 200 && r.json('meta.total') === 0,
    });
    check(a.get(`/purchases/${billA.id}`), {
      'still intact for shop A': (r) =>
        r.status === 200 && r.json('status') === 'posted' && !r.json('notes'),
    });
  });

  group("shop B uses shop A's kissan and commodity", () => {
    check(b.get(`/traders/${kissanA}`), { 'GET trader → 404': is(404) });
    check(b.patch(`/traders/${kissanA}`, { name: 'Taken over' }), {
      'PATCH trader → 404': is(404),
    });
    check(b.del(`/traders/${kissanA}`), { 'DELETE trader → 404': is(404) });
    check(b.get(`/ledger/${kissanA}`), { 'khata → 404': is(404) });
    check(b.get(`/commodities/${commodityA}`), {
      'GET commodity → 404': is(404),
    });
    check(purchase(b, kissanA, commodityB), {
      "purchase on A's kissan → 400": is(400),
    });
    check(purchase(b, kissanB, commodityA), {
      "purchase with A's commodity → 400": is(400),
    });
  });

  const tenantA = a.get('/auth/me').json('tenantId');

  group('a tenant_id from the client is ignored', () => {
    const planted = purchase(b, kissanB, commodityB, { tenantId: tenantA });
    check(planted, {
      'body tenantId: saved (field ignored)': is(201),
    });
    if (planted.status === 201) {
      check(a.get(`/purchases/${planted.json('id')}`), {
        '…and not in shop A': is(404),
      });
    }
    check(b.get(`/purchases?limit=100&tenant_id=${tenantA}`), {
      'query tenant_id: never lists shop A': (r) =>
        r.status === 200 && !r.json('data').some((p) => p.id === billA.id),
    });
  });

  group('tokens', () => {
    check(http.get(`${API}/purchases`), { 'no token → 401': is(401) });
    // Shop B's token with shop A's tenant in the payload: signature breaks.
    const [head, body, sig] = tokenB.split('.');
    const claims = JSON.parse(encoding.b64decode(body, 'rawurl', 's'));
    claims.tenantId = tenantA;
    const forged = `${head}.${encoding.b64encode(JSON.stringify(claims), 'rawurl')}.${sig}`;
    check(client(forged).get('/purchases'), {
      'edited payload → 401': is(401),
    });
    const none = `${encoding.b64encode('{"alg":"none","typ":"JWT"}', 'rawurl')}.${encoding.b64encode(JSON.stringify(claims), 'rawurl')}.`;
    check(client(none).get('/purchases'), { 'alg none → 401': is(401) });
  });

  group('shop users on platform routes', () => {
    check(b.get('/admin/tenants'), { 'GET /admin/tenants → 403': is(403) });
    check(b.get(`/admin/tenants/${tenantA}`), {
      'GET /admin/tenants/:id → 403': is(403),
    });
  });
}
