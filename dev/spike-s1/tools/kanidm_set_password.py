#!/usr/bin/env python3
"""Set a password on a Kanidm person from a credential reset token (test stack only).

Replays what the web UI does: exchange the reset token for a credential-update session, set the
password, commit. Lets the test stack be provisioned without a browser that trusts the test CA.

usage: kanidm_set_password.py <base-url> <ca.crt> <reset-token> <password>
"""
import json
import ssl
import sys
import urllib.error
import urllib.request


def post(ctx, base, path, body):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, context=ctx) as resp:
            return json.loads(resp.read() or 'null')
    except urllib.error.HTTPError as err:
        sys.exit(f'{path}: HTTP {err.code}: {err.read().decode()[:400]}')


def main():
    base, ca, token, password = sys.argv[1:5]
    ctx = ssl.create_default_context(cafile=ca)
    session, _status = post(ctx, base, '/v1/credential/_exchange_intent', token)
    status = post(ctx, base, '/v1/credential/_update', [{'password': password}, session])
    problems = status.get('mfaregister') or status.get('can_commit') is False
    if problems:
        sys.exit(f'password not accepted: {json.dumps(status)[:400]}')
    post(ctx, base, '/v1/credential/_commit', session)
    print('password set')


if __name__ == '__main__':
    main()
