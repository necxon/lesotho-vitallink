#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# capture_stack.sh — read-only snapshot of how an OpenSRP stack host is set up.
#
# Run on the host (needs sudo for docker):
#   sudo bash capture_stack.sh
#
# Writes ~/stack-capture-<host>-<date>.tar.gz containing, per container:
#   image, ports, mounts, networks, command, compose project dir, and the
#   environment with every password/secret/key/token value replaced by ***
# plus copies of small mounted config files (secrets masked the same way),
# the gateway's resources/ query lists and the fhir-web config template.
#
# Never copies: .env files, data volumes, database contents, keys or certs.
# Makes no changes to containers.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

HOST=$(hostname)
OUT_NAME="stack-capture-${HOST}-$(date +%Y%m%d-%H%M)"
HOME_DIR=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
WORK=$(mktemp -d)
OUT="$WORK/$OUT_NAME"
mkdir -p "$OUT/files" "$OUT/image-files"

# \b keeps KEY from matching inside KEYCLOAK.
SENSITIVE='PASS|SECRET|_KEY\b|\bKEY_|TOKEN|CREDENTIAL|PRIVATE'
# Plain URLs (TOKEN_ISSUER, *_TOKEN_URL) stay readable unless they carry a user:pass@.
mask_env()  { sed -E "/^[^=]*=https?:\/\/[^@]*$/b; s/^([^=]*(${SENSITIVE})[^=]*)=.*/\1=***/I"; }
mask_file() { sed -E "s/((${SENSITIVE})[A-Za-z_]*[\"']?[[:space:]]*[:=][[:space:]]*).*/\1***/I"; }

{
  echo "host      $HOST"
  echo "addresses $(hostname -I 2>/dev/null)"
  echo "captured  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "docker    $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  echo "compose   $(docker compose version --short 2>/dev/null)"
} > "$OUT/host.txt"

docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' > "$OUT/containers.tsv"
docker network ls --format '{{.Name}}\t{{.Driver}}' > "$OUT/networks.tsv"
docker volume ls --format '{{.Name}}' > "$OUT/volumes.txt"

for c in $(docker ps -a --format '{{.Names}}'); do
  d="$OUT/containers/$c"; mkdir -p "$d"
  docker inspect -f '{{.Config.Image}}' "$c"                                > "$d/image.txt"
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | mask_env > "$d/env.txt"
  docker inspect -f '{{json .Config.Cmd}} {{json .Config.Entrypoint}} workdir={{.Config.WorkingDir}}' "$c" > "$d/cmd.txt"
  docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{$p}} -> {{range $b}}{{.HostIp}}:{{.HostPort}} {{end}}{{println}}{{end}}' "$c" > "$d/ports.txt"
  docker inspect -f '{{range $n, $v := .NetworkSettings.Networks}}{{println $n}}{{end}}' "$c" > "$d/networks.txt"
  docker inspect -f '{{range .Config.Healthcheck.Test}}{{.}} {{end}}' "$c" > "$d/healthcheck.txt" 2>/dev/null
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.project.working_dir"}} {{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c" > "$d/compose.txt"
  docker inspect -f '{{range .Mounts}}{{.Type}}	{{.Source}}	{{.Destination}}	{{.RW}}{{println}}{{end}}' "$c" > "$d/mounts.tsv"

  # small bind-mounted config files, secrets masked; never .env, keys or certs
  while IFS=$'\t' read -r type src dst rw; do
    [[ "$type" == "bind" && -f "$src" ]] || continue
    case "$src" in *.env|*/.env|*.pem|*.key|*.p12|*.jks|*.crt) continue ;; esac
    [[ $(stat -c %s "$src") -lt 1048576 ]] || continue
    mkdir -p "$d/mounted$(dirname "$dst")"
    mask_file < "$src" > "$d/mounted$dst"
  done < "$d/mounts.tsv"
done

# compose files of every project found, secrets masked
for dir in $(docker ps -a --format '{{.Label "com.docker.compose.project.working_dir"}}' | sort -u); do
  [[ -d "$dir" ]] || continue
  tgt="$OUT/files$dir"; mkdir -p "$tgt"
  for f in "$dir"/*compose*.y*ml "$dir"/Dockerfile "$dir"/*.tpl "$dir"/config/*.y*ml "$dir"/application.y*ml "$dir"/README.md "$dir"/.env.example; do
    [[ -f "$f" ]] && mask_file < "$f" > "$tgt/$(basename "$f")"
  done
  [[ -d "$dir/resources" ]] && cp -r "$dir/resources" "$tgt/"
  # .env: variable NAMES only, so we know what must be set
  [[ -f "$dir/.env" ]] && sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$dir/.env" > "$tgt/env-names.txt"
done

# files baked into images that the stack depends on
for c in $(docker ps --format '{{.Names}}'); do
  img=$(docker inspect -f '{{.Config.Image}}' "$c")
  wd=$(docker inspect -f '{{.Config.WorkingDir}}' "$c")
  case "$img" in
    *fhir-gateway*)
      for p in "$wd/resources" /app/resources /resources; do
        docker cp "$c:$p" "$OUT/image-files/$c-resources" >/dev/null 2>&1 && break
      done ;;
    opensrp/web*)
      docker cp "$c:/etc/confd/templates" "$OUT/image-files/$c-confd-templates" >/dev/null 2>&1
      docker cp "$c:/etc/confd/conf.d"   "$OUT/image-files/$c-confd-conf.d"   >/dev/null 2>&1 ;;
  esac
done

# a secrets check before anything leaves the host
if grep -rIlE '(-----BEGIN|eyJhbGciOi)' "$OUT" >/dev/null 2>&1; then
  echo "WARNING: key or token material found - check these before sharing:" >&2
  grep -rIlE '(-----BEGIN|eyJhbGciOi)' "$OUT" >&2
fi

column -t -s $'\t' "$OUT/containers.tsv" 2>/dev/null || cat "$OUT/containers.tsv"
echo "compose projects: $(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sort -u | grep -c .)"

tar -czf "$HOME_DIR/$OUT_NAME.tar.gz" -C "$WORK" "$OUT_NAME"
chown "${SUDO_USER:-root}": "$HOME_DIR/$OUT_NAME.tar.gz" 2>/dev/null
rm -rf "$WORK"
echo "wrote $HOME_DIR/$OUT_NAME.tar.gz"
