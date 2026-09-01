/**
 * Deterministic, non-cryptographic identifier for replay identities.
 *
 * These values are deduplication keys rather than signatures. Keeping the
 * implementation platform-neutral lets the exact QALC core run in Node.js and
 * in the standalone Tauri webview without a Node crypto polyfill.
 */
export function stableQalcId(prefix: string, ...parts: string[]) {
  const value = [prefix, ...parts].join("\u001f");
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const words = seeds.map((seed, lane) => {
    let hash = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index) + lane * 131;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= hash >>> 13;
    }
    return hash.toString(16).padStart(8, "0");
  });
  return `qalc-${words.join("")}`;
}
