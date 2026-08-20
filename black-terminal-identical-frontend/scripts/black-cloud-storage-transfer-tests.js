import assert from "node:assert/strict";
import { safeObjectPath } from "./black-cloud-storage-transfer.js";

assert.equal(safeObjectPath("professional-media", "profiles/user/avatar.png"), "professional-media/profiles/user/avatar.png");
for (const unsafe of ["../secret", "folder/../../secret", "/absolute", "folder\\secret", "folder//secret"]) {
  assert.throws(() => safeObjectPath("bucket", unsafe), /Unsafe storage/);
}
assert.throws(() => safeObjectPath("../bucket", "safe.txt"), /Unsafe storage/);
console.log("Black Cloud storage transfer path and traversal contracts passed.");
