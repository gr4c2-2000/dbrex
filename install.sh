#!/bin/sh
#
# Install dbrex.
#
#   curl -sSL https://raw.githubusercontent.com/gr4c2-2000/dbrex/main/install.sh | sh
#
# or, from a clone:
#
#   ./install.sh
#
# What it does:
#   - checks for a Node new enough to run the bundles
#   - gets the source, builds it, and installs the CLI and the daemon
#   - installs the VSCode extension, when an editor is present
#
# The CLI half needs no editor. That is the point: the daemon outlives the
# editor, so it has to be installable without one.
#
# Options:
#   --cli-only        skip the editor extension
#   --ref <branch>    install from a branch other than main
#
# Deliberately POSIX sh. An installer that needs bash is one more thing that
# can be missing on the machine it is meant to be fixing.
set -eu

REPO="${DBREX_REPO:-https://github.com/gr4c2-2000/dbrex.git}"
REF="${DBREX_REF:-main}"
MINIMUM_NODE_MAJOR=18
cli_only=0

while [ $# -gt 0 ]; do
  case "$1" in
    --cli-only) cli_only=1; shift ;;
    --ref) REF="${2:?--ref needs a branch}"; shift 2 ;;
    -h|--help) sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "dbrex: unknown option $1" >&2; exit 2 ;;
  esac
done

say()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\ndbrex: %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- node

usable_node() {
  [ -x "$1" ] || return 1
  major=$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "$major" -ge "$MINIMUM_NODE_MAJOR" ] 2>/dev/null
}

NODE=""
for candidate in "${DBREX_NODE:-}" "$(command -v node 2>/dev/null || true)"; do
  [ -n "$candidate" ] || continue
  if usable_node "$candidate"; then NODE="$candidate"; break; fi
done

# nvm commonly leaves `node` pointing at whatever was installed first, so look
# through what it has before giving up. Sorted by version, not by name.
if [ -z "$NODE" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for candidate in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V -r); do
    if usable_node "$HOME/.nvm/versions/node/$candidate/bin/node"; then
      NODE="$HOME/.nvm/versions/node/$candidate/bin/node"
      break
    fi
  done
fi

[ -n "$NODE" ] || die "no Node $MINIMUM_NODE_MAJOR or newer found. Install one, or set DBREX_NODE to it."
say "node $("$NODE" -p 'process.versions.node')"

# npm has to be the one belonging to this Node, or the build resolves against
# a different interpreter than the one that will run it.
PATH="$(dirname "$NODE"):$PATH"
export PATH
command -v npm >/dev/null 2>&1 || die "npm is missing next to $NODE"

# ---------------------------------------------------------------- source

# Run from a clone if this script sits in one; otherwise fetch a copy. Being
# piped from curl is the case with no clone to find.
HERE=""
case "$0" in
  */*) HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true) ;;
esac

if [ -n "$HERE" ] && [ -f "$HERE/packages/cli/package.json" ]; then
  SRC="$HERE"
  say "building the clone at $SRC"
else
  command -v git >/dev/null 2>&1 || die "git is needed to fetch the source"
  SRC=$(mktemp -d)
  trap 'rm -rf "$SRC"' EXIT INT TERM
  git clone --depth 1 --branch "$REF" "$REPO" "$SRC" >/dev/null 2>&1 \
    || die "could not clone $REPO at $REF"
  say "fetched $REF"
fi

cd "$SRC"

# ---------------------------------------------------------------- build

npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed. Run it by hand in $SRC to see why."
say "dependencies installed"

npm run build >/dev/null 2>&1 || die "the build failed. Run 'npm run build' in $SRC to see why."
say "built"

# ---------------------------------------------------------------- install

# The CLI installs itself: the copying, the shim and the link live in tested
# code rather than in this script, so there is one implementation of them.
"$NODE" packages/cli/dist/dbrex.js install || die "installing the command failed"

# ---------------------------------------------------------------- extension

if [ "$cli_only" -eq 0 ]; then
  EDITOR_CLI=""
  for candidate in code cursor code-insiders codium; do
    if command -v "$candidate" >/dev/null 2>&1; then EDITOR_CLI="$candidate"; break; fi
  done

  if [ -z "$EDITOR_CLI" ]; then
    printf '\n  no editor command found (code, cursor, code-insiders, codium).\n'
    printf '  The CLI is installed; rerun with the editor on PATH to add the extension.\n'
  else
    (cd packages/extension \
      && npx --yes @vscode/vsce@latest package --no-dependencies --allow-missing-repository \
           --out dbrex.vsix >/dev/null 2>&1) \
      || die "packaging the extension failed"
    "$EDITOR_CLI" --install-extension packages/extension/dbrex.vsix --force >/dev/null 2>&1 \
      || die "$EDITOR_CLI could not install the extension"
    say "extension installed into $EDITOR_CLI"
  fi
fi

cat <<'EOF'

Done.

  dbrex status          check the daemon
  dbrex shell           start a session, Tab completes from the server

Connections go in ~/.dbrex/connections.json. Passwords do not: they go to the
daemon's vault, an environment variable, or a command.
EOF
