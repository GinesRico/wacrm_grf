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

El script pregunta los valores necesarios y permite saltar fases ya ejecutadas.
Por defecto carga el perfil ARVERA conocido y solo pregunta si quieres editarlo.

Valores habituales:

```text
Contenedor PostgreSQL puente: ppt6w0ho4yywicm0yon1tt4d
Base puente: whaticket_import_tmp
Ruta snapshot public: /home/docker/whaticket/backup/export_snapshot/public
Paquete exportado: /tmp/whaticket-export
Cuenta WACRM destino: 4441e304-18b7-487f-98c3-57a101728091
```

## Fases

1. Crear `pg_dump -Fc` desde PostgreSQL de WhaTicket produccion.
2. Copiar el dump desde el contenedor de produccion al host.
3. Hacer `rsync` de `backend/public` a un snapshot de adjuntos.
4. Copiar el dump al contenedor PostgreSQL puente.
5. Crear o recrear la base puente.
6. Restaurar con `pg_restore --no-owner --role=postgres`.
7. Verificar tablas y conteos principales.
8. Exportar desde la base puente a JSON + media con `pnpm export:whaticket-db`.
9. Ejecutar migraciones de WACRM.
10. Ejecutar import real con media en Alarik.

El dry-run sigue disponible como comando manual cuando quieras validar sin
escribir:

```bash
pnpm import:whaticket /tmp/whaticket-export \
  --account=4441e304-18b7-487f-98c3-57a101728091 \
  --media=skip \
  --dry-run
```

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
fases 1-7 y continuar desde la exportacion a `/tmp/whaticket-export`.

## Seguridad

- No se importan passwords, tokens, sesiones ni claves WhatsApp desde WhaTicket.
- Los usuarios nuevos creados por el importador reciben la password temporal
  configurada en `scripts/import-whaticket.mjs`.
- Las lineas WhatsApp se crean desconectadas y deben reconectarse en WACRM.
- Los eventos `TicketStatusEvents` se importan como mensajes `system`.
