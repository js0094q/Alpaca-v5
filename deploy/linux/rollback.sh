#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT=/opt/v5
readonly RELEASES="$APP_ROOT/releases"
readonly SERVICE=v5-live.service
readonly TIMER=v5-live.timer

fail() { printf 'rollback: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'run as root.'
[[ $# -eq 1 ]] || fail 'usage: rollback.sh <revision>'
target=$(realpath -e -- "$RELEASES/$1")
[[ "$target" == "$RELEASES"/* ]] || fail 'target must be a release under /opt/v5/releases.'
[[ -f "$target/deploy/linux/run-live.mjs" && -L "$target/state" ]] || fail 'target release is incomplete or has no persistent state link.'
[[ $(realpath -e -- "$target/state") == /var/lib/v5bot/state ]] || fail 'target does not use the shared persistent state directory.'
[[ -f "$target/deploy/linux/systemd/v5-live.service" && -f "$target/deploy/linux/systemd/v5-live.timer" ]] || fail 'target systemd units are missing.'
service_writable=$(runuser -u v5bot -- find "$target" -xdev -path "$target/state" -prune -o -writable -print -quit) || fail 'could not verify rollback release permissions as v5bot.'
[[ -z "$service_writable" ]] || fail "rollback release contains a path writable by v5bot: $service_writable"
runuser -u v5bot -- test ! -w "$APP_ROOT" || fail 'v5bot can modify the release root.'
runuser -u v5bot -- test ! -w "$RELEASES" || fail 'v5bot can modify the releases directory.'

/usr/bin/systemctl disable --now "$TIMER"
/usr/bin/systemctl stop "$SERVICE"
[[ $(/usr/bin/systemctl show -p ActiveState --value "$TIMER") == inactive ]] || fail 'timer did not stop.'
[[ $(/usr/bin/systemctl show -p ActiveState --value "$SERVICE") == inactive ]] || fail 'service did not stop.'
[[ $(/usr/bin/systemctl is-enabled "$TIMER" 2>/dev/null || true) == disabled ]] || fail 'timer is not disabled.'
install -o root -g root -m 0644 "$target/deploy/linux/systemd/v5-live.service" "/etc/systemd/system/$SERVICE"
install -o root -g root -m 0644 "$target/deploy/linux/systemd/v5-live.timer" "/etc/systemd/system/$TIMER"
/usr/bin/systemctl daemon-reload
next_link="$APP_ROOT/.current.$$"
ln -s "$target" "$next_link"
mv -Tf "$next_link" "$APP_ROOT/current"
[[ $(/usr/bin/systemctl show -p ActiveState --value "$TIMER") == inactive ]] || fail 'timer did not stop.'
[[ $(/usr/bin/systemctl show -p ActiveState --value "$SERVICE") == inactive ]] || fail 'service did not stop.'
[[ $(/usr/bin/systemctl is-enabled "$TIMER" 2>/dev/null || true) == disabled ]] || fail 'timer is not disabled.'
service_enabled=$(/usr/bin/systemctl is-enabled "$SERVICE" 2>/dev/null || true)
[[ "$service_enabled" == disabled || "$service_enabled" == static ]] || fail "service is enabled or has an unexpected state: $service_enabled"
printf 'Rolled current release back to %s. LIVE service and timer remain disabled and stopped.\n' "${target##*/}"
