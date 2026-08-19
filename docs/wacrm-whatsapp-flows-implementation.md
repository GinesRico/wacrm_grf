# Guia de implementacion de WhatsApp Flows para WACRM

Este documento resume como funciona el Flow de citas de WhatsApp, como se inyectan datos dinamicos, como se envia por mensaje normal o por plantilla, como se recibe la respuesta del usuario y que piezas hay que replicar en WACRM.

## Objetivo

El Flow permite que un cliente reserve una cita desde WhatsApp:

1. El cliente abre el Flow desde un mensaje interactivo o desde una plantilla.
2. El Flow muestra servicios, fechas y horas disponibles.
3. El cliente introduce sus datos.
4. El backend recibe la confirmacion.
5. El backend crea la cita en la API de citas.
6. El Flow se completa con `SUCCESS` y WhatsApp cierra la pantalla.

## Piezas principales

- Flow publicado en Meta: define pantallas, campos y acciones.
- Endpoint de Flow: recibe eventos cifrados de Meta y devuelve respuestas cifradas.
- Envio del Flow: mensaje interactivo tipo `flow`.
- Envio por plantilla: plantilla aprobada con boton tipo `FLOW`.
- API de disponibilidad: devuelve huecos disponibles.
- API de reserva: crea la cita final.
- UI de WACRM: guarda y pinta el mensaje enviado con cabecera, cuerpo, pie y boton.

## Endpoint configurado en Meta

En Meta, el Flow debe tener configurada la URL de intercambio de datos:

```text
https://TU_BACKEND/webhooks/whatsapp/flows/citas
```

No es el webhook normal de mensajes de WhatsApp Cloud API. El webhook normal sigue siendo algo como:

```text
https://TU_BACKEND/webhooks/whatsapp/cloud
```

## Cifrado del endpoint

WhatsApp Flows llama al endpoint con un payload cifrado. El backend debe:

1. Descifrar la peticion con la clave privada.
2. Procesar el evento.
3. Cifrar la respuesta con la clave AES recibida.
4. Responder `200 text/plain` con el cuerpo cifrado.

Variables necesarias:

```env
WHATSAPP_FLOW_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

o:

```env
WHATSAPP_FLOW_PRIVATE_KEY_PATH=/ruta/privada/flow-private-key.pem
```

Si la clave usa passphrase:

```env
WHATSAPP_FLOW_PRIVATE_KEY_PASSPHRASE=tu_passphrase
```

La clave publica correspondiente se sube en Meta en la seccion de firma de clave publica del Flow.

## Modelo de pantallas

El Flow de citas usa estas pantallas:

```text
APPOINTMENT -> DETAILS -> SUMMARY
```

Tambien puede existir una pantalla informativa `TERMS`, pero no debe bloquear el cierre final.

### APPOINTMENT

Pantalla de seleccion:

- `service`: servicio.
- `date`: fecha.
- `time`: hora.

Los dropdowns leen datos asi:

```json
{
  "type": "Dropdown",
  "label": "Servicio",
  "name": "service",
  "data-source": "${data.service}"
}
```

Por eso el backend debe enviar datos con estas claves exactas:

```json
{
  "service": [
    { "id": "neumaticos", "title": "Neumaticos" },
    { "id": "alineacion", "title": "Alineacion" },
    { "id": "neumaticos_alineacion", "title": "Neumaticos, Alineacion" }
  ],
  "date": [
    { "id": "2026-08-19", "title": "Miercoles 19 agosto" }
  ],
  "time": [
    { "id": "pending_date", "title": "Selecciona una fecha", "enabled": false }
  ]
}
```

Importante: `__example__` en el JSON del Flow sirve para preview y validacion. No debe tratarse como fuente de datos real en produccion.

### DETAILS

Pantalla de datos del cliente:

- `name`
- `phone`
- `email`
- `license_plate`
- `vehicle`
- `notes`

Recibe `service`, `date` y `time` desde la pantalla anterior mediante `payload`.

### SUMMARY

Pantalla de confirmacion. El backend prepara:

- `appointment`: resumen de cita.
- `details`: resumen de datos personales.
- resto de campos necesarios para crear la cita.

El boton final llama a `data_exchange` con:

```json
{
  "trigger": "confirm_appointment",
  "service": "${data.service}",
  "date": "${data.date}",
  "time": "${data.time}",
  "name": "${data.name}",
  "phone": "${data.phone}",
  "email": "${data.email}",
  "license_plate": "${data.license_plate}",
  "vehicle": "${data.vehicle}",
  "notes": "${data.notes}"
}
```

## Triggers esperados

El endpoint debe reconocer estos triggers:

```text
service_selected
date_selected
details_submitted
confirm_appointment
```

Tambien debe manejar:

```text
INIT
BACK
ping
error_key
```

## Respuesta inicial del endpoint

Cuando Meta envia `INIT`, el backend debe devolver la primera pantalla con datos:

```json
{
  "version": "3.0",
  "screen": "APPOINTMENT",
  "data": {
    "service": [
      { "id": "neumaticos", "title": "Neumaticos" },
      { "id": "alineacion", "title": "Alineacion" },
      { "id": "neumaticos_alineacion", "title": "Neumaticos, Alineacion" }
    ],
    "date": [
      { "id": "2026-08-19", "title": "Miercoles 19 agosto" }
    ],
    "time": [
      { "id": "pending_date", "title": "Selecciona una fecha", "enabled": false }
    ]
  }
}
```

## Carga de horas disponibles

Cuando el usuario elige fecha, el Flow llama:

```json
{
  "trigger": "date_selected",
  "service": "neumaticos",
  "date": "2026-08-19"
}
```

El backend consulta la API de disponibilidad:

```text
GET {citasDisponiblesApiUrl}?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
```

Formato recomendado de respuesta:

```json
{
  "total": 2,
  "disponibles": [
    {
      "fecha": "2026-08-19",
      "hora_inicio": "18:00",
      "hora_fin": "18:45",
      "permite_alineacion": true,
      "startTime": "2026-08-19T18:00:00+02:00",
      "endTime": "2026-08-19T18:45:00+02:00"
    }
  ]
}
```

El Flow muestra `hora_inicio`, pero conviene guardar en el `id` un JSON con toda la informacion de la franja:

```json
{
  "id": "{\"hora_inicio\":\"18:00\",\"hora_fin\":\"18:45\",\"startTime\":\"2026-08-19T18:00:00+02:00\",\"endTime\":\"2026-08-19T18:45:00+02:00\"}",
  "title": "18:00"
}
```

Asi, al confirmar, el backend puede crear la cita con `startTime` y `endTime` reales.

## Servicio enviado a la API de citas

Los nombres validos de servicio deben ser exactamente:

```text
Neumaticos
Alineacion
Neumaticos, Alineacion
```

No enviar `Cambio de neumaticos`.

Mapeo recomendado:

```ts
const getServiceTitle = (service: string): string => {
  if (service === "neumaticos") return "Neumaticos";
  if (service === "alineacion") return "Alineacion";
  if (service === "neumaticos_alineacion") return "Neumaticos, Alineacion";
  return service;
};
```

## Creacion de la cita

Al recibir `confirm_appointment`, el backend crea la cita:

```text
POST {citasBookingApiUrl}
```

Payload recomendado:

```json
{
  "Nombre": "Gines",
  "Telefono": "622116542",
  "Email": "info@arvera.es",
  "Servicio": "Neumaticos",
  "startTime": "2026-08-19T18:00:00+02:00",
  "endTime": "2026-08-19T18:45:00+02:00",
  "Matricula": "1412GRM",
  "Modelo": "Bmw",
  "Notas": "Comentarios"
}
```

Si la franja seleccionada no incluye `startTime` y `endTime`, el backend no debe crear una cita incompleta. Debe registrar warning y devolver un error controlado o impedir la confirmacion.

## Cierre correcto del Flow

Despues de crear la cita, no se debe devolver otra vez `SUMMARY`. Para cerrar el Flow, devolver:

```json
{
  "version": "3.0",
  "screen": "SUCCESS",
  "data": {
    "extension_message_response": {
      "params": {
        "flow_token": "token-del-flow",
        "service": "neumaticos",
        "date": "2026-08-19",
        "time": "18:00",
        "name": "Gines",
        "phone": "622116542"
      }
    }
  }
}
```

Esto indica a WhatsApp que el Flow ha terminado y debe cerrarse.

## Envio normal de Flow

Para enviar un Flow directamente, usar mensaje interactivo tipo `flow`:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "34622116542",
  "type": "interactive",
  "interactive": {
    "type": "flow",
    "header": {
      "type": "text",
      "text": "Reservar cita"
    },
    "body": {
      "text": "Abre el formulario para elegir servicio, fecha y hora."
    },
    "footer": {
      "text": "Autorecambios Vera"
    },
    "action": {
      "name": "flow",
      "parameters": {
        "flow_message_version": "3",
        "flow_id": "FLOW_ID_PUBLICADO",
        "flow_token": "flow-123",
        "flow_cta": "Reservar cita",
        "flow_action_payload": {
          "screen": "APPOINTMENT",
          "data": {
            "service": [],
            "date": [],
            "time": []
          }
        }
      }
    }
  }
}
```

Para envio normal, los datos iniciales van dentro de:

```text
flow_action_payload.data
```

## Envio mediante plantilla con boton Flow

Una plantilla aprobada puede tener un boton tipo `FLOW`. Al enviar esa plantilla, el payload no es igual al envio normal.

El componente de boton debe ser:

```json
{
  "type": "button",
  "sub_type": "flow",
  "index": "0",
  "parameters": [
    {
      "type": "action",
      "action": {
        "flow_token": "template-flow-123",
        "flow_action_data": {
          "service": [],
          "date": [],
          "time": []
        }
      }
    }
  ]
}
```

Importante: en plantillas, los datos iniciales van directamente en:

```text
flow_action_data
```

No deben ir asi:

```json
{
  "flow_action_data": {
    "screen": "APPOINTMENT",
    "data": {
      "service": [],
      "date": [],
      "time": []
    }
  }
}
```

Ese formato provoca que el Flow abra sin datos, porque el JSON del Flow espera `${data.service}`, `${data.date}` y `${data.time}` en la raiz de los datos del Flow.

## Diferencia clave entre envio normal y plantilla

Envio normal:

```json
{
  "flow_action_payload": {
    "screen": "APPOINTMENT",
    "data": {
      "service": [],
      "date": [],
      "time": []
    }
  }
}
```

Envio por plantilla:

```json
{
  "flow_action_data": {
    "service": [],
    "date": [],
    "time": []
  }
}
```

Esta diferencia es critica.

## Persistencia para pintar bien la UI de WACRM

Cuando WACRM guarda el mensaje enviado, no debe guardar solo el `body`. Tambien debe guardar los metadatos visuales:

```json
{
  "type": "flow",
  "headerText": "Reservar cita",
  "footerText": "Autorecambios Vera",
  "buttons": [
    {
      "type": "FLOW",
      "text": "Reservar cita"
    }
  ]
}
```

En Whaticket se ha usado el campo `templateComponents`, pero en WACRM puede llamarse `interactiveComponents`, `messageComponents` o similar.

La UI debe pintar:

1. Cabecera: `headerText`.
2. Cuerpo: `body`.
3. Pie: `footerText`.
4. Botones: `buttons[].text`.

Los mensajes antiguos guardados sin esos metadatos no podran repintarse completos salvo que se reconstruyan desde auditoria o logs.

## Validacion de plantilla en WACRM

Cuando WACRM lista plantillas aprobadas desde Meta, debe revisar componentes:

```json
{
  "type": "BUTTONS",
  "buttons": [
    {
      "type": "FLOW",
      "text": "Pide tu cita online"
    }
  ]
}
```

Si encuentra un boton `FLOW`, debe enviar un componente `button` con:

- `sub_type: "flow"`
- `index`: indice real del boton en la plantilla.
- `parameters[0].type: "action"`
- `parameters[0].action.flow_token`
- `parameters[0].action.flow_action_data`

El indice debe ser el indice real del boton. Si el boton Flow es el segundo boton, el indice debe ser `"1"`.

## Datos iniciales recomendados

Funcion reutilizable:

```ts
const getInitialCitasFlowData = () => ({
  service: [
    { id: "neumaticos", title: "Neumaticos" },
    { id: "alineacion", title: "Alineacion" },
    { id: "neumaticos_alineacion", title: "Neumaticos, Alineacion" }
  ],
  date: getNextWorkDays(),
  time: [
    {
      id: "pending_date",
      title: "Selecciona una fecha",
      enabled: false
    }
  ]
});
```

Esta funcion debe usarse en tres sitios:

1. Respuesta `INIT` del endpoint.
2. Envio normal del Flow dentro de `flow_action_payload.data`.
3. Envio por plantilla dentro de `flow_action_data`.

## Checklist de implementacion en WACRM

- Crear tabla/configuracion de Flows con `flowId`, `title`, `bodyText`, `footerText`, `buttonText`, `screen`, `active`.
- Crear endpoint publico `POST /webhooks/whatsapp/flows/citas`.
- Implementar descifrado y cifrado de WhatsApp Flows.
- Configurar clave privada en variables de entorno.
- Subir clave publica en Meta.
- Configurar endpoint del Flow en Meta.
- Implementar `INIT`, `BACK`, `ping` y `error_key`.
- Implementar `service_selected`.
- Implementar `date_selected` consultando API de disponibilidad.
- Implementar `details_submitted`.
- Implementar `confirm_appointment` creando cita.
- Devolver `SUCCESS` con `extension_message_response` al completar.
- En envio normal, usar `flow_action_payload.data`.
- En envio por plantilla, usar `flow_action_data` en raiz.
- Guardar metadatos visuales del mensaje para que la UI pinte cabecera, pie y botones.
- Registrar logs claros de request recibida, trigger, screen, status de API de citas y errores de cifrado.

## Problemas frecuentes

### El Flow abre en blanco

Causas habituales:

- No se envio `service`, `date` o `time`.
- Se confio en `__example__` como si fueran datos reales.
- En plantilla se mando `{ data: { service } }` en vez de `{ service }`.
- El endpoint no esta siendo llamado por Meta.
- Error de cifrado por clave privada incorrecta.

### El envio normal funciona pero la plantilla no

Revisar la diferencia:

- Normal: `flow_action_payload.data`.
- Plantilla: `flow_action_data`.

Tambien revisar que el boton sea `sub_type: "flow"` y que el indice sea correcto.

### La cita se crea pero el Flow no se cierra

El endpoint esta devolviendo una pantalla normal despues de confirmar. Debe devolver:

```json
{
  "screen": "SUCCESS",
  "data": {
    "extension_message_response": {
      "params": {}
    }
  }
}
```

### La UI de WACRM no pinta cabecera, boton o pie

El mensaje se guardo solo con `body`. Guardar tambien:

```json
{
  "headerText": "...",
  "footerText": "...",
  "buttons": []
}
```

### La API de citas recibe servicio incorrecto

Usar solo estos valores:

```text
Neumaticos
Alineacion
Neumaticos, Alineacion
```

## Referencias utiles

- Meta WhatsApp Flows endpoint: https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/implementingyourflowendpoint
- Meta WhatsApp Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api
- Ejemplo de envio de Flow por plantilla: https://docs.aws.amazon.com/social-messaging/latest/userguide/managing-flows-send.html

