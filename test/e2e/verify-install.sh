#!/usr/bin/env bash
#
# Does the installer produce a working `dbrex`?
#
# Runs in a container with no build, no node_modules, and nothing on PATH. The
# other verification proves the code works when you already have a build; this
# one proves someone can get one. They are separate because they fail for
# different reasons, and a build that works is no evidence that an installation
# does.
set -uo pipefail

SRC=/src
WORK=/home/dbrex/clone
export DBREX_HOME="${DBREX_HOME:-/home/dbrex/.dbrex}"

passed=0
failed=0

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
pass() { passed=$((passed + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() {
  failed=$((failed + 1))
  printf '  \033[31m✗\033[0m %s\n' "$1"
  [ $# -gt 1 ] && printf '      %s\n' "$2"
}

check() {
  local name="$1" pattern="$2"; shift 2
  local out status
  out="$("$@" 2>&1)"; status=$?
  if [ "$status" -ne 0 ]; then
    fail "$name" "exit $status: $(printf '%s' "$out" | head -3 | tr '\n' ' ')"
  elif ! printf '%s' "$out" | grep -qE "$pattern"; then
    fail "$name" "no match for /$pattern/ in: $(printf '%s' "$out" | head -3 | tr '\n' ' ')"
  else
    pass "$name"
  fi
}

say "Run the installer the way a person would"
# A copy, because the installer builds where it stands and the checkout is
# mounted read-only. No editor is present in this image, so --cli-only: the
# extension half needs a `code` command and is not what this is testing.
cp -r "$SRC" "$WORK" 2>/dev/null
rm -rf "$WORK/node_modules" "$WORK"/packages/*/node_modules "$WORK/.git"

# ~/.local/bin is where the installer links. A real machine usually has it;
# make it so here, and put it on PATH the way a login shell would.
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

if out=$("$WORK/install.sh" --cli-only 2>&1); then
  pass "install.sh finished"
else
  fail "install.sh finished" "$(printf '%s' "$out" | tail -5 | tr '\n' ' ')"
  printf '\n%s\n' "$out"
  echo "installer failed; nothing below can run"
  exit 1
fi

say "What the installer left behind"
check "the command is on PATH"        'dbrex'      command -v dbrex
check "the CLI bundle was installed"  'dbrex.js'   ls "$DBREX_HOME/bin"
check "the daemon bundle came too"    'dbrexd.js'  ls "$DBREX_HOME/bin"
check "the bin directory is private"  '^700$'      stat -c '%a' "$DBREX_HOME/bin"
check "the shim is executable"        'x'          bash -c "ls -l '$DBREX_HOME/bin/dbrex' | cut -c1-10"

say "The installed command, not the build it came from"
# Everything below runs `dbrex` off PATH with no DBREX_DAEMON set, so the shim
# has to find its own interpreter and the CLI has to find its own daemon.
check "dbrex --version answers"   '^[0-9]+\.[0-9]+\.[0-9]+$' dbrex --version
check "dbrex help answers"        'dbrex query'              dbrex help
check "status is calm at rest"    'daemon'                   dbrex status

say "It still works once the build directory is gone"
# The shim points into the config directory on purpose: an install that stops
# working when its build tree is deleted is not an install.
rm -rf "$WORK"
check "the command survives its build tree" '^[0-9]+\.[0-9]+\.[0-9]+$' dbrex --version

say "Query a real engine through the installed command"
mkdir -p "$DBREX_HOME"
chmod 700 "$DBREX_HOME"
cp /opt/dbrex/connections.json "$DBREX_HOME/connections.json"
chmod 600 "$DBREX_HOME/connections.json"
check "it starts its own daemon"  'mysql'  dbrex connections
check "it runs a query"           '84210'  dbrex query mysql "SELECT hits FROM events ORDER BY hits DESC"
check "the shell works too"       '84210'  bash -c "printf 'SELECT hits FROM events ORDER BY hits DESC;\n' | dbrex shell mysql"

say "Installing twice is not worse than installing once"
# People rerun installers. The second run must not break the first.
cp -r "$SRC" "$WORK" 2>/dev/null
rm -rf "$WORK/node_modules" "$WORK"/packages/*/node_modules "$WORK/.git"
if "$WORK/install.sh" --cli-only >/dev/null 2>&1; then
  pass "a second install finishes"
else
  fail "a second install finishes"
fi
check "and the command still answers" '^[0-9]+\.[0-9]+\.[0-9]+$' dbrex --version

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
