#!/bin/sh
# runtime-manifest.sh — SHA-256 inventory of installed vault-sync artifacts.
#
# Sourced by vault-sync-install (and later vault-sync-status). Works in bash
# and /bin/sh. Prefers python3 for JSON emission; falls back to a minimal
# hand-built JSON object when python3 is unavailable.
#
# Public API:
#   vault_sync_sha256 <file>                 → hex digest or empty
#   vault_sync_package_version <root>        → version string
#   vault_sync_package_commit <root>         → git HEAD or empty
#   vault_sync_write_runtime_manifest \
#     <out_path> <share_dir> <launch_agents_dir> \
#     <package_version> <package_commit> <installer_version> \
#     <installed_at> <role> <host_id>

vault_sync_sha256() {
  _f="$1"
  if [ ! -f "$_f" ]; then
    echo ""
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$_f" 2>/dev/null | awk '{print $1}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$_f" 2>/dev/null | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$_f" 2>/dev/null | awk '{print $NF}'
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$_f" 2>/dev/null
    return 0
  fi
  echo ""
}

vault_sync_package_version() {
  _root="$1"
  # Prefer monorepo package.json two levels up from packages/vault-sync, else root.
  if [ -f "$_root/../../package.json" ]; then
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version",""))' "$_root/../../package.json" 2>/dev/null && return 0
    fi
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_root/../../package.json" 2>/dev/null | head -n 1
    return 0
  fi
  if [ -f "$_root/package.json" ]; then
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version",""))' "$_root/package.json" 2>/dev/null && return 0
    fi
  fi
  echo "0.0.0"
}

vault_sync_package_commit() {
  _root="$1"
  if command -v git >/dev/null 2>&1 && [ -d "$_root/../../.git" -o -f "$_root/../../.git" ] 2>/dev/null; then
    git -C "$_root/../.." rev-parse HEAD 2>/dev/null || echo ""
    return 0
  fi
  if command -v git >/dev/null 2>&1; then
    git -C "$_root" rev-parse HEAD 2>/dev/null || echo ""
    return 0
  fi
  echo ""
}

# Collect relative_path=sha256 pairs for files under share_dir/bin and
# LaunchAgents plists. Writes newline-separated "relpath\thash" to stdout.
vault_sync_collect_file_hashes() {
  _share="$1"
  _agents="$2"
  _bin="$_share/bin"

  if [ -d "$_bin" ]; then
    # shell scripts at bin root
    for _f in "$_bin"/*; do
      [ -f "$_f" ] || continue
      _base="$(basename "$_f")"
      _h="$(vault_sync_sha256 "$_f")"
      [ -n "$_h" ] && printf 'bin/%s\t%s\n' "$_base" "$_h"
    done
    # lib/*.sh
    if [ -d "$_bin/lib" ]; then
      for _f in "$_bin/lib"/*; do
        [ -f "$_f" ] || continue
        _base="$(basename "$_f")"
        _h="$(vault_sync_sha256 "$_f")"
        [ -n "$_h" ] && printf 'bin/lib/%s\t%s\n' "$_base" "$_h"
      done
    fi
  fi

  if [ -d "$_agents" ]; then
    for _f in "$_agents"/com.karlchow.wiki-*.plist; do
      [ -f "$_f" ] || continue
      _base="$(basename "$_f")"
      _h="$(vault_sync_sha256 "$_f")"
      [ -n "$_h" ] && printf 'LaunchAgents/%s\t%s\n' "$_base" "$_h"
    done
  fi
}

vault_sync_write_runtime_manifest() {
  _out="$1"
  _share="$2"
  _agents="$3"
  _pkg_ver="$4"
  _pkg_commit="$5"
  _installer_ver="$6"
  _installed_at="$7"
  _role="$8"
  _host_id="$9"

  _pairs="$(mktemp)"
  vault_sync_collect_file_hashes "$_share" "$_agents" >"$_pairs"

  mkdir -p "$(dirname "$_out")"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$_out" "$_pkg_ver" "$_pkg_commit" "$_installer_ver" "$_installed_at" "$_role" "$_host_id" "$_pairs" <<'PY'
import json, sys
out, pkg_ver, pkg_commit, installer_ver, installed_at, role, host_id, pairs_path = sys.argv[1:9]
files = {}
with open(pairs_path, "r", encoding="utf-8") as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line:
            continue
        if "\t" not in line:
            continue
        rel, digest = line.split("\t", 1)
        files[rel] = digest
manifest = {
    "schema_version": 1,
    "package_commit": pkg_commit,
    "package_version": pkg_ver,
    "installer_version": installer_ver,
    "installed_at": installed_at,
    "role": role,
    "host_id": host_id,
    "files": files,
}
with open(out, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2, sort_keys=False)
    fh.write("\n")
PY
    _rc=$?
    rm -f "$_pairs"
    return $_rc
  fi

  # Minimal fallback without python3
  {
    printf '{\n'
    printf '  "schema_version": 1,\n'
    printf '  "package_commit": "%s",\n' "$_pkg_commit"
    printf '  "package_version": "%s",\n' "$_pkg_ver"
    printf '  "installer_version": "%s",\n' "$_installer_ver"
    printf '  "installed_at": "%s",\n' "$_installed_at"
    printf '  "role": "%s",\n' "$_role"
    printf '  "host_id": "%s",\n' "$_host_id"
    printf '  "files": {\n'
    _first=1
    while IFS="$(printf '\t')" read -r _rel _hash; do
      [ -n "$_rel" ] || continue
      if [ "$_first" -eq 1 ]; then
        _first=0
      else
        printf ',\n'
      fi
      printf '    "%s": "%s"' "$_rel" "$_hash"
    done <"$_pairs"
    printf '\n  }\n}\n'
  } >"$_out"
  rm -f "$_pairs"
  return 0
}
