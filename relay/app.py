"""Render-hosted residential relay: TLS-impersonated embed-HTML fetch.

GET /health            -> {ok:true}
GET /manifest?docId=.. -> {status,len,challenged,pageCount,title,inline,jsonpUrls}

Heavy page-image/JSONP traffic goes client-direct (CORS *); this relay only
serves the tiny manifest HTML (~250KB) which is what Scribd challenges.
"""
import os
import re

from curl_cffi import requests as cr
from flask import Flask, jsonify, request

from manifest import extract_manifest

app = Flask(__name__)

# Public embed key (ships inside every public embed page's HTML — not a
# password). Fully env-configured so the repo holds no key-like literal for
# GitHub push protection. Set SCRIBD_ACCESS_KEY (or SCRIBD_KEY_A + SCRIBD_KEY_B)
# on Render / CI / Worker from the value visible in any embed HTML.
ACCESS_KEY = os.environ.get("SCRIBD_ACCESS_KEY", "") or (
    os.environ.get("SCRIBD_KEY_A", "") + os.environ.get("SCRIBD_KEY_B", "")
)
EMBED = ("https://www.scribd.com/embeds/{doc}/content?start_page=1"
         "&view_mode=scroll&access_key=" + ACCESS_KEY)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
DOC_RE = re.compile(r"^\d{5,}$")


@app.get("/health")
def health():
    return jsonify(ok=True)


@app.get("/")
def index():
    return jsonify(ok=True, usage="/manifest?docId=<scribd-id>")


@app.get("/manifest")
def manifest():
    doc = (request.args.get("docId") or "").strip()
    if not DOC_RE.match(doc):
        return jsonify(ok=False, error="invalid docId"), 400
    try:
        s = cr.Session(impersonate="chrome124")
        r = s.get(EMBED.format(doc=doc), timeout=45,
                  headers={"User-Agent": UA,
                           "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                           "Accept-Language": "en-US,en;q=0.9",
                           "Referer": "https://www.scribd.com/"})
        html = r.text
    except Exception as e:  # noqa: BLE001 - surfaced to caller
        return jsonify(ok=False, error=f"fetch failed: {e}"[:300]), 502
    if "Client Challenge" in html or "<title>Client Challenge" in html:
        return jsonify(ok=False, error="challenged",
                       status=r.status_code, length=len(html)), 502
    m = extract_manifest(html)
    if not m["page_count"]:
        return jsonify(ok=False, error="no manifest in response",
                       status=r.status_code, length=len(html)), 502
    return jsonify(ok=True, status=r.status_code, length=len(html),
                   challenged=False, **m)
