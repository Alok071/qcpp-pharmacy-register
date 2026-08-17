# QCPP Pharmacy Register

A searchable directory of every Australian pharmacy certified under the Quality Care Pharmacy Program (QCPP), built from the public [JASANZ certified-organisations register](https://register.jasanz.org/certified-organisations).

Live data fields: Organisation Name, Trading Name, Certificate ID, Certified By, Suburb/City, Country, Status, Current Certification Date, Certification Expiry Date.

## How the data is sourced

`register.jasanz.org` is an Angular single-page app with no bulk export. The underlying API was reverse-engineered from its JS bundles:

- List endpoint: `POST https://jasanzcupr-api.azurewebsites.net/api/V1/RegisterCertificate/GetAllFilterCertificate`
- Detail endpoint (adds current certification date): `GET https://jasanzcupr-api.azurewebsites.net/api/V1/RegisterCertificate/GetCertificateById?Id={id}&Page=0`

Filtered to country = Australia and certifying body = Pharmacy Guild of Australia (the QCPP scheme owner).

**Known API quirk:** the `PageNumber` field in the list endpoint is actually a raw record *offset*, not a 1-indexed page number (`PageNumber=1` skips 1 record, `PageNumber=200` skips 200). Naively treating it as a page index causes massive duplicate/skewed results. `fetch-data.js` accounts for this.

## Files

- `fetch-data.js` — scrapes the JASANZ API and writes `pharmacies.json` (run with `node fetch-data.js`)
- `build-artifact.js` — builds `index.html` (and `pharmacy-directory.html`) from `template.html` + `pharmacies.json`
- `build-csv.js` — exports `pharmacies.csv` for spreadsheet use
- `template.html` — the page markup/styles/logic, with data injected at build time
- `index.html` — the built, static, self-contained page (this is what gets deployed)
- `pharmacies.json` / `pharmacies.csv` — the scraped dataset

## Refreshing the data

```
node fetch-data.js      # re-scrape from JASANZ (~2-3 min)
node build-artifact.js  # rebuild index.html
node build-csv.js       # rebuild pharmacies.csv
```

## Disclaimer

This is an unofficial, independently built directory. Always verify current certification status at [register.jasanz.org](https://register.jasanz.org/certified-organisations) before relying on it.
