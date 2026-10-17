import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

import { checkRecordLayouts, compareLayout, docxXmlToText, findNumberForms, findOrganizationCodes } from "../src/counties/travis/t3-layouts.mjs";
import { INDIVIDUAL_OWNER_TYPES, PRIVACY_VERSION } from "../src/counties/travis/t3-sources.mjs";

const hasPdftotext = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The organization table both Comptroller layouts print (an excerpt, in their order and spelling). */
const ORG_TABLE = [
  ["AB", "TEXAS BUSINESS ASSOC"],
  ["C", "CORPORATION"],
  ["CL", "TEXAS LIMITED LIABILITY COMPANY"],
  ["CT", "TEXAS PROFIT CORPORATION"],
  ["ES", "ESTATE"],
  ["IS", "INDIVIDUAL - SOLE OWNER"],
  ["J", "JOINT VENTURE"],
  ["L", "LIMITED (LIABILITY) COMPANY"],
  ["M", "LIMITED (LIABILITY) PARTNERSHIP"],
  ["O", "OTHER"],
  ["P", "GENERAL PARTNERSHIP"],
  ["PI", "IND GENERAL PRTNSHP"],
  ["PZ", "IND SUCCESSOR PRTSHP"],
  ["S", "SOLE PROPRIETORSHIP"],
  ["TR", "TRUST"],
  ["UK", "UNKNOWN"],
];
const row = ([code, description]) => `${code.padEnd(12)}${description}`;

/** The franchise layout's shape: one paragraph per line, Courier text with runs of spaces, later one-letter tables. */
function franchiseDocx(table = ORG_TABLE) {
  const lines = [
    "Taxpayer Organizational Type",
    "Record Type Code",
    "FIELD VALUES:",
    "",
    "Taxpayer Organization Type:",
    ...table.map((entry) => `${row(entry)}            `),
    "",
    "Record Type Code:",
    "  U = Secretary of State (SOS) File Number",
    "  X = Comptroller Assigned File Number",
    "",
    "SOS Status Code:",
    "    A = Active",
    "    F = Forfeited Franchise Tax",
  ];
  const paragraph = (text) => `<w:p><w:pPr><w:pStyle w:val="PlainText"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New"/></w:rPr><w:t xml:space="preserve">${text.replace(/&/g, "&amp;")}</w:t></w:r></w:p>`;
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from("<Types/>"));
  zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(paragraph).join("")}</w:body></w:document>`));
  return zip.toBuffer();
}

/** The sales-tax layout's shape as a one-page PDF: code and description at separate x positions, then later tables. */
function salesPdf(table = ORG_TABLE) {
  const lines = [["", "FIELD VALUES:"], ["", ""], ["", "Taxpayer Organization Type:"], ["", ""], ...table, ["", ""], ["", "Outlet Inside/Outside City Limits Indicator"], ["  Y", "= Inside City Limits"], ["  N", "= Not Inside City Limits"]];
  const text = (x, y, value) => (value === "" ? "" : `BT /F1 10 Tf ${x} ${y} Td (${value.replace(/([()\\])/g, "\\$1")}) Tj ET`);
  const ops = lines.map(([code, description], index) => [text(72, 740 - index * 12, code.trim()), text(code.trim() === "" ? 72 : 144, 740 - index * 12, description)].join(" ")).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function writeLayouts(windowDir, files) {
  const dir = path.join(windowDir, "comptroller-record-layouts", "d20261017");
  await mkdir(dir, { recursive: true });
  for (const { name, bytes } of files) await writeFile(path.join(dir, name), bytes);
  const datasets = files.map(({ datasetId, name }) => ({ dataset_id: datasetId, status: "ok", files: [{ attachment: name, kept: name, tried: [] }] }));
  await writeFile(path.join(dir, "resolution-20261017T192341Z.json"), JSON.stringify({ datasets }));
}

const OBSERVED = { "jrea-zgmq": { IS: 9471, CL: 23967, CT: 5779, PI: 365, ES: 1, TR: 4 }, "9cir-efmm": { CL: 2281735, CT: 333220 } };
const VISIBLE_DIGITS = { "jrea-zgmq": { CL: { 3: 23055, 1: 912 }, PI: { 3: 301, 1: 64 }, ES: { 3: 1 }, TR: { 3: 3, 1: 1 } }, "9cir-efmm": { CL: { 3: 2000000, 1: 281735 } } };

describe("T3 record layout check", () => {
  it("reads only the organization section: one- and two-letter codes, never the later one-letter tables", () => {
    const text = docxXmlToText(new AdmZip(franchiseDocx()).getEntry("word/document.xml").getData().toString("utf8"));
    expect(text).toContain("AB          TEXAS BUSINESS ASSOC");
    const codes = findOrganizationCodes(text);
    expect(Object.keys(codes)).toEqual(ORG_TABLE.map(([code]) => code));
    expect(codes).toMatchObject({ C: "CORPORATION", S: "SOLE PROPRIETORSHIP", IS: "INDIVIDUAL - SOLE OWNER", PI: "IND GENERAL PRTNSHP" });
    for (const later of ["U", "X", "A", "F"]) expect(codes[later]).toBeUndefined();
    // The field list names the column without a colon; that is not the section heading.
    expect(findOrganizationCodes("Taxpayer Organizational Type\nIS          INDIVIDUAL - SOLE OWNER")).toEqual({});
    // The section ends at the first non-blank line that is not a code row.
    expect(findOrganizationCodes("Taxpayer Organization Type:\n\nIS          INDIVIDUAL - SOLE OWNER\n\nOutlet NAICS Code:\n  Y = Inside City Limits")).toEqual({ IS: "INDIVIDUAL - SOLE OWNER" });
    // A single space is not a separator: running text is not a row.
    expect(findOrganizationCodes("Taxpayer Organization Type:\nIS INDIVIDUAL - SOLE OWNER")).toEqual({});
    expect(findNumberForms("Taxpayer Number  11 digits\nOther")).toEqual(["Taxpayer Number 11 digits"]);
  });

  it("is consistent for the real table under the rule, and names every reason it would not be", () => {
    expect(PRIVACY_VERSION).toBe("travis-t3-privacy.v2");
    expect(INDIVIDUAL_OWNER_TYPES).toEqual(["IS", "S"]);
    const codes = Object.fromEntries(ORG_TABLE);
    const base = { datasetId: "jrea-zgmq", numberForms: [], observed: OBSERVED["jrea-zgmq"], governsTheRule: true, firstDigits: VISIBLE_DIGITS["jrea-zgmq"] };
    const ok = compareLayout({ ...base, codes });
    expect(ok).toMatchObject({ sole_owner_codes: ["IS", "S"], changes: [] });
    expect(ok.codes_mentioning_individuals.map((entry) => entry.code)).toEqual(["IS", "PI", "PZ", "S"]);
    expect(compareLayout({ ...base, codes: { ...codes, SP: "SOLE PROPRIETOR - SPOUSE" } }).changes).toEqual(["SP is described as a sole owner or individual (SOLE PROPRIETOR - SPOUSE) but the rule does not withhold it"]);
    const withoutS = Object.fromEntries(ORG_TABLE.filter(([code]) => code !== "S"));
    expect(compareLayout({ ...base, codes: withoutS }).changes).toEqual(["S is not in the layout's code table"]);
    expect(compareLayout({ ...base, codes, firstDigits: { PI: { 2: 1, 3: 300 } } }).changes).toEqual(["1 PI rows print a taxpayer number with the leading 2 of SSN-based numbers and are not withheld"]);
    expect(compareLayout({ ...base, codes, observed: { ...OBSERVED["jrea-zgmq"], QQ: 2 } }).changes).toEqual(["codes the data prints but the layout does not list: QQ"]);
  });

  it("reports awaiting_capture, then partial, then consistent for the two real layout shapes", async () => {
    const windowDir = await mkdtemp(path.join(tmpdir(), "t3-layouts-"));
    try {
      expect(await checkRecordLayouts({ windowDir, observedByDataset: OBSERVED })).toMatchObject({ status: "awaiting_capture", privacy_rule: "travis-t3-privacy.v2", individual_owner_types: ["IS", "S"] });
      await writeLayouts(windowDir, [{ datasetId: "9cir-efmm", name: "9cir-efmm-Franchise_Layout.docx", bytes: franchiseDocx() }]);
      expect(await checkRecordLayouts({ windowDir, observedByDataset: OBSERVED })).toMatchObject({ status: "partial", datasets_without_layout: ["jrea-zgmq"] });
      await writeLayouts(windowDir, [
        { datasetId: "jrea-zgmq", name: "jrea-zgmq-layout.docx", bytes: franchiseDocx() },
        { datasetId: "9cir-efmm", name: "9cir-efmm-Franchise_Layout.docx", bytes: franchiseDocx() },
      ]);
      const result = await checkRecordLayouts({ windowDir, observedByDataset: OBSERVED, firstDigitsByDataset: VISIBLE_DIGITS });
      expect(result).toMatchObject({ status: "consistent", changes: [] });
      expect(result.layouts.map((layout) => [layout.dataset_id, layout.codes_found, layout.sole_owner_codes])).toEqual([
        ["jrea-zgmq", ORG_TABLE.length, ["IS", "S"]],
        ["9cir-efmm", ORG_TABLE.length, ["IS", "S"]],
      ]);
    } finally {
      await rm(windowDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasPdftotext)("reads the sales-tax PDF layout with pdftotext, S included, later tables excluded", async () => {
    const windowDir = await mkdtemp(path.join(tmpdir(), "t3-layouts-pdf-"));
    try {
      await writeLayouts(windowDir, [
        { datasetId: "jrea-zgmq", name: "jrea-zgmq-Active_Sales_Tax_Permit_Record_Layout.pdf", bytes: salesPdf() },
        { datasetId: "9cir-efmm", name: "9cir-efmm-Franchise_Layout.docx", bytes: franchiseDocx() },
      ]);
      const result = await checkRecordLayouts({ windowDir, observedByDataset: OBSERVED, firstDigitsByDataset: VISIBLE_DIGITS });
      const sales = result.layouts.find((layout) => layout.dataset_id === "jrea-zgmq");
      expect(sales).toMatchObject({ method: "pdftotext -layout", codes_found: ORG_TABLE.length, sole_owner_codes: ["IS", "S"] });
      expect(sales.codes.Y).toBeUndefined();
      expect(result.status).toBe("consistent");
      // The same layout without S, under the rule that withholds S: a change.
      await writeLayouts(windowDir, [
        { datasetId: "jrea-zgmq", name: "jrea-zgmq-Active_Sales_Tax_Permit_Record_Layout.pdf", bytes: salesPdf(ORG_TABLE.filter(([code]) => code !== "S")) },
        { datasetId: "9cir-efmm", name: "9cir-efmm-Franchise_Layout.docx", bytes: franchiseDocx() },
      ]);
      expect(await checkRecordLayouts({ windowDir, observedByDataset: OBSERVED })).toMatchObject({ status: "differs", changes: ["jrea-zgmq: S is not in the layout's code table"] });
    } finally {
      await rm(windowDir, { recursive: true, force: true });
    }
  });
});
