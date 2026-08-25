import assert from "node:assert/strict";
import { resolveSupabaseServerSecret } from "../server/portfolio-api.js";

const opaqueSecret = "sb_secret_fixture_control_plane";
const serviceRoleJwt = "eyJhbGciOiJIUzI1NiJ9.fixture.signature";

assert.equal(
  resolveSupabaseServerSecret({
    SUPABASE_SECRET_KEY: opaqueSecret,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleJwt
  }),
  opaqueSecret,
  "ordinary server calls must retain the configured opaque Supabase secret precedence"
);

assert.equal(
  resolveSupabaseServerSecret({
    SUPABASE_SECRET_KEY: opaqueSecret,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleJwt
  }, { storageCompatible: true }),
  serviceRoleJwt,
  "storage-backed server calls must select the JWT-compatible service-role credential"
);

assert.equal(
  resolveSupabaseServerSecret({ SUPABASE_SECRET_KEY: opaqueSecret }, { storageCompatible: true }),
  opaqueSecret,
  "storage mode must retain the opaque key fallback when no legacy service-role JWT is configured"
);

assert.equal(resolveSupabaseServerSecret({}, { storageCompatible: true }), "");

console.log("Supabase storage credential selection tests passed");
