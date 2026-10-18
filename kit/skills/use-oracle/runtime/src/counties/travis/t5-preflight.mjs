/**
 * T5 free-memory preflight (assignment decisions.md section 25.9 "Memory first"): before a long run, warn when swap is
 * heavily used, when a Colima, Docker or other virtualization VM is running, when free memory is low or when the disk
 * cannot hold the run. It never blocks: the run starts anyway and the warnings go into the run record. Local probes
 * only (`sysctl`, `vm_stat`, `ps`, `df`); no network.
 *
 * @module counties/travis/t5-preflight
 */
import { execFile } from "node:child_process";
import os from "node:os";

export const PREFLIGHT_VERSION = "travis-t5-preflight.v1";
/** Swap in use above this share of the swap total (or above 4 GB) is "heavily used". */
export const SWAP_WARN_SHARE = 0.5;
export const SWAP_WARN_BYTES = 4 * 1024 ** 3;
/** The measured 8-shard setting needs about 8 GB for the CLI processes plus the runner (decisions.md 25.9). */
export const MEMORY_WANTED_BYTES = 12 * 1024 ** 3;
/**
 * Disk per property of a full run, measured on the T5 dry run (20 shards, hard links counted once): about 180 KB per
 * parcel plus 20 KB per published permit, at the roll's 4.5 permits per parcel, plus the run's fixed files (the link
 * pass's per-shard permit files and internal rows, the Loader's permits table) spread over the roll: about 290 KB.
 */
export const DISK_BYTES_PER_PROPERTY = 290 * 1024;
/** Executable names (basename of the command's first token) of VMs that hold memory outside this run. */
export const VM_EXECUTABLE_PATTERNS = Object.freeze([/^colima$/, /^limactl$/, /^vfkit$/, /^qemu-system/, /^com\.docker\./, /^com\.apple\.Virtualization\.VirtualMachine$/, /^UTM$/, /^prl_/, /^OrbStack/]);
/** Docker Desktop lives under a path with a space, so its command is matched whole. */
export const VM_COMMAND_PATTERNS = Object.freeze([/^\/Applications\/Docker( Desktop)?\.app\//]);

/**
 * Run a command and return its stdout (never throws; null on failure).
 *
 * @param {string} command - Command.
 * @param {string[]} args - Arguments.
 * @returns {Promise<string | null>} Output.
 */
export function probe(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024, timeout: 15000 }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

/**
 * Parse `sysctl vm.swapusage` (`total = 7168.00M  used = 5724.38M  free = 1443.62M`).
 *
 * @param {string | null} text - Output.
 * @returns {{ total_bytes: number, used_bytes: number, free_bytes: number } | null} Swap.
 */
export function parseSwapUsage(text) {
  if (!text) return null;
  const value = (name) => {
    const match = new RegExp(`${name} = ([\\d.]+)([KMGT])`).exec(text);
    if (!match) return null;
    const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2]];
    return Math.round(Number(match[1]) * unit);
  };
  const total = value("total");
  const used = value("used");
  const free = value("free");
  return total === null || used === null ? null : { total_bytes: total, used_bytes: used, free_bytes: free ?? total - used };
}

/**
 * Parse `vm_stat`: free plus inactive plus speculative pages are what a new process can take without swapping.
 *
 * @param {string | null} text - Output.
 * @returns {{ page_size: number, available_bytes: number, free_bytes: number } | null} Memory.
 */
export function parseVmStat(text) {
  if (!text) return null;
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? "16384");
  const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1] ?? "0");
  const free = pages("Pages free") * pageSize;
  return { page_size: pageSize, free_bytes: free, available_bytes: free + (pages("Pages inactive") + pages("Pages speculative")) * pageSize };
}

/**
 * VM processes in a `ps -axo pid=,rss=,command=` listing.
 *
 * @param {string | null} text - Output.
 * @returns {{ pid: number, rss_bytes: number, command: string }[]} Processes.
 */
export function findVmProcesses(text) {
  if (!text) return [];
  const found = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[3];
    const executable = (command.split(/\s+/)[0] ?? "").split("/").at(-1) ?? "";
    if (VM_EXECUTABLE_PATTERNS.some((pattern) => pattern.test(executable)) || VM_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) found.push({ pid: Number(match[1]), rss_bytes: Number(match[2]) * 1024, command: command.slice(0, 160) });
  }
  return found;
}

/**
 * Parse `df -k <dir>` (available kilobytes of the filesystem holding the run).
 *
 * @param {string | null} text - Output.
 * @returns {number | null} Available bytes.
 */
export function parseDfAvailable(text) {
  if (!text) return null;
  const lines = text.trim().split("\n");
  const fields = lines.at(-1)?.trim().split(/\s+/) ?? [];
  const available = Number(fields[3]);
  return Number.isFinite(available) ? available * 1024 : null;
}

const gb = (bytes) => (bytes === null || bytes === undefined ? null : Math.round((bytes / 1024 ** 3) * 10) / 10);

/**
 * The preflight: probes, then warnings (never an error).
 *
 * @param {{ runDir: string, properties: number, probes?: { swap?: string | null, vmStat?: string | null, ps?: string | null, df?: string | null, colima?: string | null } }} options - Run directory, properties the run will write, and probe outputs (tests).
 * @returns {Promise<Record<string, any>>} Report.
 */
export async function runPreflight({ runDir, properties, probes = {} }) {
  const swapText = "swap" in probes ? probes.swap : await probe("sysctl", ["vm.swapusage"]);
  const vmStatText = "vmStat" in probes ? probes.vmStat : await probe("vm_stat", []);
  const psText = "ps" in probes ? probes.ps : await probe("ps", ["-axo", "pid=,rss=,command="]);
  const dfText = "df" in probes ? probes.df : await probe("df", ["-k", runDir]);
  // `colima status` exits 0 only while its VM runs; a leftover `colima start` supervisor without a VM holds little memory.
  const colimaStatus = "colima" in probes ? probes.colima : await probe("colima", ["status"]);
  const swap = parseSwapUsage(swapText);
  const memory = parseVmStat(vmStatText);
  const found = findVmProcesses(psText).filter((item) => item.pid !== process.pid);
  const colimaVmRunning = colimaStatus !== null;
  const isColima = (item) => /^(colima|limactl)$/.test((item.command.split(/\s+/)[0] ?? "").split("/").at(-1) ?? "");
  const vms = found.filter((item) => !isColima(item) || colimaVmRunning);
  const idleColima = found.filter((item) => isColima(item) && !colimaVmRunning);
  const diskAvailable = parseDfAvailable(dfText);
  const diskWanted = properties * DISK_BYTES_PER_PROPERTY;
  const warnings = [];
  if (swap && (swap.used_bytes > SWAP_WARN_BYTES || (swap.total_bytes > 0 && swap.used_bytes / swap.total_bytes > SWAP_WARN_SHARE))) {
    warnings.push(`swap heavily used: ${gb(swap.used_bytes)} of ${gb(swap.total_bytes)} GB; close heavy apps (the 8-shard County time doubled with a nearly full swap, decisions.md 25.9)`);
  }
  if (vms.length > 0) {
    const resident = vms.reduce((sum, item) => sum + item.rss_bytes, 0);
    warnings.push(`a VM is running (${[...new Set(vms.map((item) => item.command.split(/\s+/)[0].split("/").at(-1)))].join(", ")}; about ${gb(resident)} GB resident in its host processes): stop it first (colima stop)`);
  }
  if (memory && memory.available_bytes < MEMORY_WANTED_BYTES) warnings.push(`only ${gb(memory.available_bytes)} GB of memory available (free, inactive and speculative pages); the 8-shard setting wants about ${gb(MEMORY_WANTED_BYTES)} GB`);
  if (diskAvailable !== null && diskAvailable < diskWanted * 1.25) warnings.push(`${gb(diskAvailable)} GB free on the run's disk; the run writes about ${gb(diskWanted)} GB (${properties} properties)`);
  return {
    version: PREFLIGHT_VERSION,
    checked_at: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, total_memory_gb: gb(os.totalmem()) },
    swap: swap ? { total_gb: gb(swap.total_bytes), used_gb: gb(swap.used_bytes), free_gb: gb(swap.free_bytes) } : null,
    memory: memory ? { available_gb: gb(memory.available_bytes), free_gb: gb(memory.free_bytes) } : null,
    vm_processes: vms.map((item) => ({ pid: item.pid, rss_gb: gb(item.rss_bytes), command: item.command })),
    colima: { vm_running: colimaVmRunning, idle_supervisor_processes: idleColima.map((item) => ({ pid: item.pid, rss_gb: gb(item.rss_bytes), command: item.command })) },
    disk: { available_gb: gb(diskAvailable), wanted_gb: gb(diskWanted) },
    warnings,
    blocking: false,
  };
}
