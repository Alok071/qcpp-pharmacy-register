const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "pharmacies.json"), "utf8"));
const contactsFile = path.join(__dirname, "pharmacy-contacts.json");
const contacts = fs.existsSync(contactsFile) ? JSON.parse(fs.readFileSync(contactsFile, "utf8")) : {};

const headers = ["Organisation Name", "Trading Name", "Certificate ID", "Suburb/City", "Country", "Status", "Current Certification Date", "Certification Expiry Date", "Phone", "Email", "Website"];

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function dateOnly(iso) {
  return iso ? iso.slice(0, 10) : "";
}

const lines = [headers.join(",")];
for (const d of data) {
  const c = contacts[d.certificateId];
  lines.push([
    csvEscape(d.organisationName),
    csvEscape(d.tradingName),
    csvEscape(d.certificateNumber),
    csvEscape(d.city),
    csvEscape(d.country),
    csvEscape(d.status),
    csvEscape(dateOnly(d.currentCertificationDate)),
    csvEscape(dateOnly(d.expiryDate)),
    csvEscape(c && c.matched ? c.phone : ""),
    csvEscape(c && c.matched ? c.email : ""),
    csvEscape(c && c.matched ? c.website : ""),
  ].join(","));
}

fs.writeFileSync(path.join(__dirname, "pharmacies.csv"), lines.join("\n"));
console.log("Wrote pharmacies.csv:", data.length, "rows");
