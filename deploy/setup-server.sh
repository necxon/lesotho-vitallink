#!/usr/bin/env bash
# =============================================================================
# setup-server.sh — Reproduce the host-level config for the Lesotho prod box.
# Run on a fresh Ubuntu server AFTER the Docker stacks are up (make start).
# Idempotent-ish; review each section before running. Run as a sudo-capable user.
#
#   DOMAIN=lesotho-bkm.xyz EMAIL=neelslotter@gmail.com bash deploy/setup-server.sh
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-lesotho-bkm.xyz}"
EMAIL="${EMAIL:-neelslotter@gmail.com}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== 1. Packages =="
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx fail2ban apache2-utils ufw

echo "== 2. Firewall =="
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo "== 3. nginx site configs =="
sudo cp "$REPO/deploy/nginx/bkm.conf"        /etc/nginx/sites-available/bkm
sudo cp "$REPO/deploy/nginx/subdomains.conf" /etc/nginx/sites-available/subdomains
sudo ln -sf /etc/nginx/sites-available/bkm        /etc/nginx/sites-enabled/bkm
sudo ln -sf /etc/nginx/sites-available/subdomains /etc/nginx/sites-enabled/subdomains
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "== 4. Basic-auth for mailhog + prometheus =="
if [ ! -f /etc/nginx/.htpasswd ]; then
  echo "Creating /etc/nginx/.htpasswd (user: admin) — you'll be prompted for a password:"
  sudo htpasswd -c /etc/nginx/.htpasswd admin
fi

echo "== 5. Let's Encrypt certs (main + all subdomains) =="
sudo certbot --nginx --non-interactive --agree-tos -m "$EMAIL" --redirect \
  -d "$DOMAIN" \
  -d "opensrp.$DOMAIN" -d "openhim.$DOMAIN" -d "fhir.$DOMAIN" \
  -d "dhis2.$DOMAIN" -d "lmis.$DOMAIN" -d "grafana.$DOMAIN" \
  -d "prometheus.$DOMAIN" -d "mailhog.$DOMAIN" -d "sync.$DOMAIN"

echo "== 6. fail2ban =="
sudo cp "$REPO/deploy/fail2ban/jail.local" /etc/fail2ban/jail.local
sudo systemctl enable fail2ban
sudo systemctl restart fail2ban

echo "== 7. Start services on boot =="
sudo systemctl enable docker.service containerd.service nginx

echo "== 8. Restart policy on OpenLMIS containers that default to 'no' =="
for c in openlmis-ref-distro-nginx-1 openlmis-ref-distro-dhis2-integration-1 \
         openlmis-ref-distro-hapifhir-1 openlmis-ref-distro-buq-1 \
         openlmis-ref-distro-diagnostics-1 openlmis-ref-distro-ftp-1; do
  docker update --restart unless-stopped "$c" 2>/dev/null && echo "  $c → unless-stopped" || true
done

echo "== 9. OpenLMIS nginx stubs + rate-limit (inject into running container + consul-template source) =="
python3 "$REPO/scripts/gen_openlmis_nginx.py" > /tmp/openlmis-default.conf
docker cp /tmp/openlmis-default.conf openlmis-ref-distro-nginx-1:/etc/nginx/conf.d/default.conf
docker cp /tmp/openlmis-default.conf openlmis-ref-distro-nginx-1:/etc/consul-template/openlmis.conf
docker exec openlmis-ref-distro-nginx-1 nginx -t && docker exec openlmis-ref-distro-nginx-1 nginx -s reload

echo "== 10. OpenHIM root password (mediator + console use 'password') =="
SALT=$(docker exec openhim-mongo mongo --quiet openhim \
  --eval "print(db.passports.findOne({protocol:'token',email:'root@openhim.org'}).passwordSalt)")
HASH=$(python3 -c "import hashlib; print(hashlib.sha512(('${SALT}'+'password').encode()).hexdigest())")
docker exec openhim-mongo mongo --quiet openhim --eval \
  "db.passports.updateOne({protocol:'token',email:'root@openhim.org'},{\$set:{passwordHash:'${HASH}'}})"
BCRYPT=$(docker exec openhim-core node -e "const b=require('bcryptjs');b.hash('password',10).then(h=>process.stdout.write(h))" 2>/dev/null)
docker exec openhim-mongo mongo --quiet openhim --eval \
  "db.passports.updateOne({protocol:'local',email:'root@openhim.org'},{\$set:{password:'${BCRYPT}'}})"
docker compose -f "$REPO/docker-compose.yml" restart bkm-mediator || docker restart bkm-mediator

echo ""
echo "== DONE =="
echo "Verify:"
echo "  https://$DOMAIN                 (bkm-web)"
echo "  https://$DOMAIN/auth            (keycloak)"
echo "  https://dhis2.$DOMAIN  etc.     (subdomains)"
echo "  sudo fail2ban-client status"
echo ""
echo "NOTE: Keycloak user/admin + Grafana passwords are applied by 'make seed'"
echo "      (realm JSON) and the one-off resets documented in deploy/README.md."
