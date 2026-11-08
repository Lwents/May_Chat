#!/bin/sh
set -eu
umask 077
# Values are validated by scripts/configure.mjs; never print the generated file.
cat > /tmp/turnserver.conf <<EOF
listening-port=3478
external-ip=${PUBLIC_IP}
realm=${DOMAIN}
server-name=${DOMAIN}
use-auth-secret
static-auth-secret=${TURN_SECRET}
fingerprint
no-cli
no-tls
no-dtls
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
min-port=49160
max-port=49399
relay-threads=2
no-rfc5780
total-quota=160
user-quota=32
max-bps=1000000
bps-capacity=10000000
stale-nonce=600
no-software-attribute
log-file=stdout
simple-log
pidfile=/tmp/turnserver.pid
EOF
# Host-network VPSes should advertise only their reachable relay interface.
if [ -n "${RELAY_IP:-}" ]; then printf 'relay-ip=%s\n' "$RELAY_IP" >> /tmp/turnserver.conf; fi
exec turnserver -c /tmp/turnserver.conf
