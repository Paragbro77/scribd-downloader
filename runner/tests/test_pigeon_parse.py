import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from queue_worker import parse_pigeon_response

SAMPLE = "curl -fsS -T 'video.mp4' 'https://pigeon.b5dcbd99.r2.cloudflarestorage.com/h782DUYw?X-Amz-Expires=3600&x-id=PutObject' && echo 'https://pigeon.zip/h782DUYw'"


def test_parse_pigeon():
    put, share = parse_pigeon_response(SAMPLE)
    assert put.startswith("https://pigeon.")
    assert share == "https://pigeon.zip/h782DUYw"
