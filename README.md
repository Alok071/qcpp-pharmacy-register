# QCPP Pharmacy Register

A searchable directory of every Australian pharmacy certified under the Quality Care Pharmacy Program (QCPP), built from the public [JASANZ certified-organisations register](https://register.jasanz.org/certified-organisations).

Live data fields: Organisation Name, Trading Name, Certificate ID, Suburb/City, Country, Status, Current Certification Date, Certification Expiry Date, plus Phone/Email/Website where a confident match was found (see below).

## How the data is sourced

`register.jasanz.org` is an Angular single-page app with no bulk export. The underlying API was reverse-engineered from its JS bundles:

- List endpoint: `POST https://jasanzcupr-api.azurewebsites.net/api/V1/RegisterCertificate/GetAllFilterCertificate`
- Detail endpoint (adds current certification date): `GET https://jasanzcupr-api.azurewebsites.net/api/V1/RegisterCertificate/GetCertificateById?Id={id}&Page=0`

Filtered to country = Australia and certifying body = Pharmacy Guild of Australia (the QCPP scheme owner).

**Known API quirk:** the `PageNumber` field in the list endpoint is actually a raw record *offset*, not a 1-indexed page number (`PageNumber=1` skips 1 record, `PageNumber=200` skips 200). Naively treating it as a page index causes massive duplicate/skewed results. `fetch-data.js` accounts for this.

**Expired certificates aren't kept on JASANZ's own register** — it removes a certificate
entirely on its expiry date rather than marking it "Expired" and leaving it listed. A
plain re-scrape would therefore silently lose every pharmacy the moment it lapses, so
`fetch-data.js` instead diffs against the previous `pharmacies.json`: anything missing
from the fresh JASANZ results is retained with `status: "Expired"` and a `delistedAt`
timestamp, rather than dropped. If a certificate later reappears (e.g. renewed after a
gap), it's simply picked back up from the live results as normal.

### Contact details (phone / email / website)

JASANZ doesn't publish contact details at all, so `fetch-contacts.js` cross-references
each pharmacy against [healthdirect.gov.au](https://www.healthdirect.gov.au/australian-health-services)
— the Australian government's public health service directory, which is free and has
no API key — by searching its suburb and fuzzy-matching the organisation name against
the results. Matches are only accepted when they're near-exact, or clearly ahead of
the next-best candidate (see the threshold comments in `fetch-contacts.js`); ambiguous
or no-match cases are left blank rather than risk showing the wrong pharmacy's phone
number. This means coverage is partial by design — expect roughly 70-80% of pharmacies
to have contact details, not 100%.

Results are cached in `pharmacy-contacts.json` keyed by certificate ID, so repeated
runs only look up pharmacies not already checked (i.e. new certificates), not the
whole list every time.

## Files

- `fetch-data.js` — scrapes the JASANZ API and writes `pharmacies.json` (run with `node fetch-data.js`)
- `fetch-contacts.js` — matches pharmacies against Healthdirect and writes `pharmacy-contacts.json`
- `build-artifact.js` — builds `index.html` (and `pharmacy-directory.html`) from `template.html` + `pharmacies.json` + `pharmacy-contacts.json`
- `build-csv.js` — exports `pharmacies.csv` for spreadsheet use
- `template.html` — the page markup/styles/logic, with data injected at build time
- `index.html` — the built, static, self-contained page (this is what gets deployed)
- `pharmacies.json` / `pharmacies.csv` — the scraped dataset
- `pharmacy-contacts.json` — cached Healthdirect contact matches

## Refreshing the data

```
node fetch-data.js      # re-scrape from JASANZ (~2-3 min)
node fetch-contacts.js  # match contact details against Healthdirect (first run: ~10-15 min; later runs only check new pharmacies)
node build-artifact.js  # rebuild index.html
node build-csv.js       # rebuild pharmacies.csv
```

### Automatic refresh

`.github/workflows/refresh-data.yml` runs the three commands above on a daily
schedule and commits the result if the data changed, which pushes a new commit
that Vercel then auto-deploys.

The **Refresh data** button on the page calls `/api/refresh` (a Vercel
serverless function, `api/refresh.js`), which triggers that same workflow
on demand via the GitHub Actions API — a full scrape takes minutes, so the
button starts the job in the background rather than blocking the page.
It's rate-limited to one trigger per hour.

To enable the button, add a GitHub token as a Vercel environment variable:

1. Create a token with `Contents: read/write` + `Actions: read/write` on this
   repo (fine-grained PAT), or a classic PAT with the `repo` scope.
2. `npx vercel env add GH_DISPATCH_TOKEN production` (paste the token when
   prompted), then redeploy.

## Disclaimer

This is an unofficial, independently built directory. Always verify current certification status at [register.jasanz.org](https://register.jasanz.org/certified-organisations) before relying on it.
