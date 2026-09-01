import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] || "src-tauri/target/release/bundle");
const output = join(root, "black-terminal-release-manifest.json");

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (entry.isFile() && path !== output) result.push(path);
  }
  return result;
}

const artifacts = [];
for (const path of (await filesUnder(root)).sort()) {
  const bytes = await readFile(path);
  const details = await stat(path);
  artifacts.push({
    path: relative(root, path).replaceAll("\\", "/"),
    bytes: details.size,
    sha256: createHash("sha256").update(bytes).digest("hex")
  });
}

const manifest = {
  schemaVersion: 1,
  product: "Black Terminal",
  version: process.env.npm_package_version || "1.0.7",
  generatedAt: new Date().toISOString(),
  bundleRoot: basename(root),
  artifactCount: artifacts.length,
  artifacts
};

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "w" });
console.log(`Release manifest: ${output} (${artifacts.length} artifacts)`);
