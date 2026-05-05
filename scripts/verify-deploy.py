#!/usr/bin/env python3
"""Confirm the lens-proxy worker was just (re)deployed by querying the CF API.
Used by the GH Actions workflow because GH IPs are firewalled by CF on the
lens.ask-meridian.uk zone (HTTP 403 from the edge regardless of UA)."""
import datetime as dt
import json
import os
import sys
import urllib.request

CF_EMAIL   = os.environ['CF_EMAIL']
CF_KEY     = os.environ['CF_KEY']
CF_ACCOUNT = os.environ['CF_ACCOUNT']

req = urllib.request.Request(
    f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/workers/scripts',
    headers={'X-Auth-Email': CF_EMAIL, 'X-Auth-Key': CF_KEY},
)
with urllib.request.urlopen(req, timeout=20) as r:
    data = json.load(r)

script = next((s for s in data.get('result', []) if s['id'] == 'lens-proxy'), None)
if not script:
    sys.exit('lens-proxy script not found on this account')
modified = script['modified_on']
age = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(modified)).total_seconds()
print(f'lens-proxy modified_on={modified}  ({age:.0f}s ago)')
if age >= 300:
    sys.exit(f'modified_on is {age:.0f}s old; this run did not deploy a fresh script')
