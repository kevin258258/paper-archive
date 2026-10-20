import os
import subprocess
import sys
import tempfile
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='paper-archive-tests-') as tmp:
    env = {**os.environ, 'PAPER_VAULT_ROOT': tmp + '/vault', 'PAPER_READER_STATE': tmp + '/state'}
    raise SystemExit(subprocess.call([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v'], cwd=Path(__file__).resolve().parents[1], env=env))
