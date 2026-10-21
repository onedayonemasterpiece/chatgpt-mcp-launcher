#!/usr/bin/env bash
# Upgrade only the existing DevCoveer user relay from the public source checkout.
# Keeps the private MCP tunnel, Nginx proxy, tokens and persistent queue untouched.
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE="$(command -v node)"
SYSTEMCTL="$(command -v systemctl)"
[[ -n "$NODE" && -n "$SYSTEMCTL" ]] || { echo 'Missing node or systemctl' >&2; exit 1; }
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
[[ -S "${XDG_RUNTIME_DIR}/bus" ]] || { echo 'User systemd bus unavailable' >&2; exit 1; }
HOME_DIR="$(cd ~ && pwd -P)"
UNIT="${HOME_DIR}/.config/systemd/user/chatgpt-launcher.service"
SECRETS="${HOME_DIR}/.config/chatgpt-launcher/secrets.env"
STATE="${HOME_DIR}/.local/state/chatgpt-launcher/queue.json"
BACKUP_DIR="${HOME_DIR}/.config/chatgpt-launcher/backups"
[[ -f "$UNIT" && ! -L "$UNIT" && -f "$SECRETS" && ! -L "$SECRETS" ]] || { echo 'Missing managed unit or protected secrets' >&2; exit 1; }
grep -Fq 'Managed by chatgpt-launcher/tools/install-service.sh' "$UNIT" || { echo 'Unmanaged service unit; refusing to replace' >&2; exit 1; }
[[ -f "$ROOT/relay/server.mjs" && -f "$ROOT/relay/queue.mjs" ]] || { echo 'Missing public relay source' >&2; exit 1; }
[[ -r "$SECRETS" ]] || { echo 'Protected secrets unreadable' >&2; exit 1; }
"$NODE" --check "$ROOT/relay/server.mjs"
"$NODE" --check "$ROOT/relay/queue.mjs"
if [[ -f "$STATE" ]]; then
  LAUNCHER_EXISTING_QUEUE="$STATE" "$NODE" --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
const s=JSON.parse(readFileSync(process.env.LAUNCHER_EXISTING_QUEUE,'utf8'));
if(!Array.isArray(s.jobs))throw new Error('Invalid existing queue schema');
const active=s.jobs.filter(j=>j.status==='queued'||j.status==='claimed');
if(active.length)throw new Error('Refusing to interrupt '+active.length+' queued/claimed job(s)');
console.log('Preflight: no queued or claimed jobs');
JS
fi
mkdir -p -m 0700 "$BACKUP_DIR"
BACKUP="$(mktemp "${BACKUP_DIR}/relay-unit-XXXXXXXX.bak")"
cp -p -- "$UNIT" "$BACKUP"
if [[ -f "$STATE" ]]; then
  STATE_BACKUP="${BACKUP}.queue.json"
  cp -p -- "$STATE" "$STATE_BACKUP"
fi
TMP_UNIT="$(mktemp "${UNIT}.XXXXXXXX.tmp")"
rollback() {
  echo 'ERROR: public relay deployment validation failed; restoring prior service unit' >&2
  cp -p -- "$BACKUP" "$UNIT" || :
  "$SYSTEMCTL" --user daemon-reload || :
  "$SYSTEMCTL" --user restart chatgpt-launcher.service || :
  rm -f -- "$TMP_UNIT" || :
}
trap rollback ERR
awk -v root="$ROOT" -v node="$NODE" '
  /^WorkingDirectory=/ {print "WorkingDirectory=" root; wd++; next}
  /^ExecStart=/ {print "ExecStart=" node " " root "/relay/server.mjs"; es++; next}
  {print}
  END {if(wd!=1 || es!=1)exit 42}
' "$UNIT" > "$TMP_UNIT"
chmod 0600 "$TMP_UNIT"
mv -f -- "$TMP_UNIT" "$UNIT"
"$SYSTEMCTL" --user daemon-reload
"$SYSTEMCTL" --user restart chatgpt-launcher.service
ready=0
for i in $(seq 1 35); do
  if "$SYSTEMCTL" --user is-active --quiet chatgpt-launcher.service && curl --silent --fail --max-time 2 http://127.0.0.1:8177/health >/dev/null; then ready=1; break; fi
  sleep 0.4
done
[[ "$ready" == '1' ]] || { echo 'Relay health check failed' >&2; false; }
LAUNCHER_PROBE_SECRETS_FILE="$SECRETS" "$NODE" --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
const body=readFileSync(process.env.LAUNCHER_PROBE_SECRETS_FILE,'utf8');
const entry=body.split(/\r?\n/).find(x=>x.startsWith('LAUNCHER_MCP_TOKEN='));
if(!entry)throw new Error('MCP token configuration missing');
const token=entry.slice('LAUNCHER_MCP_TOKEN='.length).replace(/^['\"]|['\"]$/g,'');
if(token.length<24)throw new Error('Invalid existing MCP token');
const endpoint='http://127.0.0.1:8177/mcp';
const rpc=(method,id)=>({jsonrpc:'2.0',id,method,params:{}});
async function check(method,id,authorized=true){
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(rpc(method,id)),signal:AbortSignal.timeout(4000)});
  return {status:response.status,body:await response.json()};
}
const denied=await check('tools/list',10,false);
if(denied.status!==401)throw new Error('Unauthorized MCP endpoint accessible');
const listed=await check('tools/list',11,true);
const names=listed.body?.result?.tools?.map(x=>x.name)||[];
for(const name of ['chatgpt_start','chatgpt_continue','chatgpt_open','chatgpt_read_reply','chatgpt_list_chats','chatgpt_device_status','chatgpt_task_status'])
  if(!names.includes(name))throw new Error('Missing live MCP tool '+name);
console.log('PASS: protected MCP tool discovery; '+names.length+' tools. No model output read.');
JS
trap - ERR
echo 'PASS: public relay installed with preserved private token, persisted queue, rollback backup and loopback binding'
echo "Relay source: ${ROOT}/relay/server.mjs"
