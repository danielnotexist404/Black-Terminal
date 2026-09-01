import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(process.argv[2] || "src-tauri/target/release/bundle");
const platform = String(process.argv[3] || process.platform).trim().toLowerCase();

async function walk(directory) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    entries.push({ path, name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
    if (entry.isDirectory()) entries.push(...await walk(path));
  }
  return entries;
}

function requireEntry(entries, description, predicate) {
  const match = entries.find(predicate);
  if (!match) throw new Error(`Missing ${description} under ${root}`);
  return match.path;
}

async function requireSize(path, minimum) {
  const details = await stat(path);
  if (!details.isFile() || details.size < minimum) {
    throw new Error(`${basename(path)} is smaller than the ${minimum}-byte package floor`);
  }
  return details.size;
}

async function prefix(path, bytes) {
  return (await readFile(path)).subarray(0, bytes);
}

async function suffix(path, bytes) {
  const contents = await readFile(path);
  return contents.subarray(Math.max(0, contents.length - bytes));
}

function requireMagic(actual, expected, description) {
  if (!actual.subarray(0, expected.length).equals(expected)) {
    throw new Error(`${description} has an invalid file signature`);
  }
}

async function verifyWindows(entries) {
  const nsis = requireEntry(entries, "Windows NSIS installer", ({ file, name }) => file && name.toLowerCase().endsWith("-setup.exe"));
  const msi = requireEntry(entries, "Windows MSI installer", ({ file, name }) => file && name.toLowerCase().endsWith(".msi"));
  const sizes = await Promise.all([requireSize(nsis, 10_000_000), requireSize(msi, 10_000_000)]);
  requireMagic(await prefix(nsis, 2), Buffer.from("MZ"), "NSIS installer");
  requireMagic(await prefix(msi, 8), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "MSI installer");
  return [{ type: "nsis", path: nsis, bytes: sizes[0] }, { type: "msi", path: msi, bytes: sizes[1] }];
}

async function verifyLinux(entries) {
  const appImage = requireEntry(entries, "Linux AppImage", ({ file, name }) => file && name.endsWith(".AppImage"));
  const deb = requireEntry(entries, "Debian package", ({ file, name }) => file && name.endsWith(".deb"));
  const rpm = requireEntry(entries, "RPM package", ({ file, name }) => file && name.endsWith(".rpm"));
  const sizes = await Promise.all([requireSize(appImage, 5_000_000), requireSize(deb, 5_000_000), requireSize(rpm, 5_000_000)]);
  const elf = await prefix(appImage, 20);
  requireMagic(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "AppImage");
  if (elf.readUInt16LE(18) !== 62) throw new Error("AppImage is not an x86-64 ELF package");
  requireMagic(await prefix(deb, 8), Buffer.from("!<arch>\n"), "Debian package");
  requireMagic(await prefix(rpm, 4), Buffer.from([0xed, 0xab, 0xee, 0xdb]), "RPM package");
  return [
    { type: "appimage", path: appImage, bytes: sizes[0] },
    { type: "deb", path: deb, bytes: sizes[1] },
    { type: "rpm", path: rpm, bytes: sizes[2] }
  ];
}

function fatArchitectures(header) {
  const magic = header.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) {
    throw new Error("macOS application executable is not a universal Mach-O binary");
  }
  const count = header.readUInt32BE(4);
  const stride = magic === 0xcafebabf ? 32 : 20;
  const architectures = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * stride;
    if (offset + 4 > header.length) throw new Error("Universal Mach-O header is truncated");
    architectures.push(header.readUInt32BE(offset));
  }
  return architectures;
}

async function verifyMac(entries) {
  const dmg = requireEntry(entries, "macOS DMG", ({ file, name }) => file && name.endsWith(".dmg"));
  const app = requireEntry(entries, "macOS application bundle", ({ directory, name }) => directory && name.endsWith(".app"));
  const info = requireEntry(entries, "macOS Info.plist", ({ file, path }) => file && path === join(app, "Contents", "Info.plist"));
  const executableRoot = join(app, "Contents", "MacOS");
  const executable = requireEntry(entries, "macOS application executable", ({ file, path }) => file && path.startsWith(`${executableRoot}/`));
  const sizes = await Promise.all([requireSize(dmg, 5_000_000), requireSize(executable, 5_000_000), requireSize(info, 100)]);
  requireMagic(await suffix(dmg, 512), Buffer.from("koly"), "DMG trailer");
  const architectures = fatArchitectures(await prefix(executable, 256));
  if (!architectures.includes(0x01000007) || !architectures.includes(0x0100000c)) {
    throw new Error("macOS application does not contain both x86_64 and arm64 architectures");
  }
  return [
    { type: "dmg", path: dmg, bytes: sizes[0] },
    { type: "app-universal", path: app, executableBytes: sizes[1], architectures: ["x86_64", "arm64"] }
  ];
}

const entries = await walk(root);
let packages;
if (platform === "windows" || platform === "win32") packages = await verifyWindows(entries);
else if (platform === "linux") packages = await verifyLinux(entries);
else if (platform === "macos" || platform === "darwin") packages = await verifyMac(entries);
else throw new Error(`Unsupported standalone package platform: ${platform}`);

console.log(JSON.stringify({ verified: true, platform, root, packages }, null, 2));
