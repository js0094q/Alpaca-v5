# Linux host hardening runbook

This is a manual first-deployment checklist based on Ubuntu Server 24.04 LTS. The Njalla hostname, operating-system release, SSH port, and recovery path have not been identified in this checkout; verify them before using this guide. Njalla describes its VPS service as Incus-based and provides root SSH access, so this runbook does not assume a full VM or provider console. Confirm the actual target's capabilities before any changes. Stop if the host is not Ubuntu 24.04 or its current access/firewall state differs from the assumptions below. This document makes no remote changes. [Njalla server details](https://njal.la/servers/)

The service is expected to run under the separate `v5bot` account, with releases under `/opt/v5/releases` and `/opt/v5/current` pointing at the active release. Keep application access outbound-only unless a separately reviewed service requirement says otherwise. Coordinate systemd units, app installation, account creation, credentials, and app rollback with their owners; this guide does not create or change them.

## Preconditions and recovery

1. Confirm the Njalla server identity and OS through the account and an authenticated shell. Do not infer the target from an unrelated VPS or an SSH alias with no corroborating provider evidence. Verify a recovery route actually exists and works before changing SSH or firewall policy. This may be an existing second root key-authenticated SSH session or a confirmed provider rescue path; do not assume a console exists. If no recovery route is confirmed, stop before SSH/firewall changes.
2. Keep the current root SSH session open. Open a second terminal and prove a fresh root public-key login works before changing access policy. Do not close the original session until the new route is confirmed.
3. Before host changes, save a root-only baseline outside the repository. For example, using a unique timestamped directory under `/root`:

   ```sh
   sudo sh -c 'umask 077; d=/root/v5-hardening-baseline-$(date -u +%Y%m%dT%H%M%SZ); install -d -m 0700 "$d"; date -u > "$d/captured-at.txt"; hostnamectl > "$d/host.txt"; cat /etc/os-release > "$d/os-release"; uname -a > "$d/uname.txt"; ss -lntup > "$d/listeners.txt"; /usr/sbin/sshd -T > "$d/sshd-effective.txt" 2>&1; systemctl --no-pager --full status ssh sshd fail2ban ufw > "$d/services.txt" 2>&1; dpkg-query -W > "$d/packages.txt" 2>&1; ufw status verbose > "$d/ufw.txt" 2>&1; nft list ruleset > "$d/nft-rules.txt" 2>&1; iptables-save > "$d/iptables-v4.txt" 2>&1; ip6tables-save > "$d/iptables-v6.txt" 2>&1; systemctl --failed --no-pager > "$d/failed-units.txt" 2>&1'
   ```

   Record the actual SSH listener/port and firewall implementation from this baseline. Missing tools or units may report errors on a fresh host; retain those results rather than installing tools merely for the snapshot. If SSH runs in a nonstandard way or an existing firewall is managed outside UFW, stop and identify the actual control path. If UFW is already active or has rules beyond SSH, do not reset it; reconcile the existing policy before proceeding.
4. Back up each file before editing it, preserving permissions and ownership. Keep the backup path in the root-only administrative record. Do not put private keys, API credentials, or connection secrets in this repository.

## Patch the host

On Ubuntu 24.04, update package metadata and install available package updates during a maintenance window:

```sh
sudo apt update
sudo apt-get -s full-upgrade
```

Review the simulation for removals, service restarts, or a release upgrade. Stop if removals or a distribution upgrade are proposed; resolve those explicitly before proceeding. If acceptable, apply the reviewed transaction with `sudo apt full-upgrade` during the maintenance window. Reboot only when required by the update and only after the verified recovery route and existing application recovery procedure are available. After reboot, confirm SSH and the host are healthy before continuing.

## Prove key access before restricting SSH

Install the root administrator's public key in root's authorized keys using the currently working authenticated session; use a provider rescue interface only if one has been confirmed. Do not copy a private key to the server. Back up `/etc/ssh/sshd_config` and any included SSH configuration files. If the effective root policy is already `prohibit-password`, keep it and proceed to the fresh root-login check. If it is `no`, change only that directive to `PermitRootLogin prohibit-password`, leaving the existing password and keyboard-interactive authentication settings unchanged for this key-proof stage. Confirm `sshd -t` succeeds, inspect `sshd -T`, reload SSH, then from a separate terminal establish a fresh SSH session that logs in as `root` and authenticates with the public key; run a harmless command such as `id` and keep that root session open. A sudo-capable non-root login does not satisfy this gate. If fresh root public-key login does not succeed, stop, restore the saved configuration through the existing session or a verified rescue path, and retain the current access method. The accepted final root policy deliberately continues to permit root key login.

Now complete the SSH restriction using the saved configuration. Add a clearly named drop-in under `/etc/ssh/sshd_config.d/` only if the installed `sshd_config` includes that directory; otherwise make a backed-up change in the main file. Set and verify these effective values:

```text
PubkeyAuthentication yes
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
```

`PermitRootLogin` must remain `prohibit-password`; do not change it to `no`. Preserve other existing SSH settings unless a separately reviewed requirement justifies a change. Check parsing with `sudo sshd -t`, then inspect effective values with `sudo sshd -T` (including any relevant `Match` context). If parsing or effective values are unexpected, restore the backup before reloading. Reload, do not stop, SSH (`sudo systemctl reload ssh` on Ubuntu 24.04; use the actual service unit if it differs). Open a third fresh key-authenticated session and verify administrative access before closing either earlier session.

Rollback for an SSH lockout: use only the recovery route verified before the change to restore the saved SSH configuration, run `sshd -t`, then reload the SSH service. Keep recovery credentials and instructions outside this repository.

## Restrict inbound traffic to SSH

Use this UFW procedure only after identifying the active firewall and reviewing the baseline. Confirm the actual SSH listening port; substitute it for `22` below when different. Preserve established UFW rules and never run `ufw reset` as part of this procedure. If this is a fresh host with no firewall rules, install UFW (`sudo apt install ufw`) if needed. Confirm IPv6 filtering is enabled when the host has IPv6 (`IPV6=yes` in `/etc/default/ufw`) so IPv6 is not left unfiltered.

```sh
sudo ufw status verbose
sudo ufw allow 22/tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw --dry-run enable
```

Review the dry-run output. Ensure it preserves the SSH allow rule and does not remove any required provider/network rule. On a reviewed fresh host, use only the SSH allow rule and default deny-incoming/default allow-outgoing policy shown above. Only then, with the root SSH sessions and verified recovery route available, enable UFW (`sudo ufw enable`). Immediately confirm `sudo ufw status verbose` and make a new root key-authenticated SSH connection from a separate terminal. This host's application is expected to require no inbound application port; if that assumption is wrong, stop and review the requested port before enabling the firewall. Incus host-level firewall rules and guest permission limits must be identified first; do not assume the container can manage the effective network policy or alter provider-side rules. Do not change Njalla's network firewall/security group without a separate provider-side review.

If SSH becomes unreachable, use only the recovery route verified before the change to disable UFW (`sudo ufw disable`) or restore the recorded prior rules, then retest SSH before another firewall change.

## Enable SSH brute-force throttling

Install Fail2ban from the distribution repository (`sudo apt install fail2ban`). Add `/etc/fail2ban/jail.d/sshd.local` with only the SSH jail enabled, and set `port` to the actual SSH port:

```ini
[sshd]
enabled = true
port = 22
maxretry = 5
findtime = 10m
bantime = 1h
```

The SSH jail must read the log source that actually records sshd authentication failures. On systemd hosts, check `journalctl -u ssh.service -u sshd.service` and `journalctl _COMM=sshd` for recent events, then set `backend = systemd` in the jail only if those records are present. This backend may require the distribution's `python3-systemd` package; install it if the installed Fail2ban package does not provide the needed Python module. If sshd failures are written to `/var/log/auth.log` instead, use the package's file backend and that verified path. Do not enable the jail until the chosen source contains sshd events. Keep the package's default ban action unless the installed version requires a documented adjustment. Test before restart and inspect the jail after restart:

```sh
sudo fail2ban-client -t
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

Do not add broad administrator IP exclusions without confirming the address ranges. If an administrator is accidentally banned, use the verified recovery route and remove only that ban with `sudo fail2ban-client set sshd unbanip <address>`.

## Automatic security updates

Install/enable the distribution's unattended security update mechanism (`sudo apt install unattended-upgrades` on Ubuntu 24.04). Inspect `/etc/apt/apt.conf.d/50unattended-upgrades` and preserve the distribution's security origins; do not enable proposed, backports, or unrelated third-party origins here. Confirm `/etc/apt/apt.conf.d/20auto-upgrades` enables daily package-list refresh and unattended upgrades:

```text
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

Do not configure unattended automatic reboots for this service host. Check the unattended-upgrades logs after its first scheduled run and plan an explicit maintenance reboot when updates require one.

## Time synchronization

Check `timedatectl status` and `systemd-detect-virt`. Require the system clock to be synchronized. Incus guests may share the host clock and may not have permission to change it; verify the actual guest/provider behavior rather than installing a competing NTP service. On a host where systemd-timesyncd is the supported owner, enable it with `sudo timedatectl set-ntp true` and verify `systemctl status systemd-timesyncd`. If chrony or another NTP client owns synchronization, retain it. Stop and diagnose if the guest's clock is not synchronized or the time source cannot be established.

## Bound persistent journal usage

Create `/etc/systemd/journald.conf.d/60-v5-bounds.conf`:

```ini
[Journal]
SystemMaxUse=500M
SystemKeepFree=1G
RuntimeMaxUse=100M
MaxRetentionSec=30day
```

These are ceilings, not reserved capacity; choose lower values if the VM disk is smaller. If the filesystem cannot keep 1 GiB free, set `SystemKeepFree` to a conservative value supported by the actual disk. Apply with `sudo systemctl restart systemd-journald`, then check `journalctl --disk-usage` and `systemctl status systemd-journald`. Do not vacuum existing logs as part of setup.

## Completion check

For the actual Incus guest, verify its systemd release and sandbox support before the V5 service is considered usable:

```sh
systemd --version
sudo systemd-analyze verify /etc/systemd/system/v5-live.service /etc/systemd/system/v5-live.timer
sudo systemd-analyze security v5-live.service
```

Review any unsupported directives or effective controls against the installed systemd version and Incus permissions. Do not remove sandbox settings or widen capabilities merely to make the unit start; record the specific constraint and resolve it in a reviewed update. Confirm the guest's networking/firewall ownership and synchronized clock are compatible with outbound HTTPS and the calendar/session schedule. From a fresh administrator SSH session, verify key login succeeds and password login is refused. Confirm the effective root policy is still `PermitRootLogin prohibit-password`, the reviewed firewall allows the real SSH path and denies other unsolicited inbound connections, Fail2ban's `sshd` jail is active, security-update timers/configuration are enabled, NTP reports synchronized (or the shared host-clock arrangement is verified), and journald is healthy with bounded usage. Keep the verified recovery route and saved config backups until a later maintenance window has independently confirmed access and service health.

## Official references

- [Ubuntu Server: security suggestions](https://ubuntu.com/server/docs/explanation/security/security_suggestions/)
- [Ubuntu Server: firewall / UFW](https://ubuntu.com/server/docs/firewalls/)
- [Ubuntu Server: automatic updates](https://ubuntu.com/server/docs/how-to/software/automatic-updates/)
- [Ubuntu 24.04 LTS release notes](https://documentation.ubuntu.com/release-notes/24.04/)
- [Ubuntu 24.04: sshd(8)](https://manpages.ubuntu.com/manpages/noble/en/man8/sshd.8.html)
- [systemd: journald.conf(5)](https://www.freedesktop.org/software/systemd/man/252/journald.conf.html)
