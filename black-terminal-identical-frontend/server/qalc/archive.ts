import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { QalcMarketEvent, QalcSymbol } from "./contracts.ts";

export type QalcArchiveManifest = { path: string; checksum: string; eventCount: number; bytes: number; firstEventAt?: number; lastEventAt?: number; closedAt: number };

export class QalcEventArchive {
  private readonly runId: string;
  private stream?: ReturnType<typeof createGzip>;
  private file?: ReturnType<typeof createWriteStream>;
  private path?: string;
  private partition?: string;
  private eventCount = 0;
  private firstEventAt?: number;
  private lastEventAt?: number;

  constructor(privateRoot: string, privateSymbol: QalcSymbol, runId: string = randomUUID()) {
    this.root = privateRoot;
    this.symbol = privateSymbol;
    this.runId = runId;
  }
  private readonly root: string;
  private readonly symbol: QalcSymbol;

  async append(event: QalcMarketEvent) {
    const partition = hourlyPartition(event.receiveTimestamp);
    if (partition !== this.partition) { await this.close(); await this.open(partition, event.receiveTimestamp); }
    this.eventCount += 1;
    this.firstEventAt ||= event.receiveTimestamp;
    this.lastEventAt = event.receiveTimestamp;
    if (!this.stream?.write(`${JSON.stringify(event)}\n`)) await new Promise<void>((resolve) => this.stream?.once("drain", resolve));
  }

  async close(): Promise<QalcArchiveManifest | undefined> {
    if (!this.stream || !this.file || !this.path) return undefined;
    const stream = this.stream;
    const file = this.file;
    await new Promise<void>((resolve, reject) => { file.once("close", resolve); file.once("error", reject); stream.end(); });
    const data = await readFile(this.path);
    const manifest: QalcArchiveManifest = {
      path: this.path, checksum: createHash("sha256").update(data).digest("hex"), eventCount: this.eventCount,
      bytes: (await stat(this.path)).size, firstEventAt: this.firstEventAt, lastEventAt: this.lastEventAt, closedAt: Date.now(),
    };
    await writeAtomic(`${this.path}.manifest.json`, JSON.stringify(manifest, null, 2));
    this.stream = undefined; this.file = undefined; this.path = undefined; this.partition = undefined;
    this.eventCount = 0; this.firstEventAt = undefined; this.lastEventAt = undefined;
    return manifest;
  }

  private async open(partition: string, time: number) {
    const date = new Date(time);
    const folder = join(this.root, "BYBIT", "linear", this.symbol, String(date.getUTCFullYear()), two(date.getUTCMonth() + 1), two(date.getUTCDate()), two(date.getUTCHours()));
    await mkdir(folder, { recursive: true, mode: 0o750 });
    this.path = join(folder, `${this.runId}-${time}.ndjson.gz`);
    this.partition = partition;
    this.file = createWriteStream(this.path, { flags: "wx", mode: 0o640 });
    this.stream = createGzip({ level: 6 });
    this.stream.pipe(this.file);
  }
}

export async function* replayArchivedEvents(path: string): AsyncGenerator<QalcMarketEvent> {
  const input = createReadStream(path);
  const lines = createInterface({ input: input.pipe(createGunzip()), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) if (line.trim()) yield JSON.parse(line) as QalcMarketEvent;
}

export async function writeAtomic(path: string, contents: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o640 });
  await rename(temporary, path);
}

function hourlyPartition(time: number) { return new Date(time).toISOString().slice(0, 13); }
function two(value: number) { return String(value).padStart(2, "0"); }
