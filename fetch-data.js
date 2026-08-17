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

  fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2));
  console.log(`Wrote ${merged.length} records to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
