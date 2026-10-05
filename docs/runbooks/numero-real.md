# Pasar del número de prueba a un número real de WhatsApp

Hoy el bot usa el número de prueba de Meta (+1 555…): solo responde a 5 destinatarios fijos. Con
un número real cualquiera puede escribirle, y el registro por la web (y luego por WhatsApp) sirve
para gente nueva. Tiempo: 1 hora de trabajo más la espera de Meta por el nombre visible.

## Límites sin verificar la empresa en Meta

- **Responderle a quien escribe primero: sin límite.** Es lo que hace el bot (el usuario escribe,
  el bot contesta dentro de las 24 horas). Esas respuestas no cuentan para ningún tope y son
  gratis.
- **Conversaciones que inicia el negocio** (plantillas: recordatorios, avisos fuera de las 24 h):
  hasta **250 personas distintas en 24 horas** mientras la empresa no esté verificada o el número
  no tenga el nombre visible aprobado.
- Con la empresa verificada y el nombre aprobado, el tope de iniciadas sube por escalones
  (2.000 → 10.000 → 100.000 → ilimitado) según volumen y calidad. Desde octubre de 2025 el tope
  es por portafolio: un número nuevo hereda el del más alto.

Para el piloto el tope de 250 no molesta: el bot casi nunca inicia conversaciones.

## 1. Conseguir la línea (antes de empezar)

- Una línea venezolana (Movistar o Digitel) **dedicada al bot**, que reciba SMS o llamadas.
- **No puede estar registrada en WhatsApp** (ni la app normal ni Business). Si ya lo está:
  WhatsApp → Ajustes → Cuenta → Eliminar cuenta, y espera unos minutos.
- Después de pasarla a la API **no se puede usar en la app de WhatsApp del teléfono**; el chip
  solo hace falta para recibir el código y para recuperar el número si algún día se desvincula.

## 2. Requisitos en Meta

- Business Manager (portafolio) con **método de pago** cargado (Configuración del negocio →
  Pagos). Desde el 01/10/2026 Meta lo exige para entregar mensajes.
- La verificación del negocio **no es obligatoria** para empezar (ver límites arriba), pero
  solicítala ya si no está: Configuración del negocio → Centro de seguridad.

## 3. Agregar el número

1. developers.facebook.com → app **Asistente de Caja** → WhatsApp → **Configuración de la API**
   (API Setup) → **Agregar número de teléfono**.
2. Perfil: nombre visible **Asistente de Caja** (debe tener relación con el negocio; Meta lo
   revisa), categoría *Servicios financieros* o *Software*, descripción corta.
3. Escribe el número con +58, elige SMS o llamada, pon el código.
4. Anota el nuevo **Identificador del número de teléfono** (Phone number ID) y el
   **Identificador de la cuenta de WhatsApp Business** (WABA ID) que aparecen arriba en esa
   pantalla. Si el WABA ID es distinto al del número de prueba, sigue el paso 5; si es el mismo,
   sáltalo.

## 4. Registrar el número en la Cloud API (PIN de dos pasos)

En tu terminal (el token va en una variable, **nunca en el chat**):

```bash
export META_ACCESS_TOKEN=...   # el token permanente del usuario de sistema caja-worker
export PHONE_ID=...            # el Phone number ID del paso 3.4
curl -s -X POST "https://graph.facebook.com/v21.0/$PHONE_ID/register" \
  -H "Authorization: Bearer $META_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","pin":"123456"}'
```

Cambia `123456` por un PIN de 6 dígitos que inventes y guárdalo en tu gestor de contraseñas
(es la verificación en dos pasos del número). Debe responder `{"success":true}`.

Si responde error de permisos: Business Manager → Usuarios del sistema → `caja-worker` →
**Asignar activos** → agrega la cuenta de WhatsApp Business nueva con control total, y repite.
Si sigue fallando, genera un token nuevo (mismos permisos, caducidad Nunca) y úsalo también en
el paso 6.

## 5. Solo si el WABA es nuevo: suscribir la app a sus webhooks

```bash
export WABA_ID=...
curl -s -X POST "https://graph.facebook.com/v21.0/$WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer $META_ACCESS_TOKEN"
```

Debe responder `{"success":true}`. Sin esto el número recibe mensajes pero al bot no le llegan.
La URL del webhook y el token de verificación ya están en la app y no cambian.

## 6. Cambiar la configuración del bot (me avisas y lo hago yo)

| Dónde | Variable | Valor nuevo |
|---|---|---|
| Railway (worker) | `META_PHONE_NUMBER_ID` | el Phone number ID del paso 3.4 |
| Railway (worker) | `META_ACCESS_TOKEN` | solo si generaste uno nuevo en el paso 4 (lo pegas tú) |
| Vercel (web) | `PLATFORM_WA_NUMBER` | el número sin + ni espacios, ej. `584121234567` |

Después se redespliegan los dos. Los números de los clientes no cambian: cada negocio está
identificado por el teléfono del usuario, no por el del bot.

## 7. Probar

1. Desde tu teléfono, escríbele `hola` al número nuevo: debe llegar el menú.
2. `gasté 5$ en café` → Guardar.
3. Desde un teléfono que **no** estaba en la lista de 5: entra a la web, regístrate y manda el
   código. Debe vincular.
4. WhatsApp Manager → el número → **Calidad: verde**.

## 8. Después

- Avisa a los usuarios del piloto el número nuevo (guárdenlo como "Asistente de Caja").
- WhatsApp Manager → Perfil: foto (logo), descripción y horario.
- El número de prueba puede quedar; no molesta.
