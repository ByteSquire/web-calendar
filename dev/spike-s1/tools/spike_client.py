#!/usr/bin/env python3
"""Test client for the S1 stack (standard library only; test stack only).

  token  Log in to Kanidm as a user and run the OAuth2 authorization-code + PKCE flow for a client,
         without a browser. Prints the token response as JSON.
  dav    Send one WebDAV/CalDAV request (for example PROPFIND), optionally with a bearer token or an
         X-Remote-User header.

The user's password is sent to Kanidm's own login API, exactly as its web UI does.
"""
import argparse
import base64
import hashlib
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def opener(ca):
    ctx = ssl.create_default_context(cafile=ca)
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), NoRedirect)


def send(op, url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with op.open(req) as resp:
            return resp.status, dict(resp.headers), resp.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read().decode()


def post_json(op, url, body, headers=None):
    hdrs = {'Content-Type': 'application/json', **(headers or {})}
    return send(op, url, json.dumps(body).encode(), hdrs, 'POST')


def kanidm_login(op, idm, user, password):
    status, hdrs, body = post_json(
        op, idm + '/v1/auth', {'step': {'init2': {'username': user, 'issue': 'token', 'privileged': False}}}
    )
    if status != 200:
        sys.exit(f'login init failed: HTTP {status} {body[:300]}')
    session = {'X-KANIDM-AUTH-SESSION-ID': {k.lower(): v for k, v in hdrs.items()}['x-kanidm-auth-session-id']}
    post_json(op, idm + '/v1/auth', {'step': {'begin': 'password'}}, session)
    status, _, body = post_json(op, idm + '/v1/auth', {'step': {'cred': {'password': password}}}, session)
    state = json.loads(body).get('state') if status == 200 else None
    if not isinstance(state, dict) or 'success' not in state:
        sys.exit(f'login failed: HTTP {status} {body[:300]}')
    return state['success']


def cmd_token(args):
    op = opener(args.ca)
    jws = kanidm_login(op, args.idm, args.user, args.password)
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    query = urllib.parse.urlencode(
        {
            'client_id': args.client,
            'response_type': 'code',
            'redirect_uri': args.redirect,
            'scope': args.scope,
            'state': 'spike',
            'code_challenge': challenge,
            'code_challenge_method': 'S256',
        }
    )
    auth = {'Authorization': 'Bearer ' + jws}
    status, hdrs, body = send(op, f'{args.idm}/oauth2/authorise?{query}', headers=auth)
    if status == 200 and 'ConsentRequested' in body:
        # Public clients cannot skip the consent prompt; approve it like the web UI does.
        consent = json.loads(body)['ConsentRequested']['consent_token']
        permit = f'{args.idm}/oauth2/authorise/permit?token={urllib.parse.quote(consent)}'
        status, hdrs, body = send(op, permit, headers=auth)
    location = {k.lower(): v for k, v in hdrs.items()}.get('location', '')
    code = urllib.parse.parse_qs(urllib.parse.urlparse(location).query).get('code', [None])[0]
    if status != 302 or not code:
        sys.exit(f'authorise failed: HTTP {status} {body[:300]} {location[:200]}')
    form = {
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': args.redirect,
        'code_verifier': verifier,
        'client_id': args.client,
    }
    headers = {'Content-Type': 'application/x-www-form-urlencoded'}
    if args.secret:
        basic = base64.b64encode(f'{args.client}:{args.secret}'.encode()).decode()
        headers['Authorization'] = 'Basic ' + basic
    status, _, body = send(op, args.idm + '/oauth2/token', urllib.parse.urlencode(form).encode(), headers, 'POST')
    if status != 200:
        sys.exit(f'token exchange failed: HTTP {status} {body[:300]}')
    print(body)


def cmd_dav(args):
    op = opener(args.ca)
    headers = {'Depth': args.depth, 'Content-Type': args.content_type}
    if args.token:
        headers['Authorization'] = 'Bearer ' + args.token
    if args.remote_user:
        # What the app's gateway will send to Radicale; the test stack trusts this header directly.
        headers['X-Remote-User'] = args.remote_user
    if args.header:
        name, _, value = args.header.partition(':')
        headers[name.strip()] = value.strip()
    payload = args.body
    if not payload and args.method == 'PROPFIND':
        payload = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>'
    status, hdrs, body = send(op, args.url, payload.encode() if payload else None, headers, args.method)
    print(f'HTTP {status}')
    for key in ('www-authenticate', 'dav', 'location', 'content-type'):
        value = {k.lower(): v for k, v in hdrs.items()}.get(key)
        if value:
            print(f'{key}: {value}')
    print(body[: args.limit])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    tok = sub.add_parser('token')
    tok.add_argument('--idm', required=True)
    tok.add_argument('--ca', required=True)
    tok.add_argument('--client', required=True)
    tok.add_argument('--secret', default='')
    tok.add_argument('--scope', default='openid profile email')
    tok.add_argument('--redirect', required=True)
    tok.add_argument('--user', required=True)
    tok.add_argument('--password', required=True)
    tok.set_defaults(func=cmd_token)
    dav = sub.add_parser('dav')
    dav.add_argument('--url', required=True)
    dav.add_argument('--ca', default='/ca.crt')
    dav.add_argument('--token', default='')
    dav.add_argument('--remote-user', default='')
    dav.add_argument('--method', default='PROPFIND')
    dav.add_argument('--depth', default='1')
    dav.add_argument('--body', default='')
    dav.add_argument('--content-type', default='application/xml')
    dav.add_argument('--header', default='', help='one extra header, "Name: value"')
    dav.add_argument('--limit', type=int, default=1500)
    dav.set_defaults(func=cmd_dav)
    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
