#!/bin/sh
set -eu

case "${RESTIC_REPOSITORY:-}" in
  rclone:*)
    exec /usr/bin/restic -o "rclone.timeout=${RESTIC_RCLONE_TIMEOUT:-10m}" "$@"
    ;;
  *)
    exec /usr/bin/restic "$@"
    ;;
esac
