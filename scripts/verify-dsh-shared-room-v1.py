#!/usr/bin/env python3
"""共享群 V1 定向门禁：仅用临时数据库、临时 profile、独立登录会话和离线模型。"""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', required=True, type=Path, help='DSH RC2 安装目录中的 runtime')
    parser.add_argument('--edu-api', type=Path, default=ROOT.parent / 'ai-education/backend/modules/edu-api')
    args = parser.parse_args()
    runtime = args.runtime_dir.resolve(strict=True)
    if not (runtime / 'node_modules/@deepseek-ai/dsh-agent-loop/package.json').is_file():
        parser.error('--runtime-dir 不是 DSH runtime 模块目录')
    with tempfile.TemporaryDirectory(prefix='dsh-v1-', dir='/tmp') as tmp:
        data = str(Path(tmp) / 'pg')
        run('initdb', '-D', data, '--no-locale', '-E', 'UTF8', '-A', 'trust', cwd=tmp)
        # 私有 0700 目录内的 Unix socket；不监听 TCP，不读取共享数据库连接串。
        run('pg_ctl', '-D', data, '-l', str(Path(tmp) / 'pg.log'), '-o',
            f"-k {tmp} -c listen_addresses=''", '-w', 'start', cwd=tmp)
        try:
            env = dict(os.environ, TEST_POSTGRES_DSN=f'host={tmp} dbname=postgres sslmode=disable')
            run('go', 'test', './handlers', '-count=1', '-run', '^TestDSHSharedRoomV1MemberRoundTrip$',
                cwd=args.edu_api.resolve(strict=True), env=env)
        finally:
            run('pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop', cwd=tmp)
        env = dict(os.environ, HOME=tmp, COPIS_DEV='1', COPIS_DSH_RC2_RUNTIME=str(runtime))
        run('node', '--test', 'apps/electron/src/main/lib/dsh-group-chat/shared-room-session.integration.test.mjs', env=env)
        run('bun', 'test', 'apps/electron/src/main/ipc-tests/dsh-group-chat.test.ts', env=env)
        run('bun', 'test', 'apps/electron/src/main/lib/working-api-client.test.ts', '--test-name-pattern=共享群请求绑定', env=env)
        run('bun', 'test', 'src/renderer/components/dsh-group-chat/DshSharedRooms.test.tsx',
            'src/renderer/components/dsh-group-chat/shared-room-data.test.ts', cwd=ROOT / 'apps/electron', env=env)
        run('cargo', 'test', '--offline', 'shared_room_', cwd=ROOT / 'native/http-api-server')


if __name__ == '__main__':
    main()
