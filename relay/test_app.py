import os

import pytest

from app import app


@pytest.fixture()
def client():
    app.config.update(TESTING=True)
    return app.test_client()


def test_health(client):
    assert client.get("/health").get_json() == {"ok": True}


def test_manifest_rejects_bad_doc(client):
    r = client.get("/manifest?docId=evil")
    assert r.status_code == 400
    assert r.get_json()["ok"] is False


def test_manifest_ok(monkeypatch, client):
    html = ('<script>window.x={"page_count":2,'
            '"title":"T"}</script>'
            '<img class="absimg" orig="http://html.scribd.com/h/images/1-aaa111.jpg"/>'
            '<script>docManager.addPage({ pageNum: 2 , contentUrl: '
            '"https://html.scribdassets.com/h/pages/2-bbb222.jsonp" });</script>')

    class R:
        status_code = 200
        text = html

    class S:
        def __init__(self, *a, **k):
            pass

        def get(self, *a, **k):
            return R()

    import app as appmod

    monkeypatch.setattr(appmod.cr, "Session", S)
    r = client.get("/manifest?docId=558718376")
    assert r.status_code == 200
    j = r.get_json()
    assert j["ok"] is True and j["page_count"] == 2
    assert j["inline"]["1"].endswith("/images/1-aaa111.jpg")
    assert j["jsonp_urls"] == ["https://html.scribdassets.com/h/pages/2-bbb222.jsonp"]


def test_manifest_challenged(monkeypatch, client):
    class R:
        status_code = 200
        text = "<html><head><title>Client Challenge</title></head></html>"

    class S:
        def __init__(self, *a, **k):
            pass

        def get(self, *a, **k):
            return R()

    import app as appmod

    monkeypatch.setattr(appmod.cr, "Session", S)
    r = client.get("/manifest?docId=558718376")
    assert r.status_code == 502
    assert r.get_json()["error"] == "challenged"
