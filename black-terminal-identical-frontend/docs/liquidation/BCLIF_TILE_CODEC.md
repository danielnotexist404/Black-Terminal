# BCLIF Tile Codec

The binary codec is deterministic, bounded, and architecture-neutral. Its envelope uses the `BCLF` magic, explicit schema/model versions, little-endian fields, canonical JSON metadata, typed numerical channels, compressed length, uncompressed length, and SHA-256 verification.

Exposure channels use bounded unsigned quantization with per-column scale metadata. Confidence, validity, and display-ready confirmed-event intensity use unsigned bytes, while `confirmedNotional` uses lossless-in-contract `Float32` values and `confirmedCount` uses `Uint16` values so compaction never sums display colors. The codec rejects unknown schemas/models, non-finite bounds, impossible dimensions, decompression bombs, truncation, trailing bytes, wrong channel lengths, inconsistent quantitative/display confirmed-event channels, and checksum mismatch. It never performs arbitrary object deserialization.

Objects use `application/octet-stream` in private Supabase Storage. Metadata is inserted only after upload/read-back verification. Repository codec/corruption contracts run on the local Node 22 environment. The container is packaged for linux/amd64 and linux/arm64, but neither architecture is production-certified until both images are built and exercised on an available host.
