#!/usr/bin/env bash
# Local test stack for the spikes in docs/design.md §12: Kanidm (OIDC) and Radicale (CalDAV).
#
#   ./spike.sh init                       create test certificates and the rules directory
#   ./spike.sh up                         start the stack, wait until Kanidm answers
#   ./spike.sh bootstrap                  create Kanidm test users, groups and OAuth2 clients
#   ./spike.sh token <user>               browserless login as the SPA client; print the tokens
#   ./spike.sh radicale <user> <METHOD> <path> [options]   call Radicale directly as that user
#   ./spike.sh kanidm <cli args>          run the Kanidm CLI as idm_admin
#   ./spike.sh status | logs [service] | down | reset
#
# Test environment only: self-signed certificates, known ports, throwaway passwords.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="$SPIKE_DIR/.local"
CERTS_DIR="$LOCAL/certs"
SECRETS="$LOCAL/secrets.env"

PROJECT='spike-s1'
NET="${PROJECT}_default"
IDM_URL='https://idm.localhost:8443'
SPA_REDIRECT='http://localhost:3000/auth/callback'
SPA_SCOPE='openid profile email groups caldav'
KANIDM_TOOLS_IMAGE="${KANIDM_TOOLS_IMAGE:-kanidm/tools:latest}"
PYTHON_IMAGE="${PYTHON_IMAGE:-python:3.12-alpine}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }

dc() { docker compose -p "$PROJECT" -f "$SPIKE_DIR/compose.yml" "$@"; }

# Run the Kanidm CLI inside the stack's network. A password is only passed for `login`.
kcli() {
  mkdir -p "$LOCAL/kanidm-home/.config"
  printf 'uri = "%s"\nca_path = "/ca.crt"\n' "$IDM_URL" >"$LOCAL/kanidm-home/.config/kanidm"
  # Run as the host user so the session store under kanidm-home is not owned by root.
  docker run --rm -i --user "$(id -u):$(id -g)" --network "$NET" -e HOME=/home/k \
    ${KPW:+-e KANIDM_PASSWORD="$KPW"} \
    -v "$LOCAL/kanidm-home:/home/k" -v "$CERTS_DIR/ca.crt:/ca.crt:ro" \
    "$KANIDM_TOOLS_IMAGE" /sbin/kanidm "$@" 2>&1 | grep -v 'should be owned be root'
}

# Run a script from tools/ in a throwaway Python container on the stack's network.
pytool() {
  local script="$1"
  shift
  docker run --rm --network "$NET" -v "$SPIKE_DIR/tools:/t:ro" -v "$CERTS_DIR/ca.crt:/ca.crt:ro" \
    "$PYTHON_IMAGE" python "/t/$script" "$@"
}

secret_set() {
  touch "$SECRETS"
  chmod 600 "$SECRETS"
  sed -i "/^$1=/d" "$SECRETS"
  printf '%s=%q\n' "$1" "$2" >>"$SECRETS"
}

secret_get() {
  [ -f "$SECRETS" ] || return 1
  # shellcheck disable=SC1090
  (. "$SECRETS" && eval "printf '%s' \"\${$1:-}\"")
}

gen_certs() {
  [ -f "$CERTS_DIR/server.crt" ] && return
  echo "Generating test CA and server certificate in $CERTS_DIR"
  mkdir -p "$CERTS_DIR"
  (
    cd "$CERTS_DIR"
    openssl ecparam -name prime256v1 -genkey -noout -out ca.key 2>/dev/null
    openssl req -x509 -new -key ca.key -sha256 -days 365 -subj '/CN=web-calendar spike test CA' \
      -out ca.crt
    openssl ecparam -name prime256v1 -genkey -noout -out server.sec1.key 2>/dev/null
    openssl pkcs8 -topk8 -nocrypt -in server.sec1.key -out server.key
    openssl req -new -key server.key -subj '/CN=idm.localhost' -out server.csr
    printf '%s\n' \
      'basicConstraints=CA:FALSE' \
      'keyUsage=digitalSignature' \
      'extendedKeyUsage=serverAuth' \
      'subjectAltName=DNS:idm.localhost,DNS:localhost,IP:127.0.0.1' >server.ext
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 365 -sha256 \
      -extfile server.ext -out server.crt 2>/dev/null
    # Kanidm wants the leaf first and the CA root last.
    cat server.crt ca.crt >kanidm-chain.pem
    rm -f server.sec1.key server.csr server.ext
    # Test keys only: make them readable by whatever user the containers run as.
    chmod 644 ./*.crt ./*.pem server.key ca.key
  )
}

cmd_init() {
  need openssl
  need docker
  mkdir -p "$LOCAL/rules"
  # Radicale's static rights and an empty group file (it refuses to start without them).
  [ -f "$LOCAL/rules/rights" ] || cp "$SPIKE_DIR/radicale/rights" "$LOCAL/rules/rights"
  [ -f "$LOCAL/rules/groups" ] || : >"$LOCAL/rules/groups"
  gen_certs
  echo "Init done. Next: ./spike.sh up"
}

wait_for_kanidm() {
  echo -n "Waiting for Kanidm"
  for _ in $(seq 1 60); do
    if curl -fsS --cacert "$CERTS_DIR/ca.crt" --resolve idm.localhost:8443:127.0.0.1 \
      "$IDM_URL/status" >/dev/null 2>&1; then
      echo " ok"
      return
    fi
    echo -n .
    sleep 2
  done
  echo " timed out; check './spike.sh logs kanidm'" >&2
  exit 1
}

cmd_up() {
  cmd_init >/dev/null
  dc up -d
  wait_for_kanidm
  cmd_status
}

cmd_status() {
  dc ps
  echo
  echo "Kanidm:   $IDM_URL   (test CA: $CERTS_DIR/ca.crt)"
  echo "Radicale: http://127.0.0.1:5232   (trusts X-Remote-User; use ./spike.sh radicale)"
}

kanidm_recover() {
  docker exec "${PROJECT}-kanidm-1" kanidmd recover-account "$1" 2>&1 |
    grep -o 'new_password: "[^"]*"' | head -1 | sed 's/new_password: "//; s/"$//'
}

cmd_bootstrap() {
  if [ -n "$(secret_get ALICE_PASSWORD)" ]; then
    echo "Already bootstrapped (credentials in $SECRETS). Use './spike.sh reset' to start over."
    return
  fi
  local admin_pw
  admin_pw="$(kanidm_recover idm_admin)"
  [ -n "$admin_pw" ] || { echo "could not recover the idm_admin account" >&2; exit 1; }
  secret_set KANIDM_IDM_ADMIN_PASSWORD "$admin_pw"
  KPW="$admin_pw" kcli login -D idm_admin
  local k=(kcli -D idm_admin)

  # Test users may log in with a password only (Kanidm's default requires MFA).
  "${k[@]}" group account-policy credential-type-minimum idm_all_persons any

  # alice is also in calendar_admins, to test admin detection.
  "${k[@]}" group create web_calendar_users
  "${k[@]}" group create calendar_admins
  for u in alice bob; do
    "${k[@]}" person create "$u" "${u^} Example"
    "${k[@]}" person update "$u" -m "$u@example.test"
    "${k[@]}" group add-members web_calendar_users "$u"
  done
  "${k[@]}" group add-members calendar_admins alice

  # A group of the identity provider for the live groups spec: the app lists it as a candidate and
  # an admin imports it; bob is in it.
  "${k[@]}" group create idp_team
  "${k[@]}" group add-members idp_team bob

  # The SPA's own client: public, PKCE. The custom scope "caldav" is what the gateway will require;
  # the server verifies the client's JWTs locally, so it needs no client of its own.
  "${k[@]}" system oauth2 create-public web-calendar 'Web Calendar' http://localhost:3000
  "${k[@]}" system oauth2 add-redirect-url web-calendar "$SPA_REDIRECT"
  "${k[@]}" system oauth2 enable-localhost-redirects web-calendar
  "${k[@]}" system oauth2 update-scope-map web-calendar web_calendar_users $SPA_SCOPE
  "${k[@]}" system oauth2 prefer-short-username web-calendar

  # Passwords through Kanidm's credential-update API, so no browser trusting the test CA is needed.
  for u in alice bob; do
    local tok pw
    tok="$("${k[@]}" person credential create-reset-token "$u" | grep -o 'use-reset-token [a-z0-9-]*' | awk '{print $2}')"
    pw="$(openssl rand -hex 10)-Spike-${u^}!"
    pytool kanidm_set_password.py "$IDM_URL" /ca.crt "$tok" "$pw"
    secret_set "${u^^}_PASSWORD" "$pw"
  done
  echo "Bootstrap done. Users alice and bob; their passwords are in $SECRETS"
}

cmd_token() {
  local user="${1:?usage: token <user>}"
  pytool spike_client.py token --idm "$IDM_URL" --ca /ca.crt --client web-calendar --user "$user" \
    --password "$(secret_get "${user^^}_PASSWORD")" --redirect "$SPA_REDIRECT" --scope "$SPA_SCOPE"
}

cmd_radicale() {
  local user="${1:?usage: radicale <user> <METHOD> <path> [options]}" method="${2:?}" path="${3:?}"
  shift 3
  pytool spike_client.py dav --url "http://radicale:5232$path" --remote-user "$user" --method "$method" "$@"
}

# Run any Kanidm CLI command as idm_admin, e.g. ./spike.sh kanidm system oauth2 list
cmd_kanidm() {
  KPW="$(secret_get KANIDM_IDM_ADMIN_PASSWORD)" kcli login -D idm_admin >/dev/null
  kcli -D idm_admin "$@"
}

cmd_down() { dc down; }

cmd_reset() {
  dc down --volumes --remove-orphans || true
  if [ -d "$LOCAL" ] && ! rm -rf "$LOCAL" 2>/dev/null; then
    # Files left behind by a container running as root.
    docker run --rm -v "$LOCAL:/x" "$PYTHON_IMAGE" sh -c 'rm -rf /x/* /x/.[!.]*'
    rm -rf "$LOCAL"
  fi
  echo "Removed containers, volumes and $LOCAL"
}

case "${1:-}" in
  init) cmd_init ;;
  up) cmd_up ;;
  bootstrap) cmd_bootstrap ;;
  token) shift; cmd_token "$@" ;;
  radicale) shift; cmd_radicale "$@" ;;
  kanidm) shift; cmd_kanidm "$@" ;;
  status) cmd_status ;;
  logs) shift; dc logs -f "$@" ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
