import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const root = process.env.BLACK_CLOUD_STORAGE_TRANSFER_ROOT ? path.resolve(process.env.BLACK_CLOUD_STORAGE_TRANSFER_ROOT) : null;
if (invokedDirectly) {
  if (!root || root === path.parse(root).root) throw new Error("BLACK_CLOUD_STORAGE_TRANSFER_ROOT must be a dedicated directory.");
  const mode = process.argv[2];
  if (mode === "export") await exportStorage();
  else if (mode === "import") await importStorage();
  else throw new Error("Usage: node scripts/black-cloud-storage-transfer.js export|import");
}

async function exportStorage() {
  const source = storageClient("SOURCE_SUPABASE_URL", "SOURCE_SUPABASE_SERVICE_KEY");
  await mkdir(root, { recursive: false, mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const { data: buckets, error } = await source.storage.listBuckets();
  if (error) throw safeError("STORAGE_BUCKET_LIST_FAILED", error);
  const manifest = { format: "black-cloud-storage-v1", createdAt: new Date().toISOString(), buckets: [], objects: [] };
  for (const bucket of buckets || []) {
    validateSegment(bucket.id);
    manifest.buckets.push({ id: bucket.id, name: bucket.name, public: Boolean(bucket.public), fileSizeLimit: bucket.file_size_limit ?? null, allowedMimeTypes: bucket.allowed_mime_types ?? null });
    const names = await listObjectNames(source, bucket.id);
    for (const name of names) {
      const relative = safeObjectPath(bucket.id, name);
      const { data, error: downloadError } = await source.storage.from(bucket.id).download(name);
      if (downloadError || !data) throw safeError("STORAGE_OBJECT_DOWNLOAD_FAILED", downloadError);
      const bytes = Buffer.from(await data.arrayBuffer());
      const target = path.join(root, "objects", relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600 });
      manifest.objects.push({ bucketId: bucket.id, name, bytes: bytes.length, sha256: sha256(bytes), contentType: data.type || "application/octet-stream" });
    }
  }
  manifest.buckets.sort((a, b) => a.id.localeCompare(b.id));
  manifest.objects.sort((a, b) => `${a.bucketId}/${a.name}`.localeCompare(`${b.bucketId}/${b.name}`));
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: "exported", bucketCount: manifest.buckets.length, objectCount: manifest.objects.length, bytes: manifest.objects.reduce((sum, item) => sum + item.bytes, 0) }));
}

async function importStorage() {
  const target = storageClient("TARGET_SUPABASE_URL", "TARGET_SUPABASE_SERVICE_KEY");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.format !== "black-cloud-storage-v1" || !Array.isArray(manifest.buckets) || !Array.isArray(manifest.objects)) throw new Error("Storage manifest is invalid.");
  const { data: existing, error: listError } = await target.storage.listBuckets();
  if (listError) throw safeError("TARGET_BUCKET_LIST_FAILED", listError);
  const existingIds = new Set((existing || []).map((item) => item.id));
  for (const bucket of manifest.buckets) {
    validateSegment(bucket.id);
    if (!existingIds.has(bucket.id)) {
      const { error } = await target.storage.createBucket(bucket.id, { public: Boolean(bucket.public), fileSizeLimit: bucket.fileSizeLimit || undefined, allowedMimeTypes: bucket.allowedMimeTypes || undefined });
      if (error) throw safeError("TARGET_BUCKET_CREATE_FAILED", error);
    }
  }
  for (const item of manifest.objects) {
    const relative = safeObjectPath(item.bucketId, item.name);
    const file = path.join(root, "objects", relative);
    const info = await stat(file);
    if (info.size !== item.bytes) throw new Error(`Storage size mismatch before import: ${relative}`);
    const bytes = await readFile(file);
    if (sha256(bytes) !== item.sha256) throw new Error(`Storage checksum mismatch before import: ${relative}`);
    const { error } = await target.storage.from(item.bucketId).upload(item.name, bytes, { upsert: true, contentType: item.contentType || "application/octet-stream", cacheControl: "3600" });
    if (error) throw safeError("TARGET_OBJECT_UPLOAD_FAILED", error);
    const { data: verified, error: verifyError } = await target.storage.from(item.bucketId).download(item.name);
    if (verifyError || !verified) throw safeError("TARGET_OBJECT_VERIFY_FAILED", verifyError);
    const verifiedBytes = Buffer.from(await verified.arrayBuffer());
    if (sha256(verifiedBytes) !== item.sha256) throw new Error(`Target storage checksum mismatch: ${relative}`);
  }
  console.log(JSON.stringify({ status: "imported-and-verified", bucketCount: manifest.buckets.length, objectCount: manifest.objects.length }));
}

async function listObjectNames(client, bucketId) {
  const output = [];
  const pending = [""];
  while (pending.length) {
    const prefix = pending.pop();
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.storage.from(bucketId).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw safeError("STORAGE_OBJECT_LIST_FAILED", error);
      for (const item of data || []) {
        validateSegment(item.name);
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id || item.metadata) output.push(name); else pending.push(name);
      }
      if ((data || []).length < 1000) break;
    }
  }
  return [...new Set(output)].sort();
}

function storageClient(urlName, keyName) {
  const url = process.env[urlName];
  const key = process.env[keyName];
  if (!url || !key) throw new Error(`${urlName} and ${keyName} are required.`);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

export function safeObjectPath(bucketId, objectName) {
  validateSegment(bucketId);
  const segments = String(objectName || "").split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) throw new Error("Unsafe storage object path.");
  return path.join(bucketId, ...segments);
}

function validateSegment(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(String(value || "")) || value === "." || value === "..") throw new Error("Unsafe storage path segment.");
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function safeError(code, cause) { return Object.assign(new Error(`${code}: storage operation failed.`), { code, cause: cause?.message }); }
