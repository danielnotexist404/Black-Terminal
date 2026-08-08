import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const temporaryRoot = mkdtempSync(join(tmpdir(), "bclif-client-contracts-"));
const output = join(temporaryRoot, "contracts.mjs");
try {
  await build({
    entryPoints: [new URL("./bclif-client-contract-tests.ts", import.meta.url).pathname],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    define: { "import.meta.env": "{}" },
    logLevel: "silent"
  });
  await import(pathToFileURL(output).href);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
