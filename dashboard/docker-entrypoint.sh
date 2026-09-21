#!/bin/sh
set -eu

# Fail loudly rather than serving a dashboard that 401s on every call.
: "${INTERNAL_TOKEN:?INTERNAL_TOKEN is required}"
: "${ENGINE_URL:=http://engine:3000}"

if [ ! -s /etc/nginx/htpasswd ]; then
  echo "no /etc/nginx/htpasswd mounted; see dashboard/htpasswd.example" >&2
  exit 1
fi

export INTERNAL_TOKEN ENGINE_URL
envsubst '${INTERNAL_TOKEN} ${ENGINE_URL}' \
  < /etc/nginx/templates/nginx.conf.template \
  > /etc/nginx/conf.d/default.conf

exec nginx -g 'daemon off;'
