# Pasar del número de prueba a un número real de WhatsApp

Hoy el bot usa el número de prueba de Meta (+1 555…): solo responde a 5 destinatarios fijos. Con
un número real cualquiera puede escribirle, y el registro por la web (y luego por WhatsApp) sirve
para gente nueva. Tiempo: 1 hora de trabajo más la espera de Meta por el nombre visible.

## Límites sin verificar la empresa en Meta

- **Responderle a quien escribe primero: sin límite.** Es lo que hace el bot (el usuario escribe,
  el bot contesta dentro de las 24 horas). Esas respuestas no cuentan para ningún tope. Desde el
  01/10/2026 Meta las cobra como mensajes de servicio: 1.000 gratis al mes por número y luego
  0,0113 USD cada uno (ADR-014; las reacciones son gratis).
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

## 3. Agregar el número (panel de Meta de octubre de 2026)

El panel cambió: ya no hay "Configuración de la API" con el botón. La **Test WhatsApp Business
Account** no admite números reales (el botón "Agregar número" sale gris); el número va en una
cuenta de WhatsApp Business real que se crea en este flujo.

1. developers.facebook.com → **Mis apps** → **Asistente de Caja** → caso de uso **Conectar en
   WhatsApp** → menú izquierdo **Configuración básica** → **Paso 2: Configuración de
   producción**.
2. "Registra tu número de teléfono de WhatsApp" → **Agregar número nuevo**:
   - *Información de la empresa*: elige el portafolio existente si aparece; si no, nombre
     comercial (**JP Software Dev**), sitio `https://holarocco.com`, país **Venezuela**,
     dirección vacía hasta la verificación. Lo que se ponga aquí debe coincidir después con el
     documento de la verificación del negocio (RNE o RIF).
   - *Perfil de WhatsApp*: nombre visible **Asistente de Caja**, categoría Finanzas.
   - *Agregar número*: +58 sin el 0 inicial, verificación por SMS.
3. En la misma pantalla aparece la cuenta (WABA) con el número en *No registrado*:
   - **Registrar** → pide el PIN de 6 dígitos de la verificación en dos pasos (guárdalo). Hace lo
     mismo que la llamada `/register` a la API.
   - Interruptor **Suscribir webhooks** de esa cuenta: activado (equivale a `subscribed_apps`).
   - **Agrega la información de pago**: asigna el método de pago del portafolio.
4. Acceso del bot: business.facebook.com → Configuración → **Usuarios del sistema** →
   `caja-worker` → **Asignar activos** → Cuentas de WhatsApp → la cuenta nueva → **Control
   total**. (O desde la cuenta: Configuración → Cuentas → Cuentas de WhatsApp → la cuenta →
   Asignar personas. En el celular: Business assets → la cuenta → Access.) Sin esto el bot no
   puede responder desde el número.
5. Anota el **Identificador del número de teléfono** (Phone number ID) que sale debajo del
   número.

Sin verificar el negocio se pueden tener hasta 2 números; verificado, hasta 20.

Hecho el 07/10/2026: cuenta **Rocco** (WABA 2338829886855969, portafolio Just Travel), número
**+58 424-699-5167** (Phone number ID 1448159538369862).

### Por API, si el panel falla

```bash
export META_ACCESS_TOKEN=...   # token de caja-worker, nunca en el chat
export PHONE_ID=...  WABA_ID=...
curl -s -X POST "https://graph.facebook.com/v21.0/$PHONE_ID/register" \
  -H "Authorization: Bearer $META_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","pin":"123456"}'
curl -s -X POST "https://graph.facebook.com/v21.0/$WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer $META_ACCESS_TOKEN"
```

Los dos deben responder `{"success":true}`.

## 4. Cambiar la configuración del bot (me avisas y lo hago yo)

| Dónde | Variable | Valor nuevo |
|---|---|---|
| Railway (worker) | `META_PHONE_NUMBER_ID` | el Phone number ID del paso 3.5 |
| Railway (worker) | `META_ACCESS_TOKEN` | solo si hubo que generar uno nuevo (lo pegas tú) |
| Vercel (web) | `PLATFORM_WA_NUMBER` | el número sin + ni espacios, ej. `584121234567` |

Después se redespliegan los dos. Los números de los clientes no cambian: cada negocio está
identificado por el teléfono del usuario, no por el del bot.

## 5. Probar

1. Desde tu teléfono, escríbele `hola` al número nuevo: debe llegar el menú.
2. `gasté 5$ en café` → Guardar.
3. Desde un teléfono que **no** estaba en la lista de 5: entra a la web, regístrate y manda el
   código. Debe vincular.
4. WhatsApp Manager → el número → **Calidad: verde**.

## 6. Después

- Avisa a los usuarios del piloto el número nuevo (guárdenlo como "Asistente de Caja").
- WhatsApp Manager → Perfil: foto (logo), descripción y horario.
- El número de prueba puede quedar; no molesta.
