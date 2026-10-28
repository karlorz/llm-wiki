#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -B - "$ROOT" <<'PY'
import hashlib, importlib.util, json, os, pathlib, subprocess, sys, tempfile
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('runtime', root/'scripts/lib/deploy-runtime.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
    share = pathlib.Path(tmp)/'share'; (share/'bin').mkdir(parents=True)
    (share/'bin/old.sh').write_text('old')
    (share/'runtime-manifest.json').write_text('{"old":true}\n')
    config = pathlib.Path(tmp)/'.env'; config.write_text('push_enabled=false\n')
    args = (root, share, 'leaf', 'test-version', 'test-commit', 'test-host')
    m.deploy(*args, dry_run=True)
    assert (share/'bin/old.sh').read_text() == 'old'
    for phase in ('before-switch', 'after-switch'):
        os.environ['VS_RUNTIME_TEST_FAIL'] = phase
        try: m.deploy(*args)
        except ValueError: pass
        else: raise AssertionError('injected failure accepted')
        assert not (share/'bin').is_symlink()
        assert (share/'bin/old.sh').read_text() == 'old'
        assert json.loads((share/'runtime-manifest.json').read_text()) == {'old':True}
    del os.environ['VS_RUNTIME_TEST_FAIL']
    m.deploy(*args)
    first = (share/'bin').resolve()
    launcher = (share/'bin/wiki-pull-with-auto-resolve.sh').read_text()
    assert str(first/'payload/wiki-pull-with-auto-resolve.sh') in launcher
    python_launcher = share/'bin/wiki-snapshot-requests.py'
    assert str(first/'payload/wiki-snapshot-requests.py') in python_launcher.read_text()
    subprocess.run([sys.executable, str(python_launcher)], env={**os.environ, 'SKILLWIKI_SNAPSHOT_REQUESTS_ENABLED':'false'}, check=True)
    m.deploy(*args)
    assert first.exists() and first != (share/'bin').resolve()
    manifest = json.loads((share/'runtime-manifest.json').read_text())
    assert manifest['package_version'] == 'test-version'
    for path, digest in manifest['files'].items():
        if path.startswith('bin/'):
            assert hashlib.sha256((share/path).read_bytes()).hexdigest() == digest
    assert config.read_text() == 'push_enabled=false\n'
    assert (share/'bin/old.sh').read_text() == 'old'
print('PASS: runtime dry-run, rollback, immutable payload, repeat upgrade and hashes')
PY
