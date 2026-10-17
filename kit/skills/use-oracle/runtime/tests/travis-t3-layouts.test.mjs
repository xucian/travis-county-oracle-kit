import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

import { checkRecordLayouts, compareLayout, docxXmlToText, findNumberForms, findOrganizationCodes } from "../src/counties/travis/t3-layouts.mjs";

const hasPdftotext = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A DOCX whose document is a table of rows (cells separated) plus paragraphs. */
function docx(rows, paragraphs = []) {
  const cell = (text) => `<w:tc><w:p><w:r><w:t>${text.replace(/&/g, "&amp;")}</w:t></w:r></w:p></w:tc>`;
  const table = `<w:tbl>${rows.map((row) => `<w:tr>${row.map(cell).join("")}</w:tr>`).join("")}</w:tbl>`;
  const body = `${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("")}${table}`;
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from("<Types/>"));
  zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`));
  return zip.toBuffer();
}

/** A one-page PDF with each line as positioned text (code and description at separate x positions). */
function pdf(lines) {
  const ops = lines.map(([code, description], index) => `BT /F1 10 Tf 72 ${720 - index * 14} Td (${code}) Tj ET BT /F1 10 Tf 140 ${720 - index * 14} Td (${description}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
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
  const dir = path.join(windowDir, "comptroller-record-layouts", "d20261018");
  await mkdir(dir, { recursive: true });
  for (const { name, bytes } of files) await writeFile(path.join(dir, name), bytes);
  const datasets = files.map(({ datasetId, name }) => ({ dataset_id: datasetId, status: "ok", files: [{ attachment: name, kept: name, tried: [] }] }));
  await writeFile(path.join(dir, "resolution-20261018T100000Z.json"), JSON.stringify({ datasets }));
}

const OBSERVED = { "jrea-zgmq": { IS: 9471, CL: 23967, CT: 5779 }, "9cir-efmm": { CL: 2281735, CT: 333220 } };

describe("T3 record layout check", () => {
  it("reads codes and number forms from DOCX text", () => {
    const text = docxXmlToText('<w:p><w:r><w:t>ORGANIZATION TYPE</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>IS</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Individual - Sole Owner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
    expect(findOrganizationCodes(text)).toEqual({ IS: "Individual - Sole Owner" });
    expect(findOrganizationCodes("CL - Texas Limited Liability Company\nCT = Texas Profit Corporation\nNOTE: x\nAB")).toEqual({ CL: "Texas Limited Liability Company", CT: "Texas Profit Corporation" });
    expect(findNumberForms("Taxpayer Number  11 digits\nThe first digit 2 means a Social Security number\nOther")).toEqual(["Taxpayer Number 11 digits", "The first digit 2 means a Social Security number"]);
  });

  it("finds a second sole-owner code, a differently described IS and unlisted codes", () => {
    const base = { datasetId: "jrea-zgmq", numberForms: [], observed: OBSERVED["jrea-zgmq"], governsTheRule: true };
    expect(compareLayout({ ...base, codes: { IS: "Individual - Sole Owner", CL: "Texas Limited Liability Company", CT: "Texas Profit Corporation", PI: "General Partnership of Individuals" } }).changes).toEqual([]);
    const differs = compareLayout({ ...base, codes: { IS: "Investment Society", SP: "Sole Proprietor", CL: "Texas Limited Liability Company" } });
    expect(differs.changes).toEqual([
      "SP is described as a sole owner or individual (Sole Proprietor) but the rule does not withhold it",
      'IS is described as "Investment Society", not as a sole owner',
      "codes the data prints but the layout does not list: CT",
    ]);
  });

  it("reports awaiting_capture until the layouts land, then consistent for layouts that match the rule", async () => {
    const windowDir = await mkdtemp(path.join(tmpdir(), "t3-layouts-"));
    try {
      expect(await checkRecordLayouts({ windowDir, observedByDataset: OBSERVED })).toMatchObject({ status: "awaiting_capture", privacy_rule: "travis-t3-privacy.v1", individual_owner_types: ["IS"] });
      const sales = docx([["IS", "Individual - Sole Owner"], ["CL", "Texas Limited Liability Company"], ["CT", "Texas Profit Corporation"]], ["Taxpayer Number: 11 digits; the first digit 1 is an FEIN, 2 a Social Security number, 3 Comptroller-assigned"]);
      await writeLayouts(windowDir, [{ datasetId: "jrea-zgmq", name: "jrea-zgmq-layout.docx", bytes: sales }]);
      const partial = await checkRecordLayouts({ windowDir, observedByDataset: OBSERVED });
      expect(partial).toMatchObject({ status: "partial", datasets_without_layout: ["9cir-efmm"] });
      expect(partial.layouts[0]).toMatchObject({ sole_owner_codes: ["IS"], changes: [], ssn_lines: [expect.stringMatching(/Social Security/)] });
      const franchise = docx([["CL", "Texas Limited Liability Company"], ["CT", "Texas Profit Corporation"]]);
      await writeLayouts(windowDir, [
        { datasetId: "jrea-zgmq", name: "jrea-zgmq-layout.docx", bytes: sales },
        { datasetId: "9cir-efmm", name: "9cir-efmm-layout.docx", bytes: franchise },
      ]);
      expect(await checkRecordLayouts({ windowDir, observedByDataset: OBSERVED })).toMatchObject({ status: "consistent", changes: [] });
    } finally {
      await rm(windowDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasPdftotext)("reads a PDF layout with pdftotext and reports a change", async () => {
    const windowDir = await mkdtemp(path.join(tmpdir(), "t3-layouts-pdf-"));
    try {
      const sales = pdf([["IS", "Individual - Sole Owner"], ["SP", "Sole Proprietorship - Spouse"], ["CL", "Texas Limited Liability Company"], ["CT", "Texas Profit Corporation"]]);
      const franchise = docx([["CL", "Texas Limited Liability Company"], ["CT", "Texas Profit Corporation"]]);
      await writeLayouts(windowDir, [
        { datasetId: "jrea-zgmq", name: "jrea-zgmq-layout.pdf", bytes: sales },
        { datasetId: "9cir-efmm", name: "9cir-efmm-layout.docx", bytes: franchise },
      ]);
      const result = await checkRecordLayouts({ windowDir, observedByDataset: OBSERVED });
      expect(result.layouts[0]).toMatchObject({ method: "pdftotext -layout", sole_owner_codes: ["IS", "SP"] });
      expect(result).toMatchObject({ status: "differs", changes: ["jrea-zgmq: SP is described as a sole owner or individual (Sole Proprietorship - Spouse) but the rule does not withhold it"] });
    } finally {
      await rm(windowDir, { recursive: true, force: true });
    }
  });
});
