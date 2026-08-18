const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "pharmacies.json"), "utf8"));
const template = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");
const contactsFile = path.join(__dirname, "pharmacy-contacts.json");
const contacts = fs.existsSync(contactsFile) ? JSON.parse(fs.readFileSync(contactsFile, "utf8")) : {};

const slim = data.map((d) => {
  const c = contacts[d.certificateId];
  return {
    organisationName: d.organisationName,
    tradingName: d.tradingName,
    certificateNumber: d.certificateNumber,
    city: d.city,
    country: d.country,
    status: d.status,
    currentCertificationDate: d.currentCertificationDate,
    expiryDate: d.expiryDate,
    phone: (c && c.matched && c.phone) || null,
    email: (c && c.matched && c.email) || null,
    website: (c && c.matched && c.website) || null,
  };
});

const fetchDate = new Date().toLocaleDateString("en-AU", { day: "2-digit", month: "long", year: "numeric" });

let out = template
  .replace("__DATA_JSON__", JSON.stringify(slim))
  .replace("__FETCH_DATE__", fetchDate)
  .replace("__TOTAL__", slim.length.toLocaleString());

fs.writeFileSync(path.join(__dirname, "pharmacy-directory.html"), out);
console.log("Wrote pharmacy-directory.html:", (out.length / 1024 / 1024).toFixed(2), "MB");

const splitAt = out.indexOf("</style>") + "</style>".length;
const headPart = out.slice(0, splitAt);
const bodyPart = out.slice(splitAt);

const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Searchable directory of Australian pharmacies certified under the QCPP scheme, sourced from the JASANZ register.">
${headPart}
</head>
<body>
${bodyPart}
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, "index.html"), standalone);
console.log("Wrote index.html:", (standalone.length / 1024 / 1024).toFixed(2), "MB");
