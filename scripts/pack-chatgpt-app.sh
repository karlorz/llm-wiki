#!/usr/bin/env bash
# pack-chatgpt-app.sh — package ChatGPT App bundle into artifacts/chatgpt-app/
#
# Bundles packages/chatgpt-app contents needed for upload:
#   - plugin.json
#   - mcp.json
#   - skills/
#   - assets/
#
# Explicitly excludes:
#   - demo-vault/ (seeded separately on sg01)
#   - public/ (served directly by Caddy)
#   - README.md / git files / test files
#
# Enforces invariants:
#   - mcp.json must not contain Bearer or SKILLWIKI_MCP_TOKEN
#   - Package must not bundle the 22 wiki-* skills

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/packages/chatgpt-app"
DEFAULT_OUT="$REPO_ROOT/artifacts/chatgpt-app"

OUT_DIR="${SKILLWIKI_CHATGPT_PACK_DIR:-$DEFAULT_OUT}"

usage() {
  cat <<'USAGE'
Usage: scripts/pack-chatgpt-app.sh [--out <dir>] [-h|--help]

Pack the ChatGPT App bundle into a zip archive.

  --out <dir>    Pack destination (default: <repo>/artifacts/chatgpt-app)
  -h, --help     Show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --out)
      if [ "$#" -lt 2 ]; then
        echo "Error: --out requires a directory" >&2
        exit 2
      fi
      OUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "Error: unexpected argument $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$APP_DIR" ]; then
  echo "Error: packages/chatgpt-app not found at $APP_DIR" >&2
  exit 1
fi

MCP_JSON="$APP_DIR/mcp.json"
PLUGIN_JSON="$APP_DIR/plugin.json"

if [ ! -f "$MCP_JSON" ]; then
  echo "Error: mcp.json not found in $APP_DIR" >&2
  exit 1
fi

if [ ! -f "$PLUGIN_JSON" ]; then
  echo "Error: plugin.json not found in $APP_DIR" >&2
  exit 1
fi

# Secret / token leak invariant check
if grep -Eqi "bearer|skillwiki_mcp_token" "$MCP_JSON"; then
  echo "Error: mcp.json must not contain 'Bearer' or 'SKILLWIKI_MCP_TOKEN'!" >&2
  exit 1
fi

# Read version from plugin.json
VERSION=$(node -e 'const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(p.version || "0.0.0");' "$PLUGIN_JSON")

case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$REPO_ROOT/$OUT_DIR" ;;
esac

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

ZIP_NAME="skillwiki-chatgpt-app-${VERSION}.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"

rm -f "$ZIP_PATH"

echo "Packing ChatGPT App bundle v${VERSION}..."

# Create zip from APP_DIR including only plugin.json, mcp.json, skills/, assets/
(
  cd "$APP_DIR"
  zip -r "$ZIP_PATH" plugin.json mcp.json skills/ assets/ -x "*.DS_Store" "*__MACOSX*"
)

# Verify zip contents
echo "Verifying zip archive contents..."
# Check file entries inside the archive (only look at the path column, skipping archive header/footer)
FILE_ENTRIES=$(zipinfo -1 "$ZIP_PATH")

if echo "$FILE_ENTRIES" | grep -Eq "^skills/(wiki-|proj-|using-skillwiki)"; then
  echo "Error: package zip contains bundled wiki-* skills!" >&2
  rm -f "$ZIP_PATH"
  exit 1
fi

if echo "$FILE_ENTRIES" | grep -Eq "^(demo-vault|public)/"; then
  echo "Error: package zip contains demo-vault or public/!" >&2
  rm -f "$ZIP_PATH"
  exit 1
fi

echo "Successfully packed: $ZIP_PATH"
echo "Package size: $(wc -c < "$ZIP_PATH" | tr -d ' ') bytes"
