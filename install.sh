#!/usr/bin/env bash
# PrMaat bridge — one-line installer
#
# Usage:  curl -fsSL https://prmaat.com/install.sh | bash
#
# What it does:
#   1. Detects OS + arch  (macOS/Linux, x86_64/arm64)
#   2. Checks for Node.js 18+  (prints install hint if missing, does NOT auto-install)
#   3. Creates  ~/.myclawpassport/bridge/
#   4. Fetches the bridge source from GitLab (stable branch tip)
#   5. Installs the 'ws' npm dependency inside the bridge dir
#   6. Drops a  ~/.myclawpassport/bin/brainclaw  wrapper onto PATH
#   7. Prints next steps  (brainclaw init  →  brainclaw start)
#
# This installer is safe to re-run (idempotent). It does not touch /usr/local
# or sudo. Everything lives under  ~/.myclawpassport/.
#
# Override knobs (env):
#   MYCLAW_HOME      install root     (default: $HOME/.myclawpassport)
#   MYCLAW_REF       git ref/branch   (default: develop)
#   MYCLAW_GITLAB    base repo URL    (default: https://gitlab.com/pgshehata/agent-passport)

set -euo pipefail

MYCLAW_HOME="${MYCLAW_HOME:-$HOME/.myclawpassport}"
MYCLAW_REF="${MYCLAW_REF:-develop}"
MYCLAW_GITLAB="${MYCLAW_GITLAB:-https://gitlab.com/pgshehata/agent-passport}"
# Primary download source. The VPS serves a pre-built bridge tarball that
# tracks the latest stable bridge release (publicly accessible, no token
# required). GitLab archive is a fallback for when the source repo is public.
MYCLAW_TARBALL="${MYCLAW_TARBALL:-https://prmaat.com/bridge/latest.tar.gz}"

BRIDGE_DIR="$MYCLAW_HOME/bridge"
BIN_DIR="$MYCLAW_HOME/bin"

info()  { printf '\033[1;36m[brainclaw]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[brainclaw]\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31m[brainclaw]\033[0m %s\n' "$*" >&2; exit 1; }

# ── Step 1: detect OS + arch ────────────────────────────────────────────────
OS=""
case "$(uname -s)" in
  Darwin)  OS="macos"  ;;
  Linux)   OS="linux"  ;;
  MINGW*|MSYS*|CYGWIN*) die "Windows: please use WSL2 or follow the manual install at $MYCLAW_GITLAB" ;;
  *)       die "Unsupported OS: $(uname -s)" ;;
esac

ARCH=""
case "$(uname -m)" in
  x86_64|amd64)  ARCH="x64"   ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) warn "unknown arch '$(uname -m)' — continuing in compatibility mode" ; ARCH="unknown" ;;
esac

info "detected: $OS/$ARCH"

# ── Step 2: check for Node.js 18+ ───────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed."
  case "$OS" in
    macos) warn "Install via Homebrew:  brew install node"  ;;
    linux) warn "Install via package manager, e.g. Ubuntu:  sudo apt install nodejs npm"  ;;
  esac
  warn "Or use nvm:  https://github.com/nvm-sh/nvm"
  die  "Node.js required (>= 18)."
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js $NODE_MAJOR is too old — please upgrade to 18 or later."
fi
info "node $(node --version) ✓"

if ! command -v npm >/dev/null 2>&1; then
  die "npm is not installed (it usually ships with node)."
fi

# ── Step 3: prepare install dir ─────────────────────────────────────────────
mkdir -p "$MYCLAW_HOME" "$BIN_DIR"
chmod 700 "$MYCLAW_HOME"

# ── Step 4: fetch bridge source ─────────────────────────────────────────────
TMP_TAR="$(mktemp -t myclaw-bridge-tar.XXXXXX)"
TMP_EXTRACT="$(mktemp -d -t myclaw-bridge-extract.XXXXXX)"

# Try the primary VPS-hosted tarball first (fast, public). Fall back to
# GitLab archive (useful when the source repo is public or when GITLAB_TOKEN
# is set in the environment).
FETCHED=""
info "fetching bridge from $MYCLAW_TARBALL ..."
if curl -fsSL --max-time 60 "$MYCLAW_TARBALL" -o "$TMP_TAR" 2>/dev/null; then
  FETCHED="vps"
else
  warn "VPS tarball unavailable — falling back to GitLab archive"
  ARCHIVE_URL="$MYCLAW_GITLAB/-/archive/$MYCLAW_REF/agent-passport-$MYCLAW_REF.tar.gz"
  CURL_AUTH_ARG=()
  if [ -n "${GITLAB_TOKEN:-}" ]; then
    CURL_AUTH_ARG=(-H "PRIVATE-TOKEN: $GITLAB_TOKEN")
  fi
  if curl -fsSL --max-time 120 "${CURL_AUTH_ARG[@]}" "$ARCHIVE_URL" -o "$TMP_TAR"; then
    FETCHED="gitlab"
  else
    die "could not download bridge source. Tried:
    1) $MYCLAW_TARBALL  (VPS)
    2) $ARCHIVE_URL  (GitLab${GITLAB_TOKEN:+, authenticated})"
  fi
fi
info "source downloaded (via $FETCHED)"

tar -xzf "$TMP_TAR" -C "$TMP_EXTRACT"
# VPS tarball is flat (files at root); GitLab tarball is nested under repo dir.
if [ -f "$TMP_EXTRACT/ap-client.mjs" ]; then
  SRC_DIR="$TMP_EXTRACT"
else
  SRC_DIR="$(find "$TMP_EXTRACT" -type d -name mac-openclaw | head -n 1 || true)"
fi
if [ -z "$SRC_DIR" ] || [ ! -d "$SRC_DIR" ] || [ ! -f "$SRC_DIR/ap-client.mjs" ]; then
  die "could not find bridge source files in the archive"
fi

# Copy bridge files into install dir (preserve any existing .ap-sessions.json / ap-client.json)
mkdir -p "$BRIDGE_DIR"
# Files the bridge actually needs at runtime:
for f in ap-client.mjs brains.mjs package.json README.md; do
  cp "$SRC_DIR/$f" "$BRIDGE_DIR/$f"
done
mkdir -p "$BRIDGE_DIR/bin"
cp "$SRC_DIR/bin/brainclaw.mjs" "$BRIDGE_DIR/bin/brainclaw.mjs"
chmod +x "$BRIDGE_DIR/bin/brainclaw.mjs"

info "source installed → $BRIDGE_DIR"

# ── Step 5: install 'ws' npm dep ────────────────────────────────────────────
info "installing npm dependency (ws) ..."
(
  cd "$BRIDGE_DIR"
  # Quiet install, no package-lock modification pressure, no audit noise.
  npm install --no-audit --no-fund --silent >/dev/null
)
info "npm install ✓"

# ── Step 6: drop brainclaw wrapper on PATH ──────────────────────────────────
# Bake the resolved node binary path into the wrapper so `brainclaw` works
# even when the invoking shell doesn't have node in PATH (common for GUI
# launchers / cron / launchd).
NODE_BIN="$(command -v node)"
cat > "$BIN_DIR/brainclaw" <<WRAPPER
#!/usr/bin/env bash
# PrMaat bridge launcher. Auto-generated by install.sh — do not edit.
exec "$NODE_BIN" "$BRIDGE_DIR/bin/brainclaw.mjs" "\$@"
WRAPPER
chmod +x "$BIN_DIR/brainclaw"
info "wrapper installed → $BIN_DIR/brainclaw"

# ── Step 7: PATH hint ───────────────────────────────────────────────────────
PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
PATH_OK="no"
case ":$PATH:" in
  *":$BIN_DIR:"*) PATH_OK="yes" ;;
esac

if [ "$PATH_OK" = "yes" ]; then
  info "PATH already contains $BIN_DIR ✓"
else
  SHELL_RC=""
  case "${SHELL:-}" in
    */zsh)  SHELL_RC="$HOME/.zshrc"  ;;
    */bash) SHELL_RC="$HOME/.bashrc" ;;
  esac
  if [ -n "$SHELL_RC" ] && [ -f "$SHELL_RC" ] && ! grep -q "myclawpassport/bin" "$SHELL_RC" 2>/dev/null; then
    printf '\n# PrMaat bridge\n%s\n' "$PATH_LINE" >> "$SHELL_RC"
    info "appended PATH export to $SHELL_RC"
    warn "open a new shell OR run:  source $SHELL_RC"
  else
    warn "add this to your shell rc file:"
    warn "  $PATH_LINE"
  fi
fi

# ── Done ────────────────────────────────────────────────────────────────────
cat <<DONE

─────────────────────────────────────────────────────────────────────
✓ PrMaat bridge installed at $BRIDGE_DIR

  Next:
    1. brainclaw init          (interactive: paste pairing code or apt_ token)
    2. brainclaw start         (bridge runs in the foreground; Ctrl-C to stop)

  Reference:
    brainclaw help             full CLI help
    https://prmaat.com/docs/bridge
─────────────────────────────────────────────────────────────────────
DONE

# cleanup
rm -rf "$TMP_TAR" "$TMP_EXTRACT"
