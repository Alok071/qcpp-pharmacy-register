// Enriches pharmacies.json with phone/email/website by matching each pharmacy
// against Healthdirect's National Health Services Directory (healthdirect.gov.au),
// the Australian government's public health service finder. JASANZ doesn't publish
// contact details, so this cross-references by suburb + fuzzy organisation-name match.
//
// Results are cached in pharmacy-contacts.json keyed by certificateId, so re-runs
// only look up pharmacies that haven't been checked yet (new certificates), not the
// whole list every time.
const fs = require("fs");
const path = require("path");

const HOST = "https://www.healthdirect.gov.au";
const APP_BASE = "/australian-health-services";
const PHARMACY_SERVICE_TYPE = "310080006";
const LOOKUP_CONCURRENCY = 3;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;
// A name match is accepted if it's near-exact (>= EXACT_THRESHOLD), or if it clears
// MIN_THRESHOLD *and* leads the next-best candidate by MIN_GAP. Plain "best score
// above a single cutoff" produced false positives on names that share a generic
// "Pharmacy"/suburb pattern (e.g. "Direct Chemist Outlet Bankstown" scoring 0.64
// against the unrelated "Chemist Warehouse Bankstown") — the gap check catches those.
const EXACT_THRESHOLD = 0.97;
const MIN_THRESHOLD = 0.85;
const MIN_GAP = 0.12;

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0",
};

const PHARMACIES_FILE = path.join(__dirname, "pharmacies.json");
const CONTACTS_FILE = path.join(__dirname, "pharmacy-contacts.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// healthdirect.gov.au's WAF sporadically 403s a fraction of automated-looking
// requests even under light concurrency — most retries succeed a moment later,
// so this is worth a few attempts before giving up on a suburb.
async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
      if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

async function getBuildId() {
  const res = await fetch(`${HOST}${APP_BASE}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Homepage fetch -> HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Could not find __NEXT_DATA__ on homepage");
  return JSON.parse(m[1]).buildId;
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function findSuburbCandidates(suburbName) {
  const data = await getJson(`${HOST}${APP_BASE}/api/location?q=${encodeURIComponent(suburbName)}`);
  const suburbs = (data.data && data.data.suburbs) || [];
  const exact = suburbs.filter((s) => s.label.toLowerCase() === suburbName.toLowerCase());
  return exact.length ? exact : suburbs;
}

async function searchPharmacies(buildId, suburbLabel, postcode, state) {
  const slug = `${slugify(suburbLabel)}-${postcode}-${state.toLowerCase()}`;
  const url = `${HOST}${APP_BASE}/_next/data/${buildId}/en/search/${slug}/pharmacy/${PHARMACY_SERVICE_TYPE}.json`;
  const data = await getJson(url);
  const services = (data.pageProps && data.pageProps.healthcareServices && data.pageProps.healthcareServices.services) || [];
  return services.map((svc) => ({
    name: svc.organisation && svc.organisation.name,
    contacts: extractContacts(svc.contacts || []),
  })).filter((s) => s.name);
}

function extractContacts(contacts) {
  const out = {};
  const typeMap = { phone: "phone", email: "email", website: "website" };
  for (const c of contacts) {
    const idRef = c.valueType && c.valueType.idRef;
    if (!idRef) continue;
    const kind = Object.keys(typeMap).find((k) => idRef.endsWith(`/${k}`));
    if (kind && !out[typeMap[kind]] && c.value) out[typeMap[kind]] = c.value;
  }
  return out;
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.substr(i, 2);
      m.set(bg, (m.get(bg) || 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a);
  const mb = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of ma) {
    if (mb.has(bg)) overlap += Math.min(count, mb.get(bg));
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

function bestMatch(pharmacy, candidates) {
  const names = [pharmacy.organisationName, pharmacy.tradingName].filter(Boolean).map(normalize);
  const scored = [];
  for (const c of candidates) {
    const cName = normalize(c.name);
    let score = 0;
    for (const n of names) score = Math.max(score, diceCoefficient(n, cName));
    scored.push({ score, candidate: c });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top) return null;
  const runnerUpScore = scored[1] ? scored[1].score : 0;
  const accepted = top.score >= EXACT_THRESHOLD || (top.score >= MIN_THRESHOLD && top.score - runnerUpScore >= MIN_GAP);
  return { score: top.score, candidate: top.candidate, accepted };
}

async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runOne() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, runOne));
  return results;
}

async function main() {
  const pharmacies = JSON.parse(fs.readFileSync(PHARMACIES_FILE, "utf8"));
  const cache = fs.existsSync(CONTACTS_FILE) ? JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8")) : {};

  const pending = pharmacies.filter((p) => !cache[p.certificateId]);
  console.log(`${pharmacies.length} total pharmacies, ${pending.length} not yet checked against Healthdirect.`);
  if (pending.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const bySuburb = new Map();
  for (const p of pending) {
    const key = (p.city || "").trim();
    if (!key) continue;
    if (!bySuburb.has(key)) bySuburb.set(key, []);
    bySuburb.get(key).push(p);
  }
  const suburbs = [...bySuburb.keys()];
  console.log(`Looking up ${suburbs.length} unique suburbs on healthdirect.gov.au...`);

  const buildId = await getBuildId();
  console.log("Using buildId:", buildId);

  let done = 0;
  let matched = 0;
  let skippedForRetry = 0;
  await withConcurrency(suburbs, LOOKUP_CONCURRENCY, async (suburbName) => {
    const group = bySuburb.get(suburbName);
    // Only cache a definitive "not found" when every lookup for this suburb actually
    // succeeded. If any request failed (after retries), skip caching for this group so
    // it's picked up again on the next run instead of being permanently recorded as
    // "no contact info" due to what was really just a transient WAF block.
    let hadError = false;
    try {
      const suburbCandidates = await findSuburbCandidates(suburbName);
      const seen = new Set();
      const pool = [];
      for (const sc of suburbCandidates) {
        const key = `${sc.code}-${sc.state.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const results = await searchPharmacies(buildId, sc.label, sc.code, sc.state.label);
          pool.push(...results);
        } catch (e) {
          hadError = true;
          console.error(`Search failed for ${suburbName} (${sc.label} ${sc.code} ${sc.state.label}):`, e.message);
        }
      }

      for (const pharmacy of group) {
        const match = pool.length ? bestMatch(pharmacy, pool) : null;
        if (match && match.accepted) {
          cache[pharmacy.certificateId] = {
            matched: true,
            matchedOrgName: match.candidate.name,
            score: Math.round(match.score * 100) / 100,
            ...match.candidate.contacts,
            checkedAt: new Date().toISOString(),
          };
          matched++;
        } else if (!hadError) {
          cache[pharmacy.certificateId] = { matched: false, checkedAt: new Date().toISOString() };
        } else {
          skippedForRetry++;
        }
      }
    } catch (e) {
      console.error(`Suburb lookup failed for "${suburbName}":`, e.message);
      skippedForRetry += group.length;
    }
    done++;
    if (done % 100 === 0 || done === suburbs.length) {
      console.log(`Suburbs processed: ${done}/${suburbs.length}, matched so far: ${matched}/${pending.length}, left for retry: ${skippedForRetry}`);
    }
  });

  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(cache, null, 2));
  const totalMatched = Object.values(cache).filter((c) => c.matched).length;
  console.log(`Wrote ${CONTACTS_FILE}: ${totalMatched}/${pharmacies.length} pharmacies matched overall.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
