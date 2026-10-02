#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT=/opt/v5
readonly STATE_ROOT=/var/lib/v5bot
readonly SERVICE_USER=v5bot
readonly ENV_FILE="$STATE_ROOT/Documents/live.env"
readonly PAPER_ENV="$STATE_ROOT/Documents/paper.env"

fail() { printf 'preflight: %s\n' "$*" >&2; exit 1; }
[[ $# -le 1 ]] || fail 'usage: preflight.sh [--static]'
static_only=false
if [[ ${1:-} == --static ]]; then static_only=true; elif [[ $# -eq 1 ]]; then fail 'usage: preflight.sh [--static]'; fi

[[ -L "$APP_ROOT/current" ]] || fail '/opt/v5/current is not a release symlink.'
release=$(realpath -e -- "$APP_ROOT/current")
[[ "$release" == "$APP_ROOT/releases"/* ]] || fail 'current release resolves outside /opt/v5/releases.'
[[ -L "$release/state" ]] || fail 'release state path is not a symlink.'
[[ $(realpath -e -- "$release/state") == "$STATE_ROOT/state" ]] || fail 'release state does not resolve to persistent /var/lib/v5bot/state.'
[[ -d "$STATE_ROOT/state" && -w "$STATE_ROOT/state" ]] || fail 'persistent state directory is missing or not writable.'
[[ ! -e "$PAPER_ENV" && ! -L "$PAPER_ENV" ]] || fail 'paper.env must not be present in the service home.'
[[ -f "$release/deploy/linux/run-live.mjs" ]] || fail 'LIVE wrapper is missing.'
[[ -f "$release/paper.mjs" && -f "$release/package.json" ]] || fail 'runtime source files are missing.'
command -v runuser >/dev/null || fail 'runuser is required for service-user permission checks.'
account=$(getent passwd "$SERVICE_USER")
getent group "$SERVICE_USER" >/dev/null || fail 'v5bot group is missing.'
account_home=$(cut -d: -f6 <<<"$account")
account_shell=$(cut -d: -f7 <<<"$account")
[[ "$account_home" == "$STATE_ROOT" && "${account_shell##*/}" == nologin ]] || fail 'v5bot must use /var/lib/v5bot as home and a nologin shell.'
password_state=$(passwd -S "$SERVICE_USER" | awk '{print $2}')
[[ "$password_state" == L || "$password_state" == LK ]] || fail 'v5bot password is not locked.'
[[ $(stat -c '%U:%G %a' -- "$STATE_ROOT") == v5bot:v5bot\ 700 ]] || fail 'service home must be v5bot-owned and mode 0700.'
[[ $(stat -c '%U:%G %a' -- "$STATE_ROOT/state") == v5bot:v5bot\ 700 ]] || fail 'persistent state must be v5bot-owned and mode 0700.'
runuser -u "$SERVICE_USER" -- test -w "$STATE_ROOT/state" || fail 'v5bot cannot write persistent state.'
release_writable=$(runuser -u "$SERVICE_USER" -- find "$release" -xdev -path "$release/state" -prune -o -writable -print -quit) || fail 'could not verify release permissions as v5bot.'
[[ -z "$release_writable" ]] || fail "release contains a path writable by v5bot: $release_writable"
runuser -u "$SERVICE_USER" -- test ! -w "$APP_ROOT" || fail 'v5bot can modify the release root.'
runuser -u "$SERVICE_USER" -- test ! -w "$APP_ROOT/releases" || fail 'v5bot can modify the releases directory.'

# --check parses the wrapper without importing it or invoking its entry point.
node_major=$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')
[[ "$node_major" == 24 ]] || fail 'Node.js 24 LTS is required.'
/usr/bin/node --check "$release/deploy/linux/run-live.mjs" >/dev/null || fail 'LIVE wrapper has a syntax error.'

if [[ $static_only == false ]]; then
  [[ ! -L "$ENV_FILE" && -f "$ENV_FILE" ]] || fail 'live.env must be a regular non-symlink file.'
  owner=$(stat -c '%U:%G' -- "$ENV_FILE")
  mode=$(stat -c '%a' -- "$ENV_FILE")
  [[ "$owner" == "$SERVICE_USER:$SERVICE_USER" ]] || fail 'live.env must be owned by v5bot:v5bot.'
  [[ "$mode" == 600 ]] || fail 'live.env must have mode 0600.'
fi

[[ $(/usr/bin/systemctl show -p ActiveState --value v5-live.service) == inactive ]] || fail 'LIVE service is not inactive.'
[[ $(/usr/bin/systemctl show -p ActiveState --value v5-live.timer) == inactive ]] || fail 'LIVE timer is not inactive.'
timer_enabled=$(/usr/bin/systemctl is-enabled v5-live.timer 2>/dev/null || true)
[[ "$timer_enabled" == disabled ]] || fail "LIVE timer is enabled or has an unexpected state: $timer_enabled"
service_enabled=$(/usr/bin/systemctl is-enabled v5-live.service 2>/dev/null || true)
[[ "$service_enabled" == disabled || "$service_enabled" == static ]] || fail "LIVE service is enabled or has an unexpected state: $service_enabled"

printf 'Preflight passed for release %s; no runner was imported or launched.\n' "${release##*/}"
