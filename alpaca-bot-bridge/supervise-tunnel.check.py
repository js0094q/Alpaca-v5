import importlib.util
import subprocess
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).with_name('supervise-tunnel.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = lambda text='', code=0: subprocess.CompletedProcess([], code, text, '')
with patch.object(module.subprocess, 'run', return_value=result('{"process_running":true,"healthy":true,"ready":true}')) as run:
    assert module.main() == 0
    assert run.call_count == 1
with patch.object(module.subprocess, 'run', side_effect=[result('{}'), result('fixture'), result('{}')]) as run:
    assert module.main() == 0
    command = run.call_args.args[0]
    assert command[:3] == [module.CLIENT, 'runtimes', 'connect']
    assert command[command.index('--alias') + 1] == 'alpaca-bot-bridge'
    assert command[command.index('--mcp-command') + 1].endswith('/alpaca-bot-bridge/index.mjs')
    assert 'fixture' not in command
with patch.object(module.subprocess, 'run', side_effect=[result('{}'), result('', 1)]) as run:
    assert module.main() == 1
    assert run.call_count == 2
print('tunnel supervision check passed')
