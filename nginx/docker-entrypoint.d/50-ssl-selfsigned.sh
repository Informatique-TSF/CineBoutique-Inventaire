#!/bin/sh
# Génère un certificat auto-signé si aucun certificat n'est monté (dev / docker compose local).
# En production, ./ssl est monté en lecture seule avec fullchain.pem et privkey.pem : ce script ne fait rien.
set -eu
CERT_DIR="/etc/nginx/certs"
CRT="$CERT_DIR/fullchain.pem"
KEY="$CERT_DIR/privkey.pem"
if [ -f "$CRT" ] && [ -f "$KEY" ]; then
  exit 0
fi
mkdir -p "$CERT_DIR"
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "$KEY" -out "$CRT" \
  -subj "/CN=${PUBLIC_HOST:-localhost}" >/dev/null 2>&1
echo "[nginx] certificat auto-signé généré pour ${PUBLIC_HOST:-localhost} (dev uniquement)"
