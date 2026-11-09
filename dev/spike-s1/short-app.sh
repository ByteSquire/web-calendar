#!/bin/sh
# The app's dev server on http://localhost:3000, signing in through the test stack's Kanidm with the
# client web-calendar-short (`./spike.sh short-session` creates it), to try out an expiring sign-in
# in your own browser (README: "Trying out an expiring sign-in"). Runs in the Dev Container, which
# must be on the stack's network (`docker network connect spike-s1_default <container>`):
#
#   docker exec -it -u node -w /workspaces/web-calendar intelligent_mayer sh dev/spike-s1/short-app.sh
#
# Its own database (.data/spike-short.db), so your development data and the live suite's stay apart.
# Test stack only: the token hash key below is not a secret.
set -eu
cd "$(dirname "$0")/../.."

CA=dev/spike-s1/.local/certs/ca.crt
[ -f "$CA" ] || { echo "No test CA at $CA: run ./spike.sh up on the host first." >&2; exit 1; }

export NUXT_OIDC_ISSUER=https://idm.localhost:8443/oauth2/openid/web-calendar-short
export NUXT_OIDC_CLIENT_ID=web-calendar-short
export NUXT_RADICALE_URL=http://radicale:5232
export NUXT_TOKEN_HASH_KEY=spike-short-session-test-key-not-secret
export NUXT_DB_PATH=.data/spike-short.db
# The server fetches Kanidm's discovery document and keys over https.
export NODE_EXTRA_CA_CERTS="$CA"
exec npx nuxt dev --port 3000
