#!/usr/bin/env bash
# pack-cli.sh — build skillwiki CLI and emit an npm pack tarball outside package sources.
#
# Why: bare `npm pack` in packages/cli drops skillwiki-X.Y.Z.tgz next to package.json,
# which is easy to commit by accident. This helper always packs into a non-git
# artifacts directory under the monorepo root (gitignored).
#
# Usage:
#   scripts/pack-cli.sh              # build + pack → artifacts/npm/skillwiki-<ver>.tgz
#   scripts/pack-cli.sh --no-build   # pack only (requires prior build)
#   scripts/pack-cli.sh --out DIR    # custom destination (must not be packages/cli)
#   scripts/pack-cli.sh --json       # print machine-readable path JSON on stdout
#
# Env:
#   SKILLWIKI_PACK_DIR  — default pack destination (overrides default artifacts/npm)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
DEFAULT_OUT="$REPO_ROOT/artifacts/npm"

DO_BUILD=true
OUT_DIR="${SKILLWIKI_PACK_DIR:-$DEFAULT_OUT}"
JSON=false

usage() {
  cat <<'USAGE'
Usage: scripts/pack-cli.sh [--no-build] [--out <dir>] [--json] [-h|--help]

Build packages/cli and run npm pack into a non-git artifacts folder.

  --no-build     Skip npm run build (use existing packages/cli/dist)
  --out <dir>    Pack destination (default: <repo>/artifacts/npm)
  --json         Print {"path","version","name","sha256","bytes"} JSON to stdout
  -h, --help     Show this help

The destination must not be packages/cli/ (or any package source dir).
Tarballs under artifacts/ are gitignored (see root .gitignore).
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --no-build)
      DO_BUILD=false
      shift
      ;;
    --out)
      if [ "$#" -lt 2 ]; then
        echo "Error: --out requires a directory" >&2
        exit 2
      fi
      OUT_DIR="$2"
      shift 2
      ;;
    --json)
      JSON=true
      shift
      ;;
    -*)
      echo "Error: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      echo "Error: unexpected argument $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Resolve OUT_DIR to an absolute path (create if needed).
case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$REPO_ROOT/$OUT_DIR" ;;
esac
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# Refuse to pack into the CLI package directory (the failure mode we are fixing).
case "$OUT_DIR" in
  "$CLI_DIR"|"$CLI_DIR"/*)
    echo "Error: pack destination must not be packages/cli (got: $OUT_DIR)" >&2
    echo "Use the default artifacts/npm or --out outside package sources." >&2
    exit 2
    ;;
esac

if [ ! -f "$CLI_DIR/package.json" ]; then
  echo "Error: CLI package not found at $CLI_DIR" >&2
  exit 1
fi

VERSION="$(node -e "console.log(require('$CLI_DIR/package.json').version)")"
NAME="$(node -e "console.log(require('$CLI_DIR/package.json').name)")"
TARBALL_NAME="${NAME}-${VERSION}.tgz"
DEST="$OUT_DIR/$TARBALL_NAME"

if [ "$DO_BUILD" = true ]; then
  echo "Building skillwiki CLI..." >&2
  npm run -w skillwiki build >&2
fi

if [ ! -f "$CLI_DIR/dist/cli.js" ]; then
  echo "Error: $CLI_DIR/dist/cli.js missing — run without --no-build or build first" >&2
  exit 1
fi

# Remove stale tarball in destination and any accidental package-dir leftover
rm -f "$DEST"
rm -f "$CLI_DIR/${NAME}-"*.tgz 2>/dev/null || true

echo "Packing $NAME@$VERSION → $OUT_DIR" >&2
(
  cd "$CLI_DIR"
  # --ignore-scripts: prepublishOnly rebuild already done (or skipped with --no-build)
  npm pack --pack-destination "$OUT_DIR" --ignore-scripts >&2
)

if [ ! -f "$DEST" ]; then
  # npm pack may use slightly different naming; pick newest matching tarball
  DEST="$(ls -t "$OUT_DIR"/"${NAME}"-*.tgz 2>/dev/null | head -1 || true)"
fi

if [ -z "${DEST:-}" ] || [ ! -f "$DEST" ]; then
  echo "Error: pack produced no tarball in $OUT_DIR" >&2
  exit 1
fi

# Absolute path
DEST="$(cd "$(dirname "$DEST")" && pwd)/$(basename "$DEST")"
SHA256="$(shasum -a 256 "$DEST" | awk '{print $1}')"
SIZE="$(wc -c <"$DEST" | tr -d ' ')"

if [ "$JSON" = true ]; then
  node -e "
const o={path:process.argv[1],version:process.argv[2],name:process.argv[3],sha256:process.argv[4],bytes:Number(process.argv[5])};
process.stdout.write(JSON.stringify(o)+'\n');
" "$DEST" "$VERSION" "$NAME" "$SHA256" "$SIZE"
else
  echo "$DEST"
  echo "sha256: $SHA256  bytes: $SIZE" >&2
fi
