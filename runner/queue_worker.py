"""Queue worker loop: poll internal API, run vendored main.py, upload to pigeon."""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse

import requests

RESULT_JSON_FALLBACK = "result.json"
JOB_TIMEOUT_SECS = 1800  # hard stop for one main.py invocation

# Vendored snapshot of nested scribdl-py (see runner/vendor/). Prefer it so the
# GitHub Action checkout is self-contained; fall back to scribdl-py/ locally.
VENDOR_MAIN = os.path.join("runner", "vendor", "main.py")
LEGACY_MAIN = os.path.join("scribdl-py", "main.py")
OUTPUT_DIRS = ("output",
               os.path.join("runner", "vendor", "output"),
               os.path.join("scribdl-py", "output"))


def main_script():
    if os.path.exists(VENDOR_MAIN):
        return VENDOR_MAIN
    return LEGACY_MAIN


def parse_pigeon_response(shell):
    m1 = re.search(r"'(https://pigeon\.[^']+)'", shell)
    m2 = re.search(r"'(https://pigeon\.zip/[^']+)'", shell)
    if not m1 or not m2:
        raise ValueError("bad pigeon response")
    return m1.group(1), m2.group(1)


def upload_to_pigeon(pdf_path, retries=3):
    name = urllib.parse.quote(os.path.basename(pdf_path))
    shell = requests.get(f"https://pigeon.zip/api/cli/up/{name}", timeout=30).text
    put_url, share_url = parse_pigeon_response(shell)
    for i in range(retries):
        r = subprocess.run(["curl", "-fsS", "-T", pdf_path, put_url],
                           capture_output=True, text=True)
        if r.returncode == 0:
            return share_url
        time.sleep(5)
    raise RuntimeError("pigeon upload failed")


def headers(secret):
    return {"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}


def api_post(api, secret, path, payload):
    return requests.post(f"{api}{path}", json=payload,
                         headers=headers(secret), timeout=30)


def find_result_json(script_dir=None):
    """result.json lands beside the output PDF (output/ dir), not CWD."""
    dirs = list(OUTPUT_DIRS)
    if script_dir:
        # main.py runs with cwd=script_dir, so its writes land here first
        dirs.insert(0, os.path.join(script_dir, "output"))
    for out_dir in dirs:
        candidate = os.path.join(out_dir, "result.json")
        if os.path.exists(candidate):
            return candidate
    if os.path.exists(RESULT_JSON_FALLBACK):
        return RESULT_JSON_FALLBACK
    if script_dir:
        fallback = os.path.join(script_dir, "result.json")
        if os.path.exists(fallback):
            return fallback
    return None


def newest_pdf(script_dir=None):
    pdfs = []
    dirs = list(OUTPUT_DIRS)
    if script_dir:
        dirs.insert(0, os.path.join(script_dir, "output"))
    for out_dir in dirs:
        pdfs.extend(glob.glob(os.path.join(out_dir, "*.pdf")))
    if not pdfs:
        return None
    return max(pdfs, key=os.path.getmtime)


def resolve_pdf(result, script_dir=None):
    """Prefer result["filename"] written by main.py; fall back to newest-glob."""
    filename = result.get("filename")
    if filename:
        if os.path.exists(filename):
            return filename
        candidates = []
        if script_dir:
            # filename is relative to main.py's cwd (script_dir)
            candidates.append(os.path.join(script_dir, filename))
            candidates.append(os.path.join(script_dir,
                                           os.path.basename(filename)))
        candidates.extend(os.path.join(out_dir, filename) for out_dir in OUTPUT_DIRS)
        candidates.extend(os.path.join(out_dir, os.path.basename(filename))
                          for out_dir in OUTPUT_DIRS)
        for cand in candidates:
            if os.path.exists(cand):
                return cand
    return newest_pdf(script_dir)


def run_job(api, secret, job):
    if not isinstance(job, dict) or not job.get("id") or not job.get("url"):
        return  # malformed job payload: skip instead of crashing the loop
    script = main_script()
    script_dir = os.path.dirname(os.path.abspath(script))
    started_at = time.time()
    cmd = [sys.executable, script,
           "--url", job["url"],
           "--pages", job.get("pages") or "all",
           "--scale", str(job.get("scale", 2)),
           "--delay", str(job.get("delay", 0.5)),
           "--non-interactive", "--job-id", job["id"], "--quiet"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           cwd=script_dir, timeout=JOB_TIMEOUT_SECS)
    except subprocess.TimeoutExpired:
        api_post(api, secret, "/api/internal/fail",
                 {"id": job["id"], "error": "job_timeout"})
        return
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
        detail = " | ".join(t.strip() for t in tail)[-400:] or "no_output"
        api_post(api, secret, "/api/internal/fail",
                 {"id": job["id"], "error": f"exit_{r.returncode}: {detail}"})
        return
    result_path = find_result_json(script_dir)
    if result_path is None:
        api_post(api, secret, "/api/internal/fail",
                 {"id": job["id"], "error": "no_result_json"})
        return
    try:
        with open(result_path) as f:
            result = json.load(f)
    except (OSError, ValueError) as e:
        api_post(api, secret, "/api/internal/fail",
                 {"id": job["id"], "error": f"bad_result_json: {e}"})
        return
    pdf = resolve_pdf(result, script_dir)
    if pdf is None or os.path.getmtime(pdf) < started_at - 5:
        # Refuse stale artifacts from earlier jobs in this workspace.
        api_post(api, secret, "/api/internal/fail",
                 {"id": job["id"], "error": "no_pdf"})
        return
    try:
        download_url = upload_to_pigeon(pdf)
    except Exception as e:
        api_post(api, secret, "/api/internal/fail",
                 {"id": job["id"], "error": f"pigeon_failed: {e}"})
        return
    api_post(api, secret, "/api/internal/complete",
             {"id": job["id"], "download_url": download_url,
              "title": result.get("title", ""),
              "pages_done": result.get("pages_done", 0)})


def heartbeat_loop(api, secret, job_id_holder, stop_event):
    while not stop_event.wait(60):
        jid = job_id_holder.get("id")
        if jid:
            try:
                api_post(api, secret, "/api/internal/heartbeat", {"id": jid})
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("--secret", required=True)
    ap.add_argument("--deadline-min", type=float, default=340)
    args = ap.parse_args()

    deadline = time.time() + args.deadline_min * 60
    job_id_holder = {}
    stop_event = threading.Event()
    hb = threading.Thread(target=heartbeat_loop,
                          args=(args.api, args.secret, job_id_holder, stop_event),
                          daemon=True)
    hb.start()
    try:
        while time.time() < deadline:
            try:
                resp = requests.get(f"{args.api}/api/internal/next",
                                    headers=headers(args.secret), timeout=30)
                data = resp.json()
            except Exception:
                time.sleep(60)
                continue
            job = data.get("job")
            if not job:
                time.sleep(60)
                continue
            if not isinstance(job, dict) or not job.get("id") or not job.get("url"):
                # Response schema violation: back off instead of hot-looping.
                time.sleep(30)
                continue
            job_id_holder["id"] = job["id"]
            try:
                run_job(args.api, args.secret, job)
            finally:
                job_id_holder.pop("id", None)
    finally:
        stop_event.set()


if __name__ == "__main__":
    main()
