"""Run with the build Python environment after npm ci."""
from pathlib import Path
import os
import subprocess
import sys
root = Path(__file__).resolve().parents[1]
os.chdir(root)
os.environ["PYINSTALLER_CONFIG_DIR"] = str(root / "build/cache")
sep = os.pathsep
args = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--name', 'paper-backend',
        '--distpath', 'build/backend', '--workpath', 'build/pyinstaller', '--specpath', 'build',
        '--collect-all', 'pymupdf', '--hidden-import', 'yaml',
        '--add-data', f'{root / "public"}{sep}public', '--add-data', f'{root / "skills"}{sep}skills']
for name in ['pdfjs-dist', 'marked', 'dompurify']:
    args += ['--add-data', f'{root / "node_modules" / name}{sep}node_modules/{name}']
args += [str(root / 'server.py')]
subprocess.run(args, check=True)
