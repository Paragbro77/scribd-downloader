"""Pure manifest extraction from Scribd embed HTML.

No network, no browser: given the embed page HTML (fetched with a
Chrome-TLS-impersonating client from a residential IP), pull out the
document title, page count, inline page 1-3 image URLs and the ordered
per-page JSONP content URLs. JSONP bodies are parsed with the same
ORIG_RE (they escape quotes, which the pattern tolerates).
"""
import re

ORIG_RE = re.compile(
    r"orig=\\*\"?(http://html\.scribd\.com/[^\"\\]+?/images/(\d+)-[a-f0-9]+\.(?:jpg|png))",
    re.IGNORECASE,
)
ADD_BLOCK_RE = re.compile(r"pageNum:\s*(\d+)\s*,.*?contentUrl:\s*\"([^\"]+)\"", re.S)
COUNT_RE = re.compile(r"\"page_count\":\s*(\d+)")
TITLE_RE = re.compile(r"\"title\":\s*\"([^\"\\]{2,200})\"")


def to_https(url):
    return url.replace("http://html.scribd.com/", "https://html.scribdassets.com/")


def extract_manifest(html):
    """Return {title, page_count, inline:{page:url}, jsonp_urls:[...]}."""
    m = COUNT_RE.search(html)
    page_count = int(m.group(1)) if m else 0
    t = TITLE_RE.search(html)
    title = t.group(1) if t else ""
    inline = {}
    for mm in ORIG_RE.finditer(html):
        inline[int(mm.group(2))] = to_https(mm.group(1))
    jsonp_urls = [cu for _, cu in ADD_BLOCK_RE.findall(html)]
    return {
        "title": title,
        "page_count": page_count,
        "inline": inline,
        "jsonp_urls": jsonp_urls,
    }


def image_url_from_jsonp(body):
    """Pull the page image URL out of one JSONP body (jpg or png)."""
    m = ORIG_RE.search(body)
    return to_https(m.group(1)) if m else None
