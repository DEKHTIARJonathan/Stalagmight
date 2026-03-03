#!/bin/bash
# mac-remote-build.sh — Build Stalagmight on a Scaleway Apple Silicon instance
# Manages the full lifecycle: create instance, transfer code, build, retrieve artifacts, cleanup.
# Reuses an existing "stalagmight-build" instance if one is already running.
#
# Prerequisites:
#   - ~/.env with SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID
#   - ~/.ssh/id_ed25519 (registered on Scaleway as "anzu")
#   - Local tools: jq, curl, rsync, ssh
set -euo pipefail

info()  { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Prerequisites ────────────────────────────────────────────────────────────
info "Checking prerequisites"
for cmd in jq curl rsync ssh; do
  command -v "$cmd" &>/dev/null || die "Missing required tool: $cmd"
done
ok "Tools: jq, curl, rsync, ssh"

[[ -f "$HOME/.env" ]] || die "Missing ~/.env (needs SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID)"
# Source credentials indirectly — never read/print/embed them
# shellcheck disable=SC1091
source "$HOME/.env"
[[ -n "${SCW_SECRET_KEY:-}" ]]          || die "SCW_SECRET_KEY not set in ~/.env"
[[ -n "${SCW_DEFAULT_PROJECT_ID:-}" ]]  || die "SCW_DEFAULT_PROJECT_ID not set in ~/.env"
ok "Credentials loaded"

SSH_KEY="$HOME/.ssh/id_ed25519"
[[ -f "$SSH_KEY" ]] || die "SSH key not found: $SSH_KEY"
ok "SSH key: $SSH_KEY"

# ── State for cleanup ───────────────────────────────────────────────────────
SERVER_ID=""
ZONE=""
CREATED_BY_US=false  # only delete servers we created

# ── API helpers ──────────────────────────────────────────────────────────────
SCW_API_BASE="https://api.scaleway.com"
AS_API="/apple-silicon/v1alpha1"

scw_api() {
  local method="$1" path="$2" body="${3:-}"
  local url="${SCW_API_BASE}${path}"
  local response http_code
  response=$(curl -s -w "\n%{http_code}" -H "X-Auth-Token: ${SCW_SECRET_KEY}" -H "Content-Type: application/json" -X "$method" ${body:+-d "$body"} "$url")
  http_code=$(echo "$response" | tail -1)
  response=$(echo "$response" | sed '$d')
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    echo "API error ($http_code) on $method $path:" >&2
    echo "$response" | jq . 2>/dev/null || echo "$response" >&2
    return 1
  fi
  echo "$response"
}

# ── Cleanup trap ─────────────────────────────────────────────────────────────
cleanup() {
  if [[ -z "$SERVER_ID" || -z "$ZONE" ]]; then return; fi

  if [[ "$CREATED_BY_US" == true ]]; then
    # We created it — try to delete, otherwise schedule deletion
    info "Cleaning up: deleting server $SERVER_ID in $ZONE"
    if scw_api DELETE "$AS_API/zones/$ZONE/servers/$SERVER_ID" 2>/dev/null; then
      ok "Server deleted"
    else
      info "24h minimum rental — scheduling deletion via API"
      if scw_api PATCH "$AS_API/zones/$ZONE/servers/$SERVER_ID" \
        '{"schedule_deletion": true}' &>/dev/null; then
        ok "Server scheduled for automatic deletion"
      else
        warn "Could not schedule deletion"
        warn "Delete manually: https://console.scaleway.com/apple-silicon/servers"
      fi
    fi
  else
    # Reused existing server — re-schedule deletion
    info "Re-scheduling deletion for reused server $SERVER_ID"
    if scw_api PATCH "$AS_API/zones/$ZONE/servers/$SERVER_ID" \
      '{"schedule_deletion": true}' &>/dev/null; then
      ok "Server re-scheduled for automatic deletion"
    else
      warn "Could not re-schedule deletion"
      warn "Check manually: https://console.scaleway.com/apple-silicon/servers"
    fi
  fi
}

trap cleanup EXIT INT TERM

# ── SSH helpers ──────────────────────────────────────────────────────────────
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

remote_ssh() {
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SERVER_IP}" "$@"
}

# ── Phase 1: Find or create an Apple Silicon instance ───────────────────────
BUILD_SERVER_NAME="stalagmight-build"

# Search all Apple Silicon zones for an existing instance
info "Looking for existing '$BUILD_SERVER_NAME' instance"
for zone in fr-par-1 fr-par-3; do
  servers_json=$(scw_api GET "$AS_API/zones/$zone/servers") || continue
  match=$(echo "$servers_json" | jq -r --arg name "$BUILD_SERVER_NAME" '
    .servers[] | select(.name == $name and (.status == "ready" or .status == "starting"))
    | "\(.id)|\(.ip)|\(.ssh_username)|\(.status)|\(.deletion_scheduled)"
  ' | head -1)
  if [[ -n "$match" ]]; then
    IFS='|' read -r SERVER_ID SERVER_IP SSH_USER STATUS DEL_SCHEDULED <<< "$match"
    ZONE="$zone"
    break
  fi
done

if [[ -n "$SERVER_ID" ]]; then
  ok "Found existing server: $SERVER_ID in $ZONE (status: $STATUS)"

  # Unschedule deletion if it was pending
  if [[ "$DEL_SCHEDULED" == "true" ]]; then
    info "Unscheduling pending deletion"
    scw_api PATCH "$AS_API/zones/$ZONE/servers/$SERVER_ID" \
      '{"schedule_deletion": false}' &>/dev/null
    ok "Deletion unscheduled"
  fi

  # Wait for ready if still starting
  if [[ "$STATUS" != "ready" ]]; then
    info "Waiting for server to be ready (up to 30 min)…"
    DEADLINE=$((SECONDS + 1800))
    while true; do
      status_resp=$(scw_api GET "$AS_API/zones/$ZONE/servers/$SERVER_ID")
      STATUS=$(echo "$status_resp" | jq -r '.status')
      if [[ "$STATUS" == "ready" ]]; then break; fi
      if [[ $SECONDS -ge $DEADLINE ]]; then
        die "Timed out waiting for server (last status: $STATUS)"
      fi
      echo "  Status: $STATUS — waiting 30s…"
      sleep 30
    done
    SERVER_IP=$(echo "$status_resp" | jq -r '.ip')
    SSH_USER=$(echo "$status_resp" | jq -r '.ssh_username // "m1"')
  fi

  ok "Server ready: $SSH_USER@$SERVER_IP"
else
  # No existing instance — find cheapest type and create one
  info "No existing instance found — creating a new one"

  # Find smallest in-stock macOS type (cheapest proxy)
  BEST_MEM=""
  BEST_DISK=""
  BEST_TYPE=""
  BEST_ZONE=""
  BEST_OS_ID=""
  BEST_OS_NAME=""

  for zone in fr-par-1 fr-par-3; do
    types_json=$(scw_api GET "$AS_API/zones/$zone/server-types") || continue
    while IFS='|' read -r name mem disk stock os_id os_name os_family; do
      [[ "$stock" == "no_stock" ]] && continue
      [[ "$os_family" == "Linux" ]] && continue
      if [[ -z "$BEST_MEM" ]] || (( mem < BEST_MEM )) || (( mem == BEST_MEM && disk < BEST_DISK )); then
        BEST_MEM="$mem"
        BEST_DISK="$disk"
        BEST_TYPE="$name"
        BEST_ZONE="$zone"
        BEST_OS_ID="$os_id"
        BEST_OS_NAME="$os_name"
      fi
    done < <(echo "$types_json" | jq -r '
      .server_types[] |
      "\(.name)|\(.memory.capacity)|\(.disk.capacity)|\(.stock)|\(.default_os.id)|\(.default_os.name)|\(.default_os.family)"
    ')
  done

  [[ -n "$BEST_TYPE" ]] || die "No in-stock Apple Silicon macOS server types found"
  ZONE="$BEST_ZONE"
  ok "Selected: $BEST_TYPE in $ZONE ($(( BEST_MEM / 1000000000 )) GB RAM, OS: $BEST_OS_NAME)"

  info "Creating $BEST_TYPE instance in $ZONE"
  create_body=$(jq -n \
    --arg name "$BUILD_SERVER_NAME" \
    --arg project "$SCW_DEFAULT_PROJECT_ID" \
    --arg type "$BEST_TYPE" \
    --arg os "$BEST_OS_ID" \
    '{name: $name, project_id: $project, type: $type, os_id: $os}')

  create_resp=$(scw_api POST "$AS_API/zones/$ZONE/servers" "$create_body")
  SERVER_ID=$(echo "$create_resp" | jq -r '.id')
  [[ -n "$SERVER_ID" && "$SERVER_ID" != "null" ]] || die "Failed to create server"
  CREATED_BY_US=true
  ok "Server created: $SERVER_ID"

  DELETABLE_AT=$(echo "$create_resp" | jq -r '.deletable_at // "unknown"')
  info "Deletable at: $DELETABLE_AT"

  # Poll until ready
  info "Waiting for server to be ready (up to 30 min)…"
  DEADLINE=$((SECONDS + 1800))
  while true; do
    status_resp=$(scw_api GET "$AS_API/zones/$ZONE/servers/$SERVER_ID")
    STATUS=$(echo "$status_resp" | jq -r '.status')
    if [[ "$STATUS" == "ready" ]]; then break; fi
    if [[ $SECONDS -ge $DEADLINE ]]; then
      die "Timed out waiting for server (last status: $STATUS)"
    fi
    echo "  Status: $STATUS — waiting 30s…"
    sleep 30
  done

  SERVER_IP=$(echo "$status_resp" | jq -r '.ip')
  SSH_USER=$(echo "$status_resp" | jq -r '.ssh_username // "m1"')
  ok "Server ready: $SSH_USER@$SERVER_IP"
fi

# ── Phase 2: Transfer & Build ───────────────────────────────────────────────
# Wait for SSH connectivity
info "Waiting for SSH connectivity (up to 5 min)…"
SSH_DEADLINE=$((SECONDS + 300))
while true; do
  if remote_ssh "echo ok" &>/dev/null; then
    break
  fi
  if [[ $SECONDS -ge $SSH_DEADLINE ]]; then
    die "Timed out waiting for SSH"
  fi
  sleep 10
done
ok "SSH connected"

# Transfer project
info "Transferring project to remote…"
rsync -az --progress \
  --include='e2e/fixtures/*.stalx' \
  --filter=':- .gitignore' \
  --exclude='.git/' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$PROJECT_DIR/" "${SSH_USER}@${SERVER_IP}:~/stalagmight/"
ok "Project transferred"

# Run setup
info "Running mac-setup.sh on remote…"
remote_ssh "bash ~/stalagmight/scripts/mac-setup.sh"
ok "Remote setup complete"

# Run build
info "Running mac-build.sh on remote…"
remote_ssh "bash ~/stalagmight/scripts/mac-build.sh --project-dir ~/stalagmight"
ok "Remote build complete"

# ── Phase 3: Retrieve artifacts ─────────────────────────────────────────────
info "Retrieving build artifacts…"
mkdir -p "$PROJECT_DIR/build/macos/"

# Retrieve .app bundle (exclude temp rw.* DMG files)
rsync -az --progress --exclude='rw.*' \
  -e "ssh ${SSH_OPTS[*]}" \
  "${SSH_USER}@${SERVER_IP}:~/stalagmight/src-tauri/target/release/bundle/macos/" \
  "$PROJECT_DIR/build/macos/"

# Also try to get DMG if it exists
rsync -az --progress --include='*.dmg' --exclude='*' \
  -e "ssh ${SSH_OPTS[*]}" \
  "${SSH_USER}@${SERVER_IP}:~/stalagmight/src-tauri/target/release/bundle/dmg/" \
  "$PROJECT_DIR/build/macos/" 2>/dev/null || true

ok "Artifacts retrieved"

info "Build artifacts:"
find "$PROJECT_DIR/build/macos/" -maxdepth 2 -type f | while read -r f; do
  SIZE=$(du -sh "$f" | cut -f1)
  echo "  $SIZE  ${f#"$PROJECT_DIR/"}"
done

# ── Phase 4: Cleanup (handled by trap) ──────────────────────────────────────
ok "macOS remote build complete!"
info "Artifacts in: $PROJECT_DIR/build/macos/"
