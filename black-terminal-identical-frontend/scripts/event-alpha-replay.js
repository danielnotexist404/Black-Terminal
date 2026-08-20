import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { runPointInTimeEventReplay } from "../server/event-alpha/replay.js";

const args = process.argv.slice(2);
const inputIndex = args.indexOf("--input");
const outputIndex = args.indexOf("--output");
if (inputIndex < 0 || !args[inputIndex + 1]) {
  console.error("Usage: npm run event-alpha:replay -- --input <fixture.json> [--output <result.json>]");
  process.exitCode = 2;
} else {
  const inputPath = path.resolve(args[inputIndex + 1]);
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result = runPointInTimeEventReplay(input);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputIndex >= 0 && args[outputIndex + 1]) fs.writeFileSync(path.resolve(args[outputIndex + 1]), serialized, { flag: "wx" });
  else process.stdout.write(serialized);
}
