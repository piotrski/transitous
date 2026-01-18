#!/bin/sh
set -eu

MOTIS_CONFIG="${MOTIS_CONFIG:-/var/lib/motis/config.yml}"

if [ ! -f "${MOTIS_CONFIG}" ]; then
  echo "MOTIS config not found at ${MOTIS_CONFIG}." >&2
  echo "Generate it with ./src/generate-motis-config.py and mount it into the container." >&2
  exit 1
fi

if [ ! -d "/var/lib/motis/data" ]; then
  echo "Warning: /var/lib/motis/data is missing. Run 'motis import' before starting the server." >&2
fi

exec /opt/motis/motis server -c "${MOTIS_CONFIG}" "$@"
