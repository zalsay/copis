#!/usr/bin/env python3
"""验证共享群 FIFO 的真实线协议。只用临时 PostgreSQL、测试 Redis、临时 HOME 和离线 DSH 模型。"""
import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = '''package handlers

import (
	"ai-education-backend/middleware"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestCopisDSHQueueWire(t *testing.T) {
	h := newTask7fHarness(t)
	migrateDSHFixture(t, h)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	StartChatRoomV2InvocationTimeoutWorker(ctx, h.store, h.hub)
	cookie := middleware.WebSessionCookieNameFor(false) + "="
	wire, _ := json.Marshal(map[string]any{"url": h.server.URL, "userId": h.host.id, "deviceId": h.host.deviceID, "roomId": task7fRoomID, "agentId": task7fAgentID, "memberCookie": cookie + h.member.sessionID, "hostCookie": cookie + h.host.sessionID})
	cmd := exec.CommandContext(ctx, "node", os.Getenv("COPIS_QUEUE_PROBE"))
	cmd.Env = append(os.Environ(), "HOME="+t.TempDir(), "COPIS_QUEUE_FIXTURE="+string(wire))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	t.Log(string(out))
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', required=True, type=Path)
    parser.add_argument('--edu-api', type=Path, default=ROOT.parent / 'ai-education/backend/modules/edu-api')
    args = parser.parse_args()
    runtime = args.runtime_dir.resolve(strict=True)
    edu = args.edu_api.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='dsh-queue-', dir='/tmp') as tmp:
        p = Path(tmp)
        (p / 'probe.go').write_text(FIXTURE)
        overlay = {'Replace': {str(edu / 'handlers/local_dsh_queue_wire_test.go'): str(p / 'probe.go')}}
        (p / 'overlay.json').write_text(json.dumps(overlay))
        subprocess.run([ROOT/'node_modules/.bin/esbuild','scripts/test-fixtures/dsh-queue-wire.ts','--bundle','--platform=node','--format=esm','--outfile='+str(p/'probe.mjs')],cwd=ROOT,check=True)
        subprocess.run(['initdb','-D',p/'pg','--no-locale','-E','UTF8','-A','trust'],stdout=subprocess.DEVNULL,check=True)
        subprocess.run(['pg_ctl','-D',p/'pg','-l',p/'pg.log','-o',f"-k {tmp} -c listen_addresses=''",'-w','start'],check=True)
        try:
            env=dict(os.environ, TEST_POSTGRES_DSN=f'host={tmp} dbname=postgres sslmode=disable', COPIS_QUEUE_PROBE=str(p/'probe.mjs'), COPIS_QUEUE_ROOT=str(ROOT), COPIS_DSH_RC2_RUNTIME=str(runtime))
            subprocess.run(['go','test','-overlay',p/'overlay.json','-count=1','-v','-run','^TestCopisDSHQueueWire$','./handlers'],cwd=edu,env=env,check=True)
        finally:
            subprocess.run(['pg_ctl','-D',p/'pg','-m','fast','-w','stop'],check=True)


if __name__ == '__main__':
    main()
