#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT=/opt/v5
readonly RELEASES="$APP_ROOT/releases"
readonly STATE_ROOT=/var/lib/v5bot
readonly SERVICE_USER=v5bot
readonly SERVICE_GROUP=v5bot
readonly SERVICE=v5-live.service
readonly TIMER=v5-live.timer

fail() { printf 'install: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail 'run as root.'
[[ $# -eq 1 ]] || fail 'usage: install.sh /opt/v5/releases/<revision>'
release=$(realpath -e -- "$1")
[[ "$release" == "$RELEASES"/* ]] || fail 'release must be inside /opt/v5/releases.'
[[ -f "$release/package.json" && -f "$release/deploy/linux/run-live.mjs" ]] || fail 'release is incomplete.'
[[ -f "$release/deploy/linux/systemd/v5-live.service" && -f "$release/deploy/linux/systemd/v5-live.timer" ]] || fail 'release systemd units are missing.'
if [[ -L "$APP_ROOT/current" && $(realpath -e -- "$APP_ROOT/current") == "$release" ]]; then
  fail 'refusing to mutate the currently selected release; stage a new revision directory.'
fi
getent passwd "$SERVICE_USER" >/dev/null || fail 'service account v5bot must be provisioned first.'
getent group "$SERVICE_GROUP" >/dev/null || fail 'service group v5bot must be provisioned first.'
account=$(getent passwd "$SERVICE_USER")
account_home=$(cut -d: -f6 <<<"$account")
account_shell=$(cut -d: -f7 <<<"$account")
[[ "$account_home" == "$STATE_ROOT" && "${account_shell##*/}" == nologin ]] || fail 'v5bot must use /var/lib/v5bot as home and a nologin shell.'
password_state=$(passwd -S "$SERVICE_USER" | awk '{print $2}')
[[ "$password_state" == L || "$password_state" == LK ]] || fail 'v5bot password must be locked.'
[[ -x /usr/bin/node && -x /usr/bin/npm ]] || fail 'Node.js and npm must be installed at /usr/bin.'
node_major=$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')
(( node_major == 24 )) || fail 'install the latest patch release in the Node.js 24 LTS line.'

mkdir -p "$APP_ROOT" "$RELEASES" "$STATE_ROOT/Documents" "$STATE_ROOT/state"
chown "$SERVICE_USER:$SERVICE_GROUP" "$STATE_ROOT" "$STATE_ROOT/Documents" "$STATE_ROOT/state"
chmod 0700 "$STATE_ROOT" "$STATE_ROOT/Documents" "$STATE_ROOT/state"

# Refuse to replace a state path before touching files in the candidate release.
if [[ -e "$release/state" || -L "$release/state" ]]; then
  [[ -L "$release/state" && $(realpath -e -- "$release/state") == "$STATE_ROOT/state" ]] || fail 'release already has a different state path; refusing to replace it.'
fi

# Stop an existing scheduled/active deployment before lengthy package work.
timer_load=$(/usr/bin/systemctl show -p LoadState --value "$TIMER" 2>/dev/null || true)
if [[ -n "$timer_load" && "$timer_load" != not-found ]]; then
  /usr/bin/systemctl disable --now "$TIMER"
  [[ $(/usr/bin/systemctl show -p ActiveState --value "$TIMER") == inactive ]] || fail 'existing timer did not stop.'
  [[ $(/usr/bin/systemctl is-enabled "$TIMER" 2>/dev/null || true) == disabled ]] || fail 'existing timer was not disabled.'
fi
service_load=$(/usr/bin/systemctl show -p LoadState --value "$SERVICE" 2>/dev/null || true)
if [[ -n "$service_load" && "$service_load" != not-found ]]; then
  /usr/bin/systemctl stop "$SERVICE"
  [[ $(/usr/bin/systemctl show -p ActiveState --value "$SERVICE") == inactive ]] || fail 'existing service did not stop.'
fi

# Keep application code administrator-owned before making the state link.
chown -hR -P root:root "$release"

# Keep restart continuity, account locks, market-open claims and ledgers outside
# versioned releases. Refuse to replace any existing release state path.
if [[ -e "$release/state" || -L "$release/state" ]]; then
  : # The verified persistent link is already in place.
else
  ln -s "$STATE_ROOT/state" "$release/state"
fi

# Install dependencies without running package lifecycle scripts.
cd "$release"
/usr/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Verify the complete release tree remains read-only to the service identity.
service_writable=$(runuser -u "$SERVICE_USER" -- find "$release" -xdev -path "$release/state" -prune -o -writable -print -quit) || fail 'could not verify release permissions as v5bot.'
[[ -z "$service_writable" ]] || fail "release contains a path writable by v5bot: $service_writable"
runuser -u "$SERVICE_USER" -- test ! -w "$APP_ROOT" || fail 'v5bot can modify the release root.'
runuser -u "$SERVICE_USER" -- test ! -w "$RELEASES" || fail 'v5bot can modify the releases directory.'

install -o root -g root -m 0644 "$release/deploy/linux/systemd/v5-live.service" "/etc/systemd/system/$SERVICE"
install -o root -g root -m 0644 "$release/deploy/linux/systemd/v5-live.timer" "/etc/systemd/system/$TIMER"
/usr/bin/systemctl daemon-reload

# The deployment always leaves LIVE stopped and unscheduled.
/usr/bin/systemctl disable --now "$TIMER"
/usr/bin/systemctl stop "$SERVICE"
[[ $(/usr/bin/systemctl show -p ActiveState --value "$TIMER") == inactive ]] || fail 'timer did not stop.'
[[ $(/usr/bin/systemctl show -p ActiveState --value "$SERVICE") == inactive ]] || fail 'service did not stop.'
[[ $(/usr/bin/systemctl is-enabled "$TIMER" 2>/dev/null || true) == disabled ]] || fail 'timer is not disabled.'
service_enabled=$(/usr/bin/systemctl is-enabled "$SERVICE" 2>/dev/null || true)
[[ "$service_enabled" == disabled || "$service_enabled" == static ]] || fail "service is enabled or has an unexpected state: $service_enabled"

next_link="$APP_ROOT/.current.$$"
ln -s "$release" "$next_link"
mv -Tf "$next_link" "$APP_ROOT/current"

printf 'Installed release %s. LIVE service and timer are disabled and stopped.\n' "${release##*/}"
printf 'Transfer credentials separately to %s/Documents/live.env with owner v5bot:v5bot and mode 0600.\n' "$STATE_ROOT"
printf 'Run deploy/linux/preflight.sh --static before considering any activation.\n'
