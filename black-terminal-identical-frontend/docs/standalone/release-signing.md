# Standalone release signing

The repository can build and inspect Windows, Linux, and universal macOS installers without private credentials. Public trust requires credentials that must be supplied by the Black Triangle Group release owner through protected CI secrets; they must never be committed to the repository or included in a profile migration archive.

## Current unsigned-beta behavior

- Windows installers are functional but Windows SmartScreen may warn until an organization/EV or approved cloud-signing certificate is configured.
- macOS builds receive an ad-hoc signature so Apple Silicon does not treat the universal binary as structurally unsigned. Ad-hoc signing is not publisher identity and does not replace Developer ID signing or Apple notarization.
- Linux packages are accompanied by a SHA-256 manifest. Repository/package signing and a trusted update channel remain release-owner tasks.

## Required production credentials

### Windows

Use a current organization/EV code-signing certificate or Azure Artifact Signing profile. Import or access it only inside the protected Windows CI job, configure a SHA-256 timestamped signing command, and verify both the application executable and the final NSIS/MSI signatures before upload.

### macOS

Provide a `Developer ID Application` certificate through protected `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` secrets. Provide either App Store Connect API credentials (`APPLE_API_ISSUER`, `APPLE_API_KEY`, and the private key path) or the supported Apple ID notarization credentials. Verify the deep signature, submit for notarization, staple the result, and run Gatekeeper assessment on the final DMG.

### Mobile

Android requires a protected upload keystore for distributable APK/AAB builds. iOS requires an Apple Distribution certificate, registered bundle identifier, and provisioning profile. Mobile background policy means those packages are companion clients, not unattended strategy hosts.

## Release-owner gate

1. Store credentials in a protected GitHub environment with manual approval and tag-only access.
2. Build from an immutable release tag.
3. Verify installer package magic, required architectures, and SHA-256 manifests in CI.
4. Verify platform signatures after packaging, then publish exactly the verified hashes.
5. Install, upgrade, restart, and uninstall on clean physical or virtual machines before promotion.

The release must remain labelled beta until these identity, notarization, clean-machine, and trading-system gates are complete.
