import { readFile } from "node:fs/promises";
import type { QalcTelemetry } from "./contracts.ts";
import { writeAtomic } from "./archive.ts";

export class QalcStateStore {
  constructor(privatePath: string) { this.path = privatePath; }
  private readonly path: string;
  async write(telemetry: QalcTelemetry) { await writeAtomic(this.path, JSON.stringify(telemetry)); }
  async read(): Promise<QalcTelemetry | undefined> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as QalcTelemetry; }
    catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
  }
}
