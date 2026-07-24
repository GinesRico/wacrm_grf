#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DB_CONTAINER="${SOURCE_DB_CONTAINER:-whaticket_db_prod}"
SOURCE_DB_USER="${SOURCE_DB_USER:-avera}"
SOURCE_DB_NAME="${SOURCE_DB_NAME:-whaticket_prod}"
SOURCE_DUMP_IN_CONTAINER="${SOURCE_DUMP_IN_CONTAINER:-/tmp/whaticket_backup.dump}"

DUMP_HOST_PATH="${DUMP_HOST_PATH:-/home/docker/whaticket/backup/whaticket_backup.dump}"
SOURCE_PUBLIC_DIR="${SOURCE_PUBLIC_DIR:-/home/docker/whaticket/prod/data/backend/public}"
SNAPSHOT_PUBLIC_DIR="${SNAPSHOT_PUBLIC_DIR:-/home/docker/whaticket/backup/export_snapshot/public}"

BRIDGE_CONTAINER="${BRIDGE_CONTAINER:-ppt6w0ho4yywicm0yon1tt4d}"
BRIDGE_DB_NAME="${BRIDGE_DB_NAME:-whaticket_import_tmp}"
BRIDGE_DB_USER="${BRIDGE_DB_USER:-postgres}"
BRIDGE_DB_HOST="${BRIDGE_DB_HOST:-ppt6w0ho4yywicm0yon1tt4d}"
BRIDGE_DB_PORT="${BRIDGE_DB_PORT:-5432}"
BRIDGE_DUMP_IN_CONTAINER="${BRIDGE_DUMP_IN_CONTAINER:-/tmp/whaticket_backup.dump}"

WACRM_APP_CONTAINER="${WACRM_APP_CONTAINER:-}"
WACRM_WORKDIR="${WACRM_WORKDIR:-/app}"
EXPORT_DIR="${EXPORT_DIR:-/app/storage/whaticket-export}"
ACCOUNT_ID="${ACCOUNT_ID:-4441e304-18b7-487f-98c3-57a101728091}"
MEDIA_MODE="${MEDIA_MODE:-alarik}"

WHATICKET_DB_PASS="${WHATICKET_DB_PASS:-}"

confirm() {
  local label="$1"
  local default="${2:-yes}"
  local suffix="Y/n"
  [[ "$default" == "no" ]] && suffix="y/N"

  local answer
  read -r -p "${label} (${suffix}): " answer
  answer="${answer,,}"
  if [[ -z "$answer" ]]; then
    [[ "$default" == "yes" ]]
    return
  fi
  [[ "$answer" == "y" || "$answer" == "yes" || "$answer" == "s" || "$answer" == "si" ]]
}

run() {
  printf '\n$ %s\n\n' "$*"
  "$@"
}

run_shell() {
  printf '\n$ %s\n\n' "$*"
  bash -lc "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $1" >&2
    exit 1
  fi
}

detect_wacrm_container() {
  if [[ -n "$WACRM_APP_CONTAINER" ]]; then
    return
  fi

  local matches
  matches="$(docker ps --format '{{.Names}}' | grep -Ei 'wacrm|arvera|crm' || true)"
  local count
  count="$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')"

  if [[ "$count" == "1" ]]; then
    WACRM_APP_CONTAINER="$(printf '%s\n' "$matches" | sed '/^$/d' | head -n 1)"
    return
  fi

  echo "No he podido detectar de forma segura el contenedor WACRM."
  echo "Contenedores actuales:"
  docker ps --format '  {{.Names}}\t{{.Image}}\t{{.Status}}'
  echo
  read -r -p "Nombre del contenedor WACRM app: " WACRM_APP_CONTAINER
  if [[ -z "$WACRM_APP_CONTAINER" ]]; then
    echo "WACRM_APP_CONTAINER es obligatorio." >&2
    exit 1
  fi
}

wacrm_exec() {
  run docker exec \
    -w "$WACRM_WORKDIR" \
    -e WHATICKET_DB_HOST="$BRIDGE_DB_HOST" \
    -e WHATICKET_DB_PORT="$BRIDGE_DB_PORT" \
    -e WHATICKET_DB_NAME="$BRIDGE_DB_NAME" \
    -e WHATICKET_DB_USER="$BRIDGE_DB_USER" \
    -e WHATICKET_DB_PASS="$WHATICKET_DB_PASS" \
    "$WACRM_APP_CONTAINER" \
    "$@"
}

main() {
  require_command docker
  require_command rsync

  if [[ -z "$WHATICKET_DB_PASS" ]]; then
    read -r -s -p "Password BD puente (${BRIDGE_DB_USER}@${BRIDGE_DB_NAME}): " WHATICKET_DB_PASS
    echo
  fi

  detect_wacrm_container

  echo
  echo "Migracion WhaTicket -> WACRM desde host Docker"
  echo "WhaTicket DB: ${SOURCE_DB_CONTAINER}/${SOURCE_DB_NAME}"
  echo "Base puente: ${BRIDGE_CONTAINER}/${BRIDGE_DB_NAME}"
  echo "WACRM app: ${WACRM_APP_CONTAINER}:${WACRM_WORKDIR}"
  echo "Snapshot adjuntos: ${SNAPSHOT_PUBLIC_DIR}"
  echo "Export persistente: ${EXPORT_DIR}"
  echo "Cuenta destino: ${ACCOUNT_ID}"
  echo

  confirm "Continuar con esta configuracion?" "yes" || exit 0

  if confirm "1. Crear dump custom desde WhaTicket produccion?" "yes"; then
    run docker exec -t "$SOURCE_DB_CONTAINER" pg_dump -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -Fc -f "$SOURCE_DUMP_IN_CONTAINER"
  fi

  if confirm "2. Copiar dump de produccion al host?" "yes"; then
    run mkdir -p "$(dirname "$DUMP_HOST_PATH")"
    run docker cp "${SOURCE_DB_CONTAINER}:${SOURCE_DUMP_IN_CONTAINER}" "$DUMP_HOST_PATH"
  fi

  if confirm "3. Resync de adjuntos public al snapshot?" "yes"; then
    run mkdir -p "$SNAPSHOT_PUBLIC_DIR"
    run rsync -a --ignore-missing-args "${SOURCE_PUBLIC_DIR%/}/" "${SNAPSHOT_PUBLIC_DIR%/}/"
  fi

  if confirm "4. Copiar dump al contenedor puente?" "yes"; then
    run docker cp "$DUMP_HOST_PATH" "${BRIDGE_CONTAINER}:${BRIDGE_DUMP_IN_CONTAINER}"
  fi

  if confirm "5. Recrear base puente? Esto borra su contenido actual" "no"; then
    run docker exec -t "$BRIDGE_CONTAINER" dropdb --if-exists -U "$BRIDGE_DB_USER" "$BRIDGE_DB_NAME"
    run docker exec -t "$BRIDGE_CONTAINER" createdb -U "$BRIDGE_DB_USER" "$BRIDGE_DB_NAME"
  elif confirm "5b. Crear base puente si no existe?" "no"; then
    run docker exec -t "$BRIDGE_CONTAINER" createdb -U "$BRIDGE_DB_USER" "$BRIDGE_DB_NAME"
  fi

  if confirm "6. Restaurar dump en base puente?" "yes"; then
    run docker exec -t "$BRIDGE_CONTAINER" pg_restore --no-owner --role="$BRIDGE_DB_USER" -U "$BRIDGE_DB_USER" -d "$BRIDGE_DB_NAME" "$BRIDGE_DUMP_IN_CONTAINER"
  fi

  if confirm "7. Verificar tablas y conteos de base puente?" "yes"; then
    wacrm_exec pnpm verify:whaticket-bridge
  fi

  if confirm "8. Exportar JSON + media dentro de WACRM?" "yes"; then
    run docker exec -w "$WACRM_WORKDIR" "$WACRM_APP_CONTAINER" mkdir -p "$EXPORT_DIR"
    run docker exec "$WACRM_APP_CONTAINER" mkdir -p /tmp/whaticket-public
    run docker cp "${SNAPSHOT_PUBLIC_DIR%/}/." "${WACRM_APP_CONTAINER}:/tmp/whaticket-public"
    wacrm_exec pnpm export:whaticket-db --out="$EXPORT_DIR" --public=/tmp/whaticket-public
  fi

  if confirm "9. Aplicar migraciones WACRM?" "yes"; then
    run docker exec -w "$WACRM_WORKDIR" "$WACRM_APP_CONTAINER" pnpm db:migrate
  fi

  if confirm "10. Ejecutar import REAL en WACRM?" "no"; then
    run docker exec -w "$WACRM_WORKDIR" "$WACRM_APP_CONTAINER" pnpm import:whaticket "$EXPORT_DIR" --account="$ACCOUNT_ID" --media="$MEDIA_MODE"
  fi

  echo
  echo "Proceso terminado."
}

main "$@"
