#!/usr/bin/env bash
# =============================================================================
#  Race3D — one-shot install & update script (Linux / VPS)
#
#  First run  : clone repo -> install Node (if missing) -> npm install
#               -> npm run build -> start server on $PORT
#  Later runs : AUTO git pull -> rebuild -> restart  (safe to re-run anytime)
#
#  Usage:
#    bash install.sh
#    INSTALL_DIR=/opt/race3d PORT=3001 BRANCH=main bash install.sh
#    curl -fsSL https://raw.githubusercontent.com/jajangking/Race3d/main/install.sh | bash
#
#  Optional auto-update every 30 minutes (cron: crontab -e):
#    */30 * * * * /root/Race3d/install.sh >> /root/race3d-update.log 2>&1
#
#  Env overrides: REPO_URL, BRANCH (default main), INSTALL_DIR (~=/root/Race3d),
#                 PORT (default 3001), PM2_APP (default race3d)
# =============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jajangking/Race3d.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Race3d}"
PORT="${PORT:-3001}"
PM2_APP="${PM2_APP:-race3d}"
MIN_NODE="20.19.0"

log() { printf '\033[1;32m[race3d]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[race3d] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" -ne 0 ] && have sudo; then SUDO="sudo"; fi

# load nvm if present (non-interactive shells don't load it automatically)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true; fi

# ------------------------------------------------------------- Node.js ------
node_ok() {
  have node || return 1
  local ver
  ver="$(node -v | sed 's/^v//')"
  [ "$(printf '%s\n%s\n' "$MIN_NODE" "$ver" | sort -V | head -n1)" = "$MIN_NODE" ]
}

if ! node_ok; then
  log "Node.js >= $MIN_NODE not found — installing..."
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    nvm install 22
    nvm alias default 22
  elif have apt-get; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
    $SUDO apt-get install -y nodejs
  else
    die "Need Node.js >= $MIN_NODE (via nvm or apt). Install it manually and re-run."
  fi
fi
log "Node $(node -v) / npm $(npm -v)"

if ! have curl; then
  $SUDO apt-get update -y && $SUDO apt-get install -y curl \
    || log "WARN: curl unavailable — skipping server health check"
fi

# --------------------------------------------------------- clone / pull -----
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Repo found at $INSTALL_DIR — auto-pulling latest ($BRANCH)..."
  cd "$INSTALL_DIR"
  git fetch origin
  git checkout -q "$BRANCH"
  if git pull --ff-only -q origin "$BRANCH"; then
    log "Already up to date / fast-forwarded."
  else
    log "Local changes present — discarding them and re-pulling..."
    git reset --hard -q
    git clean -fdq -e race3d.pid -e race3d.log
    git pull --ff-only -q origin "$BRANCH"
  fi
  log "Now on: $(git log --oneline -1)"
else
  log "Cloning $REPO_URL ($BRANCH) -> $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ------------------------------------------------------- deps + build -------
log "Installing dependencies (npm install)..."
npm install --no-audit --no-fund

log "Building production bundle (npm run build)..."
npm run build

# ------------------------------------------------------- start / restart ----
# stop any previous instance (pm2 app or nohup pidfile) so re-runs are clean
if have pm2 && pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  pm2 delete "$PM2_APP" >/dev/null 2>&1 || true
fi
PIDFILE="$INSTALL_DIR/race3d.pid"
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" >/dev/null 2>&1 || true
  rm -f "$PIDFILE"
fi
sleep 1

if have pm2; then
  log "Starting via pm2 (app: $PM2_APP, port $PORT)..."
  pm2 start "npx vite preview --host --port $PORT" --name "$PM2_APP" --cwd "$INSTALL_DIR"
  pm2 save >/dev/null 2>&1 || true
  log "Logs: 'pm2 logs $PM2_APP' — reboot persistence: 'pm2 startup' (run once as root)"
else
  log "pm2 not found — starting with nohup (port $PORT)..."
  nohup npx vite preview --host --port "$PORT" > "$INSTALL_DIR/race3d.log" 2>&1 &
  echo $! > "$PIDFILE"
  log "Logs: $INSTALL_DIR/race3d.log (pid $(cat "$PIDFILE"))"
fi

# -------------------------------------------------------------- health ------
log "Waiting for server on port $PORT..."
ok=0
for _ in $(seq 1 30); do
  if have curl && curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then ok=1; break; fi
  sleep 1
done

if [ "$ok" = 1 ]; then
  log "SUCCESS — Race3D is running on port $PORT"
  log "Open: http://<VPS-IP>:$PORT/  (or your instabox URL: https://<port>-<id>.instabox.tech)"
else
  die "Server not responding on port $PORT after 30s. Check: $INSTALL_DIR/race3d.log or 'pm2 logs $PM2_APP'"
fi

log "If it is not reachable from outside, open port $PORT in the firewall (ufw allow $PORT/tcp) / Instabox panel."
