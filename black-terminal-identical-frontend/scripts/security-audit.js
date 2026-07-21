import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
if (!fs.existsSync(dist)) fail("dist does not exist; run the production build first.");

const files = walk(dist).filter((file) => /\.(?:js|css|html|json)$/i.test(file));
const findings = [];
const forbidden = [
  ["Resend endpoint", /api\.resend\.com/gi],
  ["Resend API key", /re_[A-Za-z0-9_-]{32,}/g],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{16,}/g],
  ["server credential variable", /VITE_(?:RESEND|CLAUDE|ANTHROPIC)_[A-Z0-9_]+/g],
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
];

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  for (const [label, pattern] of forbidden) if (pattern.test(content)) findings.push(`${label} in ${path.relative(root, file)}`);
  for (const token of content.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      if (payload.role === "service_role") findings.push(`Supabase service-role token in ${path.relative(root, file)}`);
    } catch { /* Non-JWT string. */ }
  }
}

const sourceFiles = walk(path.join(root, "src")).filter((file) => /\.(?:ts|tsx|js|jsx)$/i.test(file));
for (const file of sourceFiles) {
  const content = fs.readFileSync(file, "utf8");
  const sensitiveViteNames = content.match(/VITE_[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*/g) || [];
  for (const name of sensitiveViteNames) if (name !== "VITE_SUPABASE_ANON_KEY") findings.push(`frontend secret variable ${name} in ${path.relative(root, file)}`);
  if (/api\.resend\.com/.test(content)) findings.push(`direct provider call in ${path.relative(root, file)}`);
}

if (findings.length) fail([...new Set(findings)].join("\n"));
console.log(`Security audit passed: ${files.length} production assets contain no provider secrets.`);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(resolved) : [resolved];
  });
}

function fail(message) {
  console.error(`Security audit failed:\n${message}`);
  process.exit(1);
}
