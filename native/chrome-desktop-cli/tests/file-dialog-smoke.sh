#!/bin/bash
# 显式桌面回归：独立 Chrome 配置、本机无上传页面和测试文件；不查看截图、不操作用户窗口。
set -euo pipefail
if [[ "$(uname -s)" != Darwin || $# != 1 ]]; then
  echo '用法：bash tests/file-dialog-smoke.sh <copis-chrome绝对路径>' >&2
  exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d /tmp/copis-file-dialog-smoke.XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
swiftc -O -warnings-as-errors "$root/tests/file-dialog-fixture/main.swift" -o "$scratch/fixture-ax"
/usr/bin/python3 - "$1" "$scratch" <<'PY'
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

cli = str(Path(sys.argv[1]).resolve(strict=True))
scratch = Path(sys.argv[2])
chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if not Path(chrome).is_file():
    raise SystemExit('找不到 Chrome 正式版')
fixture = b'''<!doctype html><meta charset="utf-8"><title>CopisFileChooserFixture</title>
<button id="pick">Copis open test picker</button><input id="file" type="file" accept=".txt" hidden>
<script>pick.onclick=()=>{file.value='';document.title='CopisFileChooserFixture';file.click()};file.onchange=()=>{document.title='CopisFileChosen:'+file.files[0].name}</script>'''
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Security-Policy', "connect-src 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(fixture)
    def do_POST(self):
        self.send_error(405)
    def log_message(self, *_):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
test_dir = scratch / '中文 test folder'
test_dir.mkdir()
test_file = test_dir / 'copis-test.txt'
test_file.write_text('仅用于本机文件选择回归；无上传。', encoding='utf-8')
env = dict(os.environ, COPIS_CHROME_RUNTIME_DIR=str(scratch / 'runtime'))
def call(*args, error=None, runtime_env=None):
    completed = subprocess.run([cli, *args], env=runtime_env or env, capture_output=True, text=True, timeout=30)
    result = json.loads(completed.stdout)
    if error:
        assert not result['ok'] and result['error']['code'] == error, result
    else:
        assert completed.returncode == 0 and result['ok'], result
    return result
previous_pid = subprocess.check_output([str(scratch / 'fixture-ax'), '--front-pid'], text=True).strip()
assert int(previous_pid) > 0
owned = None
cold_env = dict(env, COPIS_CHROME_RUNTIME_DIR=str(scratch / 'cold-runtime'))
try:
    owned = subprocess.Popen([chrome, '--user-data-dir=' + str(scratch / 'profile'),
        '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking',
        '--force-renderer-accessibility', '--window-size=1000,800', f'http://127.0.0.1:{server.server_port}/'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 12
    window = None
    while time.monotonic() < deadline:
        window = next((w for w in call('windows')['windows'] if w['pid'] == owned.pid and 'CopisFileChooserFixture' in w['title']), None)
        if window:
            break
        time.sleep(0.1)
    assert window, '没有找到独立测试窗口'
    connection = call('connect', '--window', str(window['windowId']))['connectionId']
    call('select-file', '--connection', 'wrong-connection', '--path', str(test_file), error='CONNECTION_INVALID')
    call('select-file', '--connection', connection, '--path', str(scratch / 'missing.txt'), error='FILE_NOT_READABLE')
    call('select-file', '--connection', connection, '--path', str(test_file), error='FILE_DIALOG_NOT_FOUND')
    assert call('status')['connected'], '参数或对话框错误不应吊销连接'
    subprocess.run([str(scratch / 'fixture-ax'), str(owned.pid), str(window['windowId']), 'open'], check=True, timeout=8)
    selected = call('select-file', '--connection', connection, '--path', str(test_file))
    assert selected['connectionId'] == connection and selected['selected'] and selected['dialogClosed'], selected
    subprocess.run([str(scratch / 'fixture-ax'), str(owned.pid), str(window['windowId']), 'selected'], check=True, timeout=8)
    assert call('status')['connected'], '选完文件应保留原连接'
    call('disconnect', '--connection', connection)
    # Given Chrome 在后台且新的 Helper 尚未查询 AX，Then 专用输入能激活原应用后精确定位面板。
    cold_connection = call('connect', '--window', str(window['windowId']), runtime_env=cold_env)['connectionId']
    subprocess.run([str(scratch / 'fixture-ax'), str(owned.pid), str(window['windowId']), 'open'], check=True, timeout=8)
    background = subprocess.run([str(scratch / 'fixture-ax'), str(owned.pid), str(window['windowId']), 'background:' + previous_pid],
        check=True, capture_output=True, text=True, timeout=5)
    assert background.stdout.strip() == 'READY: FIXTURE_CHROME_IS_BACKGROUND'
    cold_selected = call('select-file', '--connection', cold_connection, '--path', str(test_file), runtime_env=cold_env)
    assert cold_selected['selected'] and cold_selected['dialogClosed']
    subprocess.run([str(scratch / 'fixture-ax'), str(owned.pid), str(window['windowId']), 'selected'], check=True, timeout=8)
    call('disconnect', '--connection', cold_connection, runtime_env=cold_env)
    print('PASS: Chrome 明确在后台、独立冷 Helper 首次 AX 查询的真实文件选择回归')
    print('PASS: CLI 真实文件选择 BDD；无 frame、中文空格路径、错误连接/文件/未打开面板拒绝且可恢复；隔离 fixture 无上传')
finally:
    stop_failed = False
    try:
        for private_env in [env, cold_env]:
            try:
                call('daemon', 'stop', runtime_env=private_env)
            except (AssertionError, OSError, subprocess.TimeoutExpired, ValueError):
                stop_failed = True
    finally:
        if owned:
            if owned.poll() is None and window:
                try:
                    subprocess.run([str(scratch / 'fixture-ax'), str(owned.pid), str(window['windowId']), 'background:' + previous_pid],
                        capture_output=True, timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            owned.terminate()
            try:
                owned.wait(timeout=5)
            except subprocess.TimeoutExpired:
                owned.kill()
                owned.wait(timeout=3)
        server.shutdown()
        server.server_close()
    if stop_failed:
        raise RuntimeError('测试私有 runtime 停止未确认')
PY
