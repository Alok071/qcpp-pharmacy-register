// Fetches all Australian pharmacy (QCPP / Pharmacy Guild of Australia) certifications
// from the public JASANZ register API and writes pharmacies.json.
const fs = require("fs");
const path = require("path");

const API_ROOT = "https://jasanzcupr-api.azurewebsites.net/api/V1/";
const AUSTRALIA_COUNTRY_ID = "68c3e767-c177-e411-ab09-005056b2381f";
const PGA_CAB_ID = "0841b6ca-c9b3-e411-be4f-005056b24e56"; // Pharmacy Guild of Australia (QCPP)

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0",
  Origin: "https://register.jasanz.org",
  Referer: "https://register.jasanz.org/",
};

const OUT_FILE = path.join(__dirname, "pharmacies.json");
const PAGE_SIZE = 200;
const DETAIL_CONCURRENCY = 10;

async function postJson(endpoint, body) {
  const res = await fetch(API_ROOT + endpoint, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
  return res.json();
}

async function getJson(endpoint) {
  const res = await fetch(API_ROOT + endpoint, { headers: HEADERS });
  if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchAllListRows() {
  // NOTE: despite its name, the API's "PageNumber" field is actually a raw
  // record OFFSET (confirmed empirically: PageNumber=1 skips 1 record,
  // PageNumber=200 starts exactly where PageSize=200/offset=0 ends). It is
  // NOT a 1-indexed page number, so callers must pass offset directly.
  const rows = [];
  const seen = new Set();
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const body = {
      certificateId: null,
      PageNumber: offset,
      PageSize: PAGE_SIZE,
      schemeOwnerId: null,
      organisationName: null,
      tradingName: null,
      certification: null,
      city: null,
      cab: null,
      certScope: null,
      certStatus: null,
      country: [AUSTRALIA_COUNTRY_ID],
      certificationStandards: [],
      cabs: [PGA_CAB_ID],
      programs: [],
      isicCodes: [],
      schemes: [],
      certificateNumbers: [],
    };
    const resp = await postJson("RegisterCertificate/GetAllFilterCertificate", body);
    if (!resp.isSuccessful) throw new Error("List fetch failed: " + JSON.stringify(resp.messageDetail));
    total = resp.data.count;
    for (const dto of resp.data.certificateDtos) {
      if (!seen.has(dto.certificateId)) {
        seen.add(dto.certificateId);
        rows.push(dto);
      }
    }
    console.log(`Fetched offset ${offset} (${rows.length}/${total} unique so far)`);
    offset += PAGE_SIZE;
  }
  return rows;
}

async function fetchDetail(certificateId) {
  const resp = await getJson(`RegisterCertificate/GetCertificateById?Id=${certificateId}&Page=0`);
  if (!resp.isSuccessful) return null;
  return resp.data;
}

async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let done = 0;
  async function runOne() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i], i);
      done++;
      if (done % 200 === 0 || done === items.length) {
        console.log(`Detail fetched ${done}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, runOne));
  return results;
}

async function main() {
  console.log("Fetching list of all AU pharmacy certificates...");
  const listRows = await fetchAllListRows();
  console.log(`Got ${listRows.length} list rows. Fetching per-certificate detail (current certification date)...`);

  const details = await withConcurrency(listRows, DETAIL_CONCURRENCY, async (row) => {
    try {
      const d = await fetchDetail(row.certificateId);
      return d;
    } catch (e) {
      console.error("Detail fetch failed for", row.certificateId, e.message);
      return null;
    }
  });

  const merged = listRows.map((row, i) => {
    const d = details[i];
    return {
      organisationName: row.organisationName,
      tradingName: (d && d.tradingName) || null,
      certificateNumber: row.certificateName,
      certifiedBy: row.cabName,
      city: row.city,
      country: row.countryName,
      status: row.statusName,
      currentCertificationDate: d ? d.dateCertified : null,
      expiryDate: row.expriryDate,
      scopes: (row.scopes || []).map((s) => s.scopeName),
      certificateId: row.certificateId,
    };
  });

  // JASANZ removes a certificate from the register entirely once it expires,
  // rather than keeping it listed with an "Expired" status — so a plain overwrite
  // would silently lose every pharmacy the moment it lapses. Instead, keep anything
  // from the previous run that's no longer in this run's results, marked Expired.
  let previous = [];
  if (fs.existsSync(OUT_FILE)) {
    try {
      previous = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
    } catch (e) {
      console.error("Could not read previous pharmacies.json, starting fresh:", e.message);
    }
  }
  const currentIds = new Set(merged.map((d) => d.certificateId));
  const delisted = previous
    .filter((d) => !currentIds.has(d.certificateId))
    .map((d) => ({ ...d, status: "Expired", delistedAt: d.delistedAt || new Date().toISOString() }));

  const final = [...merged, ...delisted];

  fs.writeFileSync(OUT_FILE, JSON.stringify(final, null, 2));
  console.log(`Wrote ${final.length} records to ${OUT_FILE} (${merged.length} on the live register, ${delisted.length} retained as expired/delisted)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
