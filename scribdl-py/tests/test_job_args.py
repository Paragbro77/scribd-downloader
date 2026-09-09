# scribdl-py/tests/test_job_args.py
import json, subprocess, sys
def test_help_lists_non_interactive_flags():
    r = subprocess.run([sys.executable, "scribdl-py/main.py", "--help"], capture_output=True, text=True)
    assert "--non-interactive" in r.stdout
    assert "--job-id" in r.stdout
