# V5 Linux release operations

These scripts prepare a revisioned release on a Linux host and leave
`v5-live.service` inactive and `v5-live.timer` disabled. They do not launch the
bot, enable scheduling, or make broker requests. No Njalla hostname or target
connection was identified for this preparation, so no remote operation was
attempted.

On a reviewed fresh Ubuntu Server 24.04 LTS host, create the service identity as root. Ubuntu's official release notes list standard security maintenance through May 2029 ([release notes](https://documentation.ubuntu.com/release-notes/24.04/)):

```sh
useradd --system --create-home --home-dir /var/lib/v5bot --shell /usr/sbin/nologin --user-group v5bot
passwd --lock v5bot
```

The administrator must install the latest Node.js 24 LTS patch release at
`/usr/bin/node` and npm at `/usr/bin/npm`, and stage a reviewed source revision
at `/opt/v5/releases/<revision>`. The Node.js support lifecycle is published
[by the Node.js project](https://nodejs.org/en/about/previous-releases). Do not
download or execute an unverified runtime binary. Keep each release
root-owned and immutable to `v5bot`. Run as root:

From the reviewed source checkout, first inspect the exact commit and confirm
there are no uncommitted source changes. Then export only that committed
revision into a versioned directory. Set `REPO` to the checked-out repository
path and `HOST` to the host whose SSH host key was verified through the
provider's trusted channel:

```sh
REPO=/path/to/reviewed/repository
HOST=verified-hostname
REV=$(git -C "$REPO" rev-parse --verify HEAD)
git -C "$REPO" show -s --format='%H %s' "$REV"
test -z "$(git -C "$REPO" status --porcelain)" || { echo 'working tree must be clean' >&2; exit 1; }
git -C "$REPO" archive --format=tar "$REV" | ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "root@$HOST" "test ! -e /opt/v5/releases/$REV && test ! -L /opt/v5/releases/$REV && install -d -o root -g root -m 0755 /opt/v5/releases/$REV && tar -xf - -C /opt/v5/releases/$REV"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "root@$HOST" "/opt/v5/releases/$REV/deploy/linux/install.sh /opt/v5/releases/$REV"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "root@$HOST" "/opt/v5/current/deploy/linux/preflight.sh --static"
```

Do not use an archive of an uncommitted working tree. The final LIVE loader and
Linux assets must already be included in the reviewed commit before staging.

Installation creates mode-`0700` `/var/lib/v5bot`, `Documents`, and `state`
directories, links the release's `state/` to the shared state directory,
installs production dependencies without package lifecycle scripts, and
installs the service and timer units. The shared state directory holds
account-scoped continuity and ledgers, trade-authority locks, and market-open
claims. It is intentionally retained across releases and rollback. The
installer refuses to reuse the current release or replace a different state
path. Do not remove or replace shared state when changing revisions.

Transfer the local credential file without displaying its contents. First
set/confirm locally that `~/Documents/live.env` is mode `0600`; then use the
retained root SSH key after verifying the host key. Stage the file in root's
private directory, then move it into the service home with exact ownership and
permissions; no command sources or prints its contents:

```sh
chmod 600 ~/Documents/live.env
scp -p -o BatchMode=yes -o StrictHostKeyChecking=yes ~/Documents/live.env "root@$HOST:/root/.v5-live.env.incoming"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "root@$HOST" 'umask 077; chmod 600 /root/.v5-live.env.incoming && rm -f /var/lib/v5bot/Documents/live.env && install -o v5bot -g v5bot -m 0600 /root/.v5-live.env.incoming /var/lib/v5bot/Documents/live.env && rm -f /root/.v5-live.env.incoming'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes "root@$HOST" '/opt/v5/current/deploy/linux/preflight.sh'
```

The destination must be owned by `v5bot:v5bot`, mode `0600`, and read from
`$HOME/Documents/live.env` with `HOME=/var/lib/v5bot`. Do not copy PAPER
credentials into this location. Preflight checks file metadata only; it never
reads or prints credential values.

Run the non-ordering preflight as root after installation. It checks the
release and shared-state paths, service-user write access, parses the LIVE
wrapper with `node --check` without importing it, checks account/home/shell and
locked-password properties, confirms no `paper.env` exists in the service
home, checks credential ownership and permissions, and confirms the service is
inactive and timer disabled. State and code permission checks run as root and
as `v5bot` as appropriate:

```sh
/opt/v5/current/deploy/linux/preflight.sh
```

Before transferring credentials, use `preflight.sh --static`; that mode checks
the release, account, state, and stopped/disabled systemd state but permits
`live.env` to be absent. Neither mode imports the trading runner, opens a
broker connection, or places orders.

Rollback accepts only an already staged release name under
`/opt/v5/releases`. It stops and disables LIVE first, reinstalls that
revision's unit files, atomically switches `/opt/v5/current`, and retains
persistent state. It does not change credentials or reset continuity:

```sh
/opt/v5/current/deploy/linux/rollback.sh <previous-revision>
```

The timer runs weekdays at 09:30 America/New_York, asks Alpaca for that date's
calendar, skips closed dates, waits for the actual open, and ends entry
eligibility at the earlier of 15:30 Eastern or the session close.
`Persistent=no` prevents a missed run from replaying after downtime. The
runtime warmup and signal window establish the expected 09:32 entry start.

On reboot during a session, systemd sends SIGTERM and waits without a timeout
while V5 stops new entries and drains owned exposure. If shutdown interrupts
that drain, the timer does not restart or replay the session. Before explicitly
re-enabling the timer, inspect broker positions and open orders, reconcile them
with the retained continuity file and ledger, and resolve any dated market-open
claim through the established operator procedure. Do not delete a claim or
reset continuity to force a same-day retry.

Continuity and ledger files are retained across releases. The ledger is an
append-only local execution record used in reconciliation alongside broker
data; it does not supersede broker state. Do not truncate it or apply ordinary
log rotation. No automatic retention or archival policy is implemented here.

The final LIVE credential loader is present in the upstream V5 source commit.
The deployment timer is not enabled by installation. Keep LIVE stopped until
the integrated release has been reviewed and the user separately authorizes
activation. Unit files are in `systemd/`; the manual SSH and host hardening
sequence is in `HARDENING.md`.
