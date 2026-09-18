#!/bin/bash
# Owner-run only: password is read from the TTY, never a command argument.
set -eu
set +x
: "${VAULT_URL:?Set VAULT_URL to your Vaultwarden HTTPS address}"
export HOME=/bw BITWARDENCLI_APPDATA_DIR=/bw NODE_EXTRA_CA_CERTS=/tls/ca.crt
umask 077
ulimit -c 0
if [ ! -t 0 ]; then
  echo 'Run enrollment in your own interactive terminal.' >&2
  exit 1
fi
if [ -e /run/secrets/session.txt ]; then
  echo 'A session already exists; refusing to replace it during initial enrollment.' >&2
  exit 1
fi
session_tmp=$(mktemp /run/secrets/.enroll.XXXXXX)
trap 'unset BW_ENROLL_PASSWORD BW_SESSION; rm -f "$session_tmp"' EXIT
status=$(bw status --nointeraction | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).status))')
case "$status" in
  unauthenticated)
    bw config server "$VAULT_URL" >/dev/null
    read -r -p 'Dedicated importer email: ' importer_email
    ;;
  locked)
    # A logged-in CLI must already point at the requested vault; never retarget it.
    bw status --nointeraction | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{if(JSON.parse(s).serverUrl?.replace(/\/$/,"")!==process.env.VAULT_URL.replace(/\/$/,""))process.exit(1)})'
    ;;
  *) echo 'Unexpected CLI state; stop and check enrollment.' >&2; exit 1 ;;
esac
read -r -s -p 'Importer master password (hidden): ' BW_ENROLL_PASSWORD
printf '\n' >&2
export BW_ENROLL_PASSWORD
if [ "$status" = unauthenticated ]; then
  bw login "$importer_email" --passwordenv BW_ENROLL_PASSWORD --raw --nointeraction >"$session_tmp"
else
  bw unlock --passwordenv BW_ENROLL_PASSWORD --raw --nointeraction >"$session_tmp"
fi
unset BW_ENROLL_PASSWORD
# Reject diagnostics or interactive prompts accidentally captured as a session.
node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8").trim();if(!/^[A-Za-z0-9+/]{86}==$/.test(s))process.exit(1);fs.writeFileSync(process.argv[1],s,{mode:0o600})' "$session_tmp"
BW_SESSION=$(cat "$session_tmp")
export BW_SESSION
bw sync --nointeraction >/dev/null
unset BW_SESSION
chmod 600 "$session_tmp"
mv "$session_tmp" /run/secrets/session.txt
echo 'Importer session saved privately. Enrollment login complete.'
