#!/usr/bin/env node
/**
 * A stand-in for `elephant-cli` in the T5 runner tests (not a test file): the four commands the runner calls, with the
 * output lines `parseCliOutput` reads and deterministic files, so two runs over the same inputs write the same bytes.
 *
 * - `validate <group-dir> --output-csv <f>`: one CSV error row per property whose PROP_ID is in `FAKE_CLI_INVALID`.
 * - `hash <group-dir> --output-zip <dir> --output-csv <f> --output-car <car>`: the property CID is a digest of the
 *   property's `address.json` and `parcel.json` (shared by both groups, as the Seed root makes them in the real CLI).
 * - `validate <car>`: the six check lines.
 * - `export-tables <car> --output <dir> --output-json <f>`: one part and the table counts.
 *
 * `FAKE_CLI_SLEEP_MS` delays every command (kill tests); `FAKE_CLI_PID_DIR` records each process id there.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};

async function properties(dir) {
  return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function main() {
  if (process.env.FAKE_CLI_PID_DIR) {
    await mkdir(process.env.FAKE_CLI_PID_DIR, { recursive: true });
    await writeFile(path.join(process.env.FAKE_CLI_PID_DIR, `${process.pid}.json`), JSON.stringify({ pid: process.pid, args }));
  }
  if (args[0] === "--version") {
    console.log("1.58.1");
    return 0;
  }
  const sleep = Number(process.env.FAKE_CLI_SLEEP_MS ?? "0");
  if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, sleep));
  const [command, target] = args;
  const cwd = process.cwd();
  if (command === "validate" && target.endsWith(".car")) {
    await writeFile(path.resolve(cwd, option("--output-csv")), "property_cid,data_group_cid,file_path,error_path,error_message,currentValue,timestamp\n");
    const blocks = (await readFile(path.resolve(cwd, target), "utf8")).split("\n").filter(Boolean).length;
    console.log([`  Blocks:                 ${blocks}`, `  Properties:             ${blocks}`, `  Data groups validated:  ${blocks * 2}`, "  integrity errors:       0", "  root errors:            0", "  index errors:           0", "  graph errors:           0", "  lexicon errors:         0", "  orphans errors:         0", "✅ CAR passed every check"].join("\n"));
    return 0;
  }
  if (command === "validate") {
    const dir = path.resolve(cwd, target);
    const props = await properties(dir);
    const invalid = new Set(String(process.env.FAKE_CLI_INVALID ?? "").split(",").filter(Boolean));
    const failing = props.filter((prop) => invalid.has(prop));
    const lines = ["property_cid,data_group_cid,file_path,error_path,error_message,currentValue,timestamp", ...failing.map((prop) => `,bafkfake,"${path.basename(dir)}/${prop}/data/property.json",/property_type,"must be equal to one of the allowed values",X,2026-10-18T00:00:00Z`)];
    await writeFile(path.resolve(cwd, option("--output-csv")), `${lines.join("\n")}\n`);
    console.log(`Properties processed: ${props.length}, succeeded: ${props.length - failing.length}, failed: ${failing.length}`);
    return failing.length > 0 ? 1 : 0;
  }
  if (command === "hash") {
    const dir = path.resolve(cwd, target);
    const zipDir = path.resolve(cwd, option("--output-zip"));
    await mkdir(zipDir, { recursive: true });
    const rows = ["propertyCid,dataGroupCid,dataCid,filePath"];
    const carLines = [];
    for (const prop of await properties(dir)) {
      const data = path.join(dir, prop, "data");
      const names = (await readdir(data)).sort();
      const seedRoot = [];
      for (const name of names) {
        if (!name.startsWith("bafk")) continue;
        const body = JSON.parse(await readFile(path.join(data, name), "utf8"));
        if (body.label === "Seed") seedRoot.push(name.replace(/\.json$/, ""));
      }
      const propertyCid = `bafyprop${sha((await readFile(path.join(data, "address.json"), "utf8")) + (await readFile(path.join(data, "parcel.json"), "utf8"))).slice(0, 20)}`;
      const content = sha((await Promise.all(names.map((name) => readFile(path.join(data, name), "utf8")))).join("|"));
      rows.push(`${propertyCid},${seedRoot[0] ?? "none"},bafydata${content.slice(0, 20)},${prop}/data`);
      carLines.push(`${prop} ${content}`);
      await writeFile(path.join(zipDir, `${prop}.zip`), content);
    }
    await writeFile(path.resolve(cwd, option("--output-csv")), `${rows.join("\n")}\n`);
    const car = path.resolve(cwd, option("--output-car"));
    await writeFile(car, `${carLines.join("\n")}\n`);
    console.log(`CAR written: ${car} (${carLines.length} blocks, root bafyroot${sha(carLines.join("\n")).slice(0, 24)})`);
    return 0;
  }
  if (command === "export-tables") {
    const car = await readFile(path.resolve(cwd, target), "utf8");
    const out = path.resolve(cwd, option("--output"));
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "part-0.parquet"), sha(car));
    const rows = car.split("\n").filter(Boolean).length;
    await writeFile(path.resolve(cwd, option("--output-json")), `${JSON.stringify({ root: `bafytables${sha(car).slice(0, 20)}`, tables: { property: { rows, parts: 1 }, parcel: { rows, parts: 1 } } })}\n`);
    console.log(`Tables written: ${out} (2 tables, 1 parts, root bafytables${sha(car).slice(0, 20)})`);
    return 0;
  }
  console.error(`fake elephant-cli: unknown command ${args.join(" ")}`);
  return 2;
}

main().then((code) => process.exit(code), (error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
