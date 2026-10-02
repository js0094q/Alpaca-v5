# Manual V5 LIVE service on `jslive`

This target-specific procedure supersedes the generic release installer and
timer in `deploy/linux/`. The host is an already hardened Ubuntu 24.04 LXC
with root key SSH access. Keep the current ownership and layout: `v5bot` has
home `/home/v5bot`, the repository is
`/home/v5bot/The-Final-Trading-Bot-V5`, and that repository remains owned by
`v5bot`. Do not create another state directory or copy continuity, ledger,
telemetry, or environment files as part of repository setup. This runbook does
not change SSH, firewall, account authentication, or host hardening.

Node.js 26.10.0 was installed by root from the official checksum-verified
release archive at `/opt/node-v26.10.0-linux-x64`, with `/usr/local/bin/node`
and `/usr/local/bin/npm` symlinks. The `libatomic1` runtime dependency was
installed; Node and npm were verified to run as `v5bot`. Check the links and
versions without running the trading entry point:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'readlink -f /usr/local/bin/node; node --version; npm --version'
```

Install dependencies in both package directories as `v5bot` so the existing
repository stays owned by the service account. Lifecycle scripts are skipped;
this does not start the bot:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive "runuser -u v5bot -- sh -c 'cd /home/v5bot/The-Final-Trading-Bot-V5 && npm ci --ignore-scripts && npm ci --ignore-scripts --prefix alpaca-bot-bridge'"
```

Joe transfers both credential files directly into the service home over the
verified root SSH key. First ensure the local files are mode `0600`; the
commands do not display or source their contents:

```sh
chmod 600 ~/Documents/live.env ~/Documents/paper.env
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'install -d -o v5bot -g v5bot -m 0700 /home/v5bot/Documents'
scp -p -o BatchMode=yes -o StrictHostKeyChecking=yes ~/Documents/live.env ~/Documents/paper.env root@jslive:/home/v5bot/Documents/
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'chown v5bot:v5bot /home/v5bot/Documents/live.env /home/v5bot/Documents/paper.env && chmod 0600 /home/v5bot/Documents/live.env /home/v5bot/Documents/paper.env && stat -c "%U:%G %a %n" /home/v5bot/Documents/live.env /home/v5bot/Documents/paper.env'
```

The credential check prints only owner, group, permissions, and filenames.
`HOME=/home/v5bot` ensures the LIVE and PAPER loaders resolve separate files.
Credential transfer and setup are Joe's manual action; this task does not
access either local or remote credential file. Before the first service start,
perform the already-authorized read-only LIVE account check; do not display or
source credential contents during deployment.

Ensure the repository state directory exists as `v5bot`-owned before
installing the service unit. `install -d` creates it when absent or corrects
the directory's owner and permissions without removing its contents:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'install -d -o v5bot -g v5bot -m 0700 /home/v5bot/The-Final-Trading-Bot-V5/state'
```

Install the unit file as root, reload systemd, and verify it is inactive. The
unit deliberately has no install target, there is no timer, and it is not
enabled at boot:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'install -o root -g root -m 0644 /home/v5bot/The-Final-Trading-Bot-V5/deploy/jslive/systemd/v5-live.service /etc/systemd/system/v5-live.service && systemctl daemon-reload && test "$(systemctl show -p UnitFileState --value v5-live.service)" = static && test "$(systemctl show -p ActiveState --value v5-live.service)" = inactive'
```

`systemctl is-enabled` should report `static`; `ActiveState` should be
`inactive`. Do not run `systemctl enable`. The service runs the same supervisor
arguments as `npm run live:morning`: new entries stop at 12:00 Eastern, and
15:45 triggers the normal persistent SELL path for an open position; this does
not guarantee a fill. The existing close margin clamps the flatten cutoff to
60 seconds before an earlier market close, and the runtime fails closed if
today's close is unavailable. The supervisor handles eligible same-date
process restarts. The unit grants
write access only to the repository's `state` directory; code and the rest of
the home remain read-only to the process. Its `SIGTERM` handling forwards the
signal to the V5 child, which stops entries and drains owned exposure. systemd
waits without a stop timeout. Output goes to journald.

On reboot during a session, systemd sends SIGTERM and waits without a timeout
while V5 stops new entries and drains owned exposure. If shutdown interrupts
that drain, the manually started service does not restart or replay the
session. Before a later explicit start, inspect broker positions and open
orders, reconcile them with the retained continuity file and ledger, and
resolve any dated market-open claim through the established operator
procedure. Do not delete a claim or reset continuity to force a same-day retry.

The exact manual lifecycle and log commands are:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'systemctl start v5-live.service'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'systemctl stop v5-live.service'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'systemctl status --no-pager v5-live.service'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'journalctl -u v5-live.service -n 100 --no-pager'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'journalctl -u v5-live.service -f'
```

Starting the service can trade LIVE. No `start`, broker request, or order was
made while preparing these local files. Before any later start, complete the
read-only account check and verify the service unit and expected environment
metadata, and keep the Mac trading runner and scheduler off: the runtime
authority lock is local to this host and does not coordinate across machines.
Never enable boot start or add a timer without a new explicit decision.

## Manual rollback to a reviewed commit

Rollback is a code-only operation. First stop the service and verify it is
inactive. Before changing code, settle and reconcile any broker positions and
open orders using the retained continuity file and ledger. If exposure is not
settled or cannot be reconciled, do not switch revisions. The state directory
and both credential files are outside the rollback operation and must remain
untouched.

Substitute a reviewed full Git commit hash for `FULL_REVIEWED_COMMIT_HASH` in
the command below. Select a revision whose runtime and systemd unit are
compatible with the retained state format. It fetches refs and checks out only
that known revision as `v5bot`; it does not reset or clean the worktree. `npm
ci` replaces package dependencies only:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'systemctl stop v5-live.service && test "$(systemctl show -p ActiveState --value v5-live.service)" = inactive'
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive "runuser -u v5bot -- sh -c 'cd /home/v5bot/The-Final-Trading-Bot-V5 && git fetch origin && git checkout --detach FULL_REVIEWED_COMMIT_HASH && test -f deploy/jslive/systemd/v5-live.service && test \"\$(git rev-parse HEAD)\" = FULL_REVIEWED_COMMIT_HASH && npm ci --ignore-scripts && npm ci --ignore-scripts --prefix alpaca-bot-bridge'"
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes root@jslive 'install -o root -g root -m 0644 /home/v5bot/The-Final-Trading-Bot-V5/deploy/jslive/systemd/v5-live.service /etc/systemd/system/v5-live.service && systemctl daemon-reload && test "$(systemctl show -p UnitFileState --value v5-live.service)" = static && test "$(systemctl show -p ActiveState --value v5-live.service)" = inactive'
```

This procedure leaves the unit stopped and not enabled. Confirm the checked-out
revision and unit behavior before any separate manual start.
