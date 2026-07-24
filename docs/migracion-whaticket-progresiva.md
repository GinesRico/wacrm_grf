# Migracion progresiva WhaTicket a WACRM

Este flujo evita ejecutar procesos pesados contra la app WhaTicket en produccion.
El proceso crea primero una base puente PostgreSQL y un snapshot de adjuntos; despues
WACRM transforma esos datos a su propio modelo.

## Comando interactivo

Desde un entorno que tenga acceso a Docker, a la ruta de adjuntos de WhaTicket y
al codigo de WACRM:

```bash
pnpm migrate:whaticket
```

## Script desde el host Docker

Para ejecutar el flujo completo fuera de las consolas de Coolify, entra por SSH
al servidor Docker y ejecuta:

```bash
bash scripts/migrate-whaticket-host.sh
```

Este script usa los valores ARVERA por defecto, hace `docker exec` contra los
contenores de WhaTicket/base puente y despues lanza `pnpm` dentro del contenedor
WACRM. Si no detecta el contenedor WACRM, lo pregunta una sola vez. Tambien
puedes pasarlo asi:

```bash
WACRM_APP_CONTAINER=nombre_contenedor_wacrm bash scripts/migrate-whaticket-host.sh
```

El script pregunta los valores necesarios y permite saltar fases ya ejecutadas.
Por defecto carga el perfil ARVERA conocido y solo pregunta si quieres editarlo.

Si lo ejecutas desde la consola de la app WACRM en Coolify, normalmente no hay
binario `docker` ni acceso directo a las rutas del host. En ese caso el script
salta automaticamente las fases 1-6, pensadas para el host Docker, y puede
continuar con la verificacion/export/import siempre que la base puente ya exista
y sea accesible por red.

Para que el paquete JSON + media sobreviva a redeploys, configura en Coolify un
storage persistente montado en `/app/storage`. Evita usar `/tmp`: el contenedor
puede limpiarlo o recrearlo.

Valores habituales:

```text
Contenedor PostgreSQL puente: ppt6w0ho4yywicm0yon1tt4d
Base puente: whaticket_import_tmp
Ruta snapshot public: /home/docker/whaticket/backup/export_snapshot/public
Paquete exportado: /app/storage/whaticket-export
Cuenta WACRM destino: 4441e304-18b7-487f-98c3-57a101728091
```

## Fases

1. Crear `pg_dump -Fc` desde PostgreSQL de WhaTicket produccion.
2. Copiar el dump desde el contenedor de produccion al host.
3. Hacer `rsync` de `backend/public` a un snapshot de adjuntos.
4. Copiar el dump al contenedor PostgreSQL puente.
5. Crear o recrear la base puente.
6. Restaurar con `pg_restore --no-owner --role=postgres`.
7. Verificar tablas y conteos principales conectando directamente a PostgreSQL.
8. Exportar desde la base puente a JSON + media con `pnpm export:whaticket-db`.
9. Ejecutar migraciones de WACRM.
10. Ejecutar import real con media en Alarik.

El dry-run sigue disponible como comando manual cuando quieras validar sin
escribir:

```bash
pnpm import:whaticket /app/storage/whaticket-export \
  --account=4441e304-18b7-487f-98c3-57a101728091 \
  --media=skip \
  --dry-run
```

Por defecto el importador trata `ticket_status_events` como mensajes de sistema
con deduplicacion. Si WhaTicket ya trae el aviso dentro de `messages.json`, por
ejemplo `_Chat aceptado por ..._`, ese mensaje se normaliza como `content_type =
system` y el evento equivalente no crea otra fila. Si el aviso solo existe en
`ticket_status_events.json`, se crea como mensaje `system`.

Puedes forzar todos los eventos, incluso si se duplican, con:

```bash
pnpm import:whaticket /app/storage/whaticket-export \
  --account=4441e304-18b7-487f-98c3-57a101728091 \
  --media=alarik \
  --status-events=system
```

O saltar por completo la tabla de eventos con:

```bash
pnpm import:whaticket /app/storage/whaticket-export \
  --account=4441e304-18b7-487f-98c3-57a101728091 \
  --media=alarik \
  --status-events=skip
```

Si ya habias importado y necesitas corregir adjuntos o convertir esos mensajes
informativos ya mapeados, reejecuta con el mismo paquete/import-key y:

```bash
pnpm import:whaticket /app/storage/whaticket-export \
  --account=4441e304-18b7-487f-98c3-57a101728091 \
  --media=alarik \
  --repair-media
```

Las fotos de perfil de contactos se tratan igual que adjuntos importables:
si `profilePicUrl` apunta a un fichero/cache existente en el snapshot `public`,
se copia al paquete y se sube/copia durante el import. Si no existe el fichero,
WACRM deja `contacts.avatar_url` vacio para no mantener enlaces rotos.

## Incrementalidad

Las fases de backup/restauracion/exportacion son de refresco completo:

- `pg_dump` genera un dump completo.
- `pg_restore` recarga la base puente si decides recrearla.
- `pnpm export:whaticket-db` vuelve a generar los JSON completos.
- `rsync` de adjuntos solo copia diferencias a nivel de fichero.

El import a WACRM si es idempotente/incremental por `whaticket_legacy_map`:

- cada `legacyId` ya importado se salta;
- si aparecen tickets, mensajes o eventos nuevos en WhaTicket, al reexportar e
  importar solo se crean los que falten;
- los adjuntos de mensajes ya mapeados no se vuelven a subir.

Para una sincronizacion posterior, normalmente saltas las fases que no cambian,
refrescas la base puente/export y vuelves a ejecutar el import real.

## Reanudacion

Si una fase ya esta hecha, responde `n` cuando el script pregunte si quieres
ejecutarla. Por ejemplo, si la base puente ya esta restaurada, puedes saltar las
fases 1-7 y continuar desde la exportacion a `/app/storage/whaticket-export`.

## Seguridad

- No se importan passwords, tokens, sesiones ni claves WhatsApp desde WhaTicket.
- Los usuarios nuevos creados por el importador reciben la password temporal
  configurada en `scripts/import-whaticket.mjs`.
- Las lineas WhatsApp se crean desconectadas y deben reconectarse en WACRM.
- Los eventos `TicketStatusEvents` se importan como mensajes `system`.
