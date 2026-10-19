#!/usr/bin/env bash
# Make the VHW servers start everything again after a power cut or reboot.
#
# Run on the jump host (203.0.113.67) as deploy-user:
#   bash enable_autostart.sh            # apply on every server
#   bash enable_autostart.sh --check    # only show the current state
#
# Per Docker server: enable the docker service at boot and set every RUNNING
# container to "restart: unless-stopped". Containers that are stopped on purpose
# (one-off init containers such as superset_init) are left alone.
# On the nginx host: enable nginx and show the DHIS2 services.
# Each server asks for your sudo password; nothing runs there without it.

set -u
MODE=apply
[ "${1:-}" = "--check" ] && MODE=check
USER_NAME=${VHW_USER:-deploy-user}

# host  ssh-port  role
SERVERS="
192.0.2.146 22   docker   production
192.0.2.114 22   docker   test
192.0.2.236 22 docker   superset
192.0.2.61  22   nginx    proxy+DHIS2
"

DOCKER_SCRIPT='
set -u
if [ "$MODE" = apply ]; then
  systemctl enable docker containerd >/dev/null 2>&1 && echo "docker service: enabled at boot"
  n=$(docker ps -q | wc -l)
  docker ps --format "{{.Names}}" | xargs -r docker update --restart unless-stopped >/dev/null
  echo "restart policy set on $n running containers"
fi
echo "docker service at boot: $(systemctl is-enabled docker 2>/dev/null)"
docker ps -a --format "{{.Names}}" | xargs -r docker inspect -f "  {{.HostConfig.RestartPolicy.Name}}  {{.State.Status}}  {{.Name}}" | sort
'

NGINX_SCRIPT='
set -u
if [ "$MODE" = apply ]; then
  systemctl enable nginx >/dev/null 2>&1 && echo "nginx: enabled at boot"
fi
for u in nginx tomcat9 tomcat postgresql docker; do
  s=$(systemctl is-enabled "$u" 2>/dev/null) && echo "  $u: $s"
done
'

echo "Mode: $MODE   (user: $USER_NAME)"
echo "$SERVERS" | while read -r host port kind role; do
  [ -z "$host" ] && continue
  echo
  echo "=== $role  $host (ssh port $port) ==="
  if [ "$kind" = docker ]; then body=$DOCKER_SCRIPT; else body=$NGINX_SCRIPT; fi
  remote="MODE=$MODE; $body"
  # -t so sudo can ask for the password; </dev/tty keeps the loop's input intact
  ssh -t -p "$port" -o ConnectTimeout=10 "$USER_NAME@$host" \
      "sudo bash -c $(printf '%q' "$remote")" </dev/tty \
    || echo "!! $host: could not log in or sudo was refused - do this server by hand"
done
echo
echo "Done. After a real reboot, check logins on production after about 5 minutes:"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://vhw.gov.ls/fhir/metadata   (expect 401 or 200, not 500)"
