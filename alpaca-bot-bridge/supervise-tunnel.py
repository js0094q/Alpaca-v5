#!/usr/bin/python3
"""Keep only the read-only connector available; never launch or poll the bot."""
import json
import os
import subprocess
import sys

CLIENT = '/opt/homebrew/bin/tunnel-client'
ALIAS = 'alpaca-bot-bridge'


def main():
    status = subprocess.run([CLIENT, 'runtimes', 'status', ALIAS, '--json'], capture_output=True, text=True, timeout=30)
    try:
        state = json.loads(status.stdout)
    except ValueError:
        state = {}
    if state.get('process_running') and state.get('healthy') and state.get('ready'):
        return 0
    credential = subprocess.run(['/usr/bin/security', 'find-generic-password', '-s', 'CONTROL_PLANE_API_KEY', '-w'], capture_output=True, text=True, timeout=15)
    if credential.returncode or not credential.stdout.strip():
        print('Monitoring tunnel credential unavailable.', file=sys.stderr)
        return 1
    env = dict(os.environ, CONTROL_PLANE_API_KEY=credential.stdout.strip())
    connected = subprocess.run([
        CLIENT, 'runtimes', 'connect', '--alias', ALIAS,
        '--tunnel-id', 'tunnel_6ab840fdf5e08191bbadd06feb50717a',
        '--runtime-api-key', 'env:CONTROL_PLANE_API_KEY',
        '--mcp-command', '/opt/homebrew/bin/node /Users/josephstew/The-Final-Trading-Bot-V5/alpaca-bot-bridge/index.mjs', '--json',
    ], env=env, capture_output=True, text=True, timeout=60)
    print('Monitoring tunnel connected.' if connected.returncode == 0 else 'Monitoring tunnel connection failed; inspect native runtime status.')
    return connected.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except subprocess.TimeoutExpired:
        print('Monitoring tunnel supervision timed out.', file=sys.stderr)
        sys.exit(1)
