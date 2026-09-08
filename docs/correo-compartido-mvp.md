# Plataforma propia de correo compartido empresarial

## Decisión: no adaptar Roundcube

Roundcube es un webmail IMAP clásico. Sirve bien cuando cada usuario trabaja directamente contra su buzón remoto, pero encaja peor con este producto porque el centro no es "leer IMAP", sino construir una capa interna de trabajo: usuarios sin buzón propio, grupos, permisos por buzón/carpeta, auditoría real del operador, reglas importadas, estado interno y trazabilidad.

La v1 debe tratar IMAP como fuente de importación en modo copia. Los correos originales de serviciodecorreo.es no se borran, no se mueven y no se marcan como leídos desde el origen. La operación diaria ocurre sobre nuestra base de datos.

## Principios de arquitectura

- Fuente externa: serviciodecorreo.es por IMAP/SMTP.
- Importación: IMAP en solo lectura, cursor por UID/UIDVALIDITY y deduplicación por identidad IMAP.
- Trabajo interno: mensajes, carpetas, lectura, clasificación y movimientos viven en PostgreSQL.
- Identidad interna: login propio, usuarios con o sin buzón personal.
- Autorización: permisos agregados por grupos/departamentos, con acceso automático del propietario a su buzón personal.
- Buzones compartidos: ventas@, compras@, info@, administracion@ y otros se modelan como buzones compartidos.
- Envío: SMTP del buzón externo, usando el remitente compartido autorizado.
- Auditoría: cada acción relevante guarda el usuario real, buzón, carpeta, mensaje y metadatos.

## Modelo funcional v1

El MVP queda dividido en estos bloques:

1. Administración de buzones IMAP/SMTP externos.
2. Buzones internos personales y compartidos.
3. Carpetas internas por buzón.
4. Permisos por grupo sobre buzón completo o carpeta concreta.
5. Importador IMAP en modo copia.
6. Motor de reglas para clasificar entrantes.
7. Webmail operativo responsive.
8. Panel admin básico.
9. Auditoría consultable.

## Estado actual en este repositorio

Ya existe una base implementada sobre Next.js, Drizzle, PostgreSQL, ImapFlow, Mailparser y Nodemailer:

- `email_accounts`: credenciales IMAP/SMTP cifradas, estado, cursor y origen.
- `email_mailboxes`: buzones personales y compartidos.
- `email_folders`: carpetas internas.
- `email_permissions`: permisos por departamento/grupo.
- `email_messages`: mensajes copiados desde IMAP.
- `email_attachments`: adjuntos almacenados internamente.
- `email_rules`: reglas de clasificación.
- `email_audit_events`: trazabilidad de acciones.

El importador usa `mailboxOpen(..., { readOnly: true })`, por lo que no modifica el origen durante la copia. La deduplicación se hace por cuenta externa, carpeta IMAP, UIDVALIDITY y UID.

## Roadmap incremental

### Fase 1: MVP operativo

- Conectar ventas@, compras@, info@ y administracion@ desde el panel admin.
- Importar INBOX desde serviciodecorreo.es en modo copia.
- Crear carpetas internas compartidas.
- Conceder permisos por grupo.
- Trabajar correo desde la pantalla de email: leer, buscar, responder, mover, marcar leído/no leído y usar adjuntos.
- Importar `msgFilterRules.dat` de Thunderbird y clasificar nuevos correos durante la importación.
- Registrar auditoría de importación, movimiento, lectura, regla aplicada, creación de regla y envío.

### Fase 2: Robustez operativa

- Añadir historial de importaciones por buzón con métricas y errores.
- Permitir probar conexión IMAP/SMTP antes de guardar.
- Añadir ejecución programada configurable por buzón.
- Guardar copia interna visible en Enviados tras enviar por SMTP.
- Mejorar búsqueda con índices full-text.
- Soportar reglas compuestas AND/OR de Thunderbird.

### Fase 3: Producto empresarial

- Panel granular para editar permisos por carpeta.
- Auditoría filtrable por usuario, buzón, carpeta, mensaje y fechas.
- Estados internos adicionales: pendiente, gestionado, bloqueado o asignado.
- Plantillas de respuesta por grupo.
- Firma por buzón compartido.
- PWA instalable con estados offline limitados.

## Fuera de alcance en v1

- Servidor MX propio.
- Exchange, Outlook, MAPI, EWS o ActiveSync.
- JMAP/Stalwart.
- grommunio.
- Calendarios y contactos avanzados.
- Clustering.
- Migración completa de plataforma groupware.

## Criterios de aceptación del MVP

- Importar mensajes desde serviciodecorreo.es no cambia flags ni carpetas en origen.
- Un usuario sin buzón personal puede trabajar en buzones compartidos si su grupo tiene permiso.
- Un usuario con buzón personal ve su buzón aunque no tenga permiso por grupo.
- Un usuario no autorizado recibe estado claro de sin permisos.
- Una respuesta desde ventas@ sale como ventas@ y queda auditada con el usuario real.
- Las reglas importadas desde Thunderbird crean carpetas internas y clasifican mensajes entrantes.
- El webmail es la pantalla principal de trabajo, no una landing page.
