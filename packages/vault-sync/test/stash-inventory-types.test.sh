#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -B - "$ROOT" <<'PY'
import importlib.util, pathlib, subprocess, sys, tempfile
spec=importlib.util.spec_from_file_location('verify',pathlib.Path(sys.argv[1])/'scripts/lib/verify-stash-inventory.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
 p=pathlib.Path(tmp)
 def git(*args): return subprocess.check_output(['git','-C',tmp,*args],stderr=subprocess.DEVNULL).decode().strip()
 git('init');git('config','user.name','Test');git('config','user.email','test@example.com')
 (p/'deleted').write_text('base');(p/'mode').write_text('base');(p/'link').symlink_to('deleted');(p/'binary').write_bytes(b'base\x00')
 git('add','.');git('commit','-m','base');head=git('rev-parse','HEAD')
 (p/'deleted').unlink();(p/'mode').chmod(0o755);(p/'link').unlink();(p/'link').symlink_to('mode');(p/'binary').write_bytes(b'local\x00');(p/'new').write_text('new');git('add','new')
 (p/'untracked').write_text('untracked')
 inv=p/'.git/inventory';inv.write_text('# staged\nnew\n# tracked\ndeleted\nmode\nlink\nbinary\n# untracked\nuntracked\n')
 git('stash','push','-u');stash=git('rev-parse','stash@{0}');git('stash','apply',stash)
 m.verify(tmp,inv,stash,head,set())
 def refused():
  try:m.verify(tmp,inv,stash,head,set())
  except (ValueError,subprocess.SubprocessError):return
  raise AssertionError('bad restoration accepted')
 (p/'untracked').write_text('lost');refused();(p/'untracked').write_text('untracked')
 (p/'mode').chmod(0o644);refused();(p/'mode').chmod(0o755)
 (p/'deleted').write_text('resurrected');refused();(p/'deleted').unlink()
 (p/'link').unlink();(p/'link').write_text('mode');refused()
 print('PASS: staged addition, deletion, untracked, symlink, mode and binary preservation')
PY
