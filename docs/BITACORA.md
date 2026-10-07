# Bitácora de construcción

Registro corto por día de trabajo: qué quedó terminado, qué se aprendió, qué quedó pendiente. El plan está en la Fase 8 de `DISENO-MVP.md`.

## Semana 1 (walking skeleton)

### Día 1 · 29/09/2026 · Monorepo, esquema y aislamiento por tenant

**Terminado**
- Monorepo pnpm: `apps/web` (Next.js 16), `apps/worker` (Node 22), `packages/core`, `packages/db`, `packages/config`. TypeScript estricto, Biome, Vitest, CI en GitHub Actions (lint, typecheck, test).
- `packages/db`: esquema Drizzle del schema `app` y migración SQL inicial `0001_init.sql` con las 14 tablas de la Fase 2, RLS por tenant en todas las tablas con `tenant_id`, rol `caja_app` sin `BYPASSRLS`, funciones `SECURITY DEFINER` para resolver un teléfono antes de conocer el tenant, `audit_log` solo con `INSERT` para la app. Migrador propio (`pnpm db:migrate`) y seed de los dos pilotos (`pnpm db:seed`).
- `withTenant(db, tenantId, fn)`: único punto de entrada para datos de tenant; fija `app.tenant_id` con alcance de transacción.
- Test de aislamiento RLS sobre PGlite (Postgres real en WASM, sin servidor): sin tenant fijado cero filas; cada tenant ve solo lo suyo; insertar a nombre de otro falla; `UPDATE` ajeno no afecta filas; `resolve_phone` funciona sin tenant; `DELETE` en `audit_log` denegado.
- `packages/core/domain`: dinero con `decimal.js` (half-up, una sola función `convert`, parseo de montos venezolanos, formato `$15,00` y `Bs 12.870,00`), regla de moneda por umbral, fechas de negocio en hora de Caracas con relativas ("ayer", "el lunes"). 32 tests.
- Worker mínimo que valida entorno con Zod, conecta y espera. Web mínima que compila.

**Aprendido**
- PGlite soporta roles, `SET ROLE` y RLS: los tests de base corren en CI sin Docker.
- `decimal.js` bajo `NodeNext` exige `import { Decimal }` (named), no el default.
- Vercel no sirve para el worker y Hobby prohíbe uso comercial (Fase 6); el worker va a Railway.
- Cambios de Meta desde el 01/10/2026: mensajes de servicio cobrados por mensaje con 1.000 gratis por número. Diseño multi-número desde el día uno (`tenant.wa_phone_number_id`).

**Pendiente para el día 2**
- Módulo `whatsapp`: tipos de payload, parseo, firma HMAC sobre cuerpo crudo, cliente de envío.
- Route handler del webhook en Next.js con idempotencia y encolado (pg-boss) en la misma transacción.
- Cuentas externas (S0, fin de semana): app de Meta con número de prueba, Business Manager, proyecto de Supabase, Railway, claves de Anthropic y Deepgram, dominio.

**Deuda técnica explícita**
- `drizzle-kit check` contra la migración a mano aún no está en CI.
- Tema y tokens de diseño del dashboard: día 6.

### Día 2 · 29/09/2026 · Módulo de WhatsApp, cola y webhook

**Terminado**
- `packages/core/src/whatsapp`: esquemas Zod laxos del payload de Meta; `parseWebhook` normaliza texto, audio, imagen, botones, listas, tipos no soportados, estados y usuarios con BSUID sin número; `verifySignature` (HMAC-SHA256 sobre el cuerpo crudo, comparación en tiempo constante, nunca lanza); `MetaClient` con `fetch` inyectable: texto, botones, listas, leído con indicador de escritura, info y descarga de medios con tope de bytes, y `MetaApiError` con `retryable` (429 y 5xx). Valida los límites de Meta (3 botones de 20 caracteres, 10 filas de 24, cuerpo de 1.024) antes de enviar.
- `packages/db/src/queue.ts`: pg-boss 12.35 con schema `pgboss`; cola `process-message` con política `key_strict_fifo` y `singletonKey` por teléfono; `enqueueProcessMessage` usa `fromDrizzle(tx, sql)` para encolar en la misma transacción.
- `packages/core/src/inbox/ingest.ts`: por mensaje, transacción con `webhook_event` (clave única `msg:<wamid>`) más job; duplicado no crea job; si encolar falla no queda evento; estados fallidos se guardan sin job, entregados se descartan.
- `apps/web`: `lib/webhook.ts` con GET de verificación y POST con firma, JSON, ingesta y 500 solo cuando la base o la cola fallan (para que Meta reintente); route handler en `app/api/whatsapp/webhook`; singletons de base y productor pg-boss.
- Fixtures de payloads compartidos y 33 tests nuevos (firma, parseo, cliente con `fetch` falso, ingesta sobre PGlite, handler con `Request` estándar). Total: 71 tests.

**Aprendido**
- pg-boss 12 entrega los jobs al handler como arreglo (batch), aunque `batchSize` sea 1. El worker del día 3 debe iterar.
- El helper de PGlite se expone como `@caja/db/testing` para que otros paquetes prueben contra Postgres real sin servidor.

**Pendiente para el día 3**
- Worker con pg-boss: `ensureQueues`, handler de `process-message`, resolución de teléfono a tenant y rol, handlers deterministas (desconocido, menú con tasa, "tasa", "ayuda", confirmar y cancelar), plantillas en `render/es-VE.ts`.
- Instalación del schema `pgboss` en Supabase: el worker con `migrate: true` necesita `CREATE` en la base para `caja_app`, o se corre una vez con la URL de administrador. Decidir al desplegar en Railway.
- Registrar la URL del webhook en Meta cuando exista un despliegue o un túnel local.

### Día 3 · 29/09/2026 · Worker, handlers deterministas y plantillas

**Terminado**
- `packages/core/src/render/es-VE.ts`: todas las plantillas de la Fase 4 que no dependen del ledger (menú con tasa, tasa con próxima y advertencia, bienvenida de dueño y empleado, ayuda, desconocido, fuera de alcance, prompts de menú, corrección, vencido, cancelado, LLM caído). Ids de botones con prefijo (`menu:`, `confirm:`, `fix:`, `cancel:`, `currency:`, `cat:`) y `parseReplyId`.
- `packages/core/src/identity`: `resolveSender` vía `app.resolve_phone` (sin tenant fijado), `canUse`, y rate limit de desconocidos con ventana deslizante en `unknown_sender_hit` (5 por hora, luego silencio).
- `packages/core/src/rates/current.ts`: tasa vigente y próxima por consulta, con detección de tasa vieja por días hábiles.
- `packages/core/src/inbox/process.ts`: `processInbound` idempotente: evento ya cerrado o ya respondido no se repite; eventos con más de 12 h se marcan vencidos; desconocidos reciben texto fijo sin LLM y sin guardar contenido; leído más indicador de escritura; enrutamiento determinista (hola/menú, tasa, ayuda, botones de menú, confirmar/corregir/cancelar borradores, empleado que pide cierre) y el resto al agente (stub hasta el día 5); cada respuesta se registra como `message(out, sending)` antes de enviar y pasa a `ok` o `failed`; 4xx de Meta no reintenta, 5xx sí.
- `packages/db/src/install-queue.ts` (`pnpm --filter @caja/db run queue:install`): instala el schema `pgboss` con el rol administrador y otorga permisos a `caja_app`. El worker arranca con `migrate: false`.
- `apps/worker`: pg-boss en modo worker, `ensureQueues`, handler en lote de `process-message` con `localConcurrency`, un `MetaClient` por número de la plataforma (mapa, listo para N números), apagado ordenado.
- Postgres 16 local en el puerto 5433 para probar pg-boss real; CI con servicio `postgres:16`. Test verificado: tres jobs del mismo teléfono se procesan uno a la vez y en orden, otro teléfono en paralelo; encolar dentro de una transacción que falla no deja job; `caja_app` usa la cola y sigue bajo RLS. Total: 100 tests.

**Aprendido**
- `db.execute()` devuelve un arreglo con postgres.js y `{ rows }` con PGlite: helper `rows()` en `@caja/db` para no depender del driver.
- pg-boss ordena FIFO por `created_on`: dos jobs en la misma transacción empatan. La ingesta usa una transacción por mensaje, así que el orden real se conserva.
- Postgres se niega a correr como root; el servidor local corre como el usuario `postgres` bajo `/tmp/pg16`.
- Un id de botón viene del cliente: se valida como UUID antes de consultar `pending_action`.

**Pendiente para el día 4**
- `rates`: scraper de bcv.org.ve con fecha valor y respaldo DolarAPI; cron en pg-boss (15:00 a 20:00 Caracas cada 30 min, más 08:00).
- `ledger` (`LocalProvider`): `createExpense` transaccional con auditoría; ejecutor de `confirm` para `create_expense`; plantilla de borrador y de guardado con total del día.
- Cuentas externas de S0 para conectar el webhook real.

### Día 4 · 29/09/2026 · Tasa BCV y ledger de gastos

**Terminado**
- `packages/core/src/rates`: fuente BCV (parseo de la página con tasa en formato venezolano y fecha valor), fuente DolarAPI de respaldo (fecha valor inferida por hora de actualización: después de las 15:00 Caracas en día hábil rige el siguiente día hábil), `storeRate` con reglas (el BCV manda; DolarAPI solo llena huecos), `refreshRates` que recorre fuentes en orden y reporta errores, y `rateFor(fecha)` que usa la última publicada en fin de semana o feriado.
- `packages/core/src/ledger`: `createExpense` transaccional (convierte con la tasa congelada del borrador o la vigente, inserta el movimiento y su fila de auditoría en la misma transacción), `expenseTotalForDay` en SQL, `findCategory` sin acentos ni mayúsculas, `createExpenseDraft` (un solo borrador activo por teléfono; el nuevo cancela al anterior; expira a 10 min) y `expirePendingActions`.
- Plantillas del borrador según el guion de la Fase 4 (moneda inferida, tasa de otro día, transcripción, borrador reemplazado) y de "guardado" con el total del día.
- `processInbound`: el botón Guardar ejecuta el borrador `create_expense`, lo marca confirmado y responde con el total; un segundo toque no duplica.
- Worker: `jobs.ts` registra los handlers de `process-message`, `fetch-bcv-rate` y `housekeeping`, y los cron en hora de Caracas (tasa cada 30 min entre 15:00 y 20:00 de lunes a viernes, más 08:00 diario; limpieza cada 5 min). Comando manual `pnpm --filter @caja/worker rates:refresh`.
- 17 tests nuevos. Total: 117.

**Aprendido**
- En un `RETURNING` de `INSERT ... ON CONFLICT DO UPDATE`, la tabla ya refleja la fila nueva: no sirve para saber si cambió. `storeRate` se hizo con select y luego escritura.
- El worker no puede compartir un `wa_message_id` entre dos envíos: la restricción única de `message` lo protege; los tests deben generar ids distintos.

**Pendiente para el día 5**
- Agente con Claude Sonnet 5.5: prompt de sistema v1, herramientas `draft_expense`, `ask_clarification`, `reject_out_of_scope`, loop con tope de iteraciones y timeout, caché de prompt, validación numérica de aclaraciones, registro de tokens y costo.
- Evals v0 (15 casos) contra el LLM real con tope de costo.
- Verificar el parseo del BCV contra la página real desde Railway (estructura y TLS).

### Día 5 · 29/09/2026 · Agente con Claude Sonnet 5.5 y evals v0

**Terminado**
- `packages/core/src/agent/llm.ts`: interfaz `LlmClient` (ADR-008) con turnos, herramientas con JSON Schema, respuesta con llamadas, uso de tokens y `LlmUnavailableError`. Un segundo proveedor implementa esto sin tocar el loop.
- `packages/core/src/agent/anthropic.ts`: proveedor Claude Sonnet 5.5 con `@anthropic-ai/sdk` (beta messages): `output_config.effort: "low"`, `strict: true` en cada herramienta, `fallbacks: "default"`, caché de prompt por bloque de sistema (global y por tenant), timeout por llamada, un reintento del SDK; 400 y errores de API se traducen a `LlmUnavailableError`. `pricing.ts` calcula el costo por mensaje con la tabla de la Fase 6 y queda en `message.cost_usd`.
- `packages/core/src/agent/prompt.ts`: prompt de sistema v1 en dos bloques (reglas duras y vocabulario venezolano; negocio, moneda, rol y categorías). La fecha y el mensaje van en el turno del usuario. Si hay un borrador en corrección, se incluye para que el modelo lo reenvíe completo.
- `packages/core/src/agent/tools.ts`: `draft_expense`, `ask_clarification`, `reject_out_of_scope`, `get_bcv_rate` con esquemas Zod y JSON Schema estricto. El modelo solo extrae; el backend parsea el monto en formato venezolano, decide la moneda por umbral, resuelve fechas relativas (futuras y de más de 30 días piden aclaración), empareja la categoría contra la lista del tenant y crea el borrador. Guardrail: toda cifra en una aclaración debe existir en el texto del usuario, si no se usa una pregunta genérica.
- `packages/core/src/agent/loop.ts`: 3 iteraciones máximo, timeout 20 s, historial de 10 mensajes de los últimos 30 min como turnos alternos, sin tool_call o rechazo del modelo → fuera de alcance, argumentos inválidos → un reintento con `tool_result` de error y luego fuera de alcance. Registra herramientas, tokens (incluida caché) y costo.
- `processInbound` pasa la transacción del tenant al agente, carga las categorías y liga el borrador al mensaje entrante; `LlmUnavailableError` responde el texto fijo sin reintentar el job. El worker activa el agente real cuando existe `ANTHROPIC_API_KEY` y usa el stub si no.
- `evals/`: paquete con 16 casos en YAML (gastos en dólares, "450 mil bs", coma decimal, punto de miles, "medio millón", antier, pago móvil, empleado; aclaraciones; chiste, redacción, venta, totales, inyección; tasa). Se corren con `pnpm evals` (`RUN_EVALS=1` y `ANTHROPIC_API_KEY`), tope `EVALS_MAX_USD` (0,50 por defecto), y escriben `evals/report/last.json`. Sin clave se saltan.
- 24 tests nuevos sin red (herramientas, loop con LLM falso sobre PGlite, procesador con LLM caído y con agente real). Total: 144 más 16 evals.

**Aprendido**
- `strict: true` exige que todo campo sea requerido y `additionalProperties: false`: los opcionales se modelan como `nullable`. Zod 4 genera el JSON Schema directamente (`z.toJSONSchema`).
- La API exige que el primer turno sea del usuario: el historial descarta respuestas huérfanas al inicio y excluye el mensaje actual (ya insertado en `message`).
- Un reintento por argumentos inválidos es suficiente; el segundo casi siempre repite el error y cuesta tokens.

**Pendiente para el día 6**
- Correr `pnpm evals` con la clave real y ajustar prompt o descripciones hasta 16 de 16. Redesplegar el worker en Railway con `ANTHROPIC_API_KEY` para probar desde WhatsApp.
- Vercel: proyecto sobre `apps/web`, CNAME `caja`, URL del webhook en Meta con `META_VERIFY_TOKEN`; Supabase Auth con Resend; dashboard mínimo; Sentry.
- Reinyectar respuestas de `currency:` y `cat:` al agente (lista de categorías) y verificar el parseo del BCV desde Railway.

### Día 6 · 29/09/2026 · Dashboard mínimo, magic link y observabilidad

**Terminado**
- Evals del día 5 con la clave real: **16 de 16** a la primera, 0,036 USD por corrida (unos 0,002 USD por mensaje con caché de prompt), latencia de 1,2 a 2,5 s por caso (la primera llamada 12 s por arranque de PGlite y TLS). Antes hubo dos correcciones: Vitest no leía el `.env` de la raíz, y el modo `strict` de herramientas rechaza `maxItems` y `maxLength` en el JSON Schema (se omiten; la validación queda en Zod).
- `packages/db/migrations/0002_dashboard_auth.sql`: `app.claim_account(id, email)` vincula la identidad de Supabase Auth con `user_account` (reemplaza el id provisional del seed y mueve las membresías) y `app.memberships_for_user(id)` lista los negocios sin fijar tenant. Ambas `SECURITY DEFINER`, como `resolve_phone`. El seed ahora es idempotente por sección y da acceso al dueño por `SEED_OWNER_EMAIL`.
- `apps/web`: Supabase Auth con `@supabase/ssr` (cookies), `proxy.ts` que refresca la sesión y protege las rutas privadas, `/login` con magic link (acción de servidor, misma respuesta exista o no el correo), `/auth/confirm` que acepta `token_hash` (otro dispositivo) y `code` (PKCE), `/auth/logout`. Sesión cacheada por petición con `claim_account` + membresías; sin negocio va a `/sin-negocio`.
- Dashboard mobile-first con tokens de diseño (tema claro y oscuro por sistema), barra inferior con las 4 pestañas (lateral en escritorio), manifest PWA e icono. **Inicio**: tasa BCV vigente, gastos de hoy y del mes, últimos movimientos. **Movimientos**: lista del mes agrupada por día con monto, equivalente y tasa, mismas cifras que el bot. Cierres y Ajustes con contenido mínimo y cierre de sesión.
- Sentry en web (`instrumentation.ts`, cliente y `global-error`) y en el worker (`@sentry/node`, guardas en los tres handlers y en pg-boss). Sin DSN no envían nada; nunca cuerpos de mensajes.
- `docs/runbooks/dia-6-despliegue.md`: pasos de Supabase Auth (plantilla con `token_hash`, SMTP de Resend), Vercel (root `apps/web`, variables, rama de producción, dominio), CNAME en Squarespace, webhook de Meta y prueba de punta a punta.
- `next build` en verde con las 12 rutas; 4 tests nuevos (funciones de acceso bajo `caja_app`). Total: 148 más 16 evals.

**Aprendido**
- Next 16 renombró `middleware.ts` a `proxy.ts` (función `proxy`); corre en Node.
- Sentry 11 ya no acepta `sendDefaultPii` en `init` (el valor por defecto ya es no enviar PII).
- El índice único por correo obliga a liberar el correo del id provisional antes de insertar el id real en `claim_account`.

**Pendiente para el día 7**
- Ejecutar el runbook del día 6 (Supabase Auth, Vercel, DNS, webhook) y la prueba de punta a punta desde el teléfono.
- Medir latencia p50 y p95 y costo por mensaje desde `message`; diez gastos reales de dos personas; `docs/runbooks/semana-1.md` con lo aprendido y la deuda técnica.
- Reinyectar respuestas de `currency:` y `cat:` al agente; verificar el parseo del BCV desde Railway.

**Ajuste tras la prueba real (día 6, tarde).** El hilo completo funcionó desde el teléfono: `hola` → menú con la tasa real del BCV tomada por el cron desde Railway (Bs 857,89 del 29/09), `gasté 15$ en champú` → borrador → Guardar → fila en el dashboard, y `cuéntame un chiste` → rechazo. Falló "ayer pagué 450 mil bs de hielo" con "no tengo la tasa para esa fecha": la base solo tenía la tasa de hoy. `rateFor` ahora usa la primera tasa conocida cuando no hay ninguna hasta esa fecha (el borrador muestra la fecha de la tasa y el dueño confirma). Tropiezos de despliegue que quedaron en el runbook: `NEXT_PUBLIC_*` no pueden ser Secret en Vercel; el magic link de un correo nuevo sale por la plantilla "Confirm signup", no por "Magic Link"; Meta no entrega webhooks reales hasta publicar la app (requiere URL de privacidad); la WABA debe suscribirse a la app con `POST /{waba}/subscribed_apps`; el token de "Inicio rápido" caduca en 24 h, hay que usar el del usuario del sistema.

### Día 7 · 29/09/2026 · Herramientas de operación y prueba con cinco personas

**Terminado**
- `pnpm db:phone:add`: alta de teléfonos en el negocio de un dueño sin dashboard (rol, nombre, activo), idempotente, con validación de que el dueño existe y el número no está en otro negocio. Corre como `caja_app` bajo RLS usando `resolve_phone` para ubicar el tenant.
- `rates:import <csv>`: carga de historia de tasas desde el Excel del BCV exportado a CSV (`;` o `,`, fechas `DD/MM/YYYY` o ISO, decimales con coma). Nunca pisa una tasa tomada en vivo del BCV. `FetchedRate.source` admite `import`.
- `pnpm metrics [días]`: mensajes por día, latencia p50 y p95 (agente vs determinista), costo del LLM, herramientas elegidas, eventos del webhook y movimientos, leyendo con la URL de administrador.
- `docs/runbooks/semana-1.md`: mapa de dónde vive cada pieza y qué variables deben coincidir, rutina diaria, protocolo de la prueba con cinco personas (lista de Meta + alta en base + guion de 7 pasos), carga de historia, tabla de métricas para el domingo, rotación de credenciales y la lista de deuda técnica ordenada.
- 4 tests nuevos. Total: 153 más 16 evals.

**Pendiente (lo hace Javier esta semana)**
- Agregar los destinatarios de prueba en Meta y en la base, correr el guion con cada uno.
- Importar la historia de tasas del BCV.
- El domingo: `pnpm metrics 7` y llenar la tabla del runbook; anotar cada fallo del agente como caso de eval.

### S2 · día 1 · 29/09/2026 · Ventas adelantadas desde S3

Decisión: al probar el walking skeleton, el menú ofrecía "Registrar venta" y el bot la rechazaba. Se adelantan las ventas (US-C1, US-C2, US-C3) a S2; el onboarding por código se corre unos días.

**Terminado**
- `ledger/income.ts`: `createIncomeDayTotal` (una fila `day_total` por método, cada una con su moneda original y su equivalente; `replace` da de baja lógica los totales previos del día con auditoría), `createIncomeSingle`, `existingDayTotal`, `dayTotals` (ventas y gastos vivos del día).
- Borradores: `createIncomeDayTotalDraft` valida en backend que el desglose cuadre con el total (en USD, tolerancia 0,01); si no, guarda `mismatch` y el mensaje ofrece "Total $350" (agrega la diferencia como Sin especificar) o "Total $300" (deja la suma del desglose). Si ya hay un total ese día, los botones pasan a Reemplazar / Agregar / Cancelar. Solo total → una línea "Sin especificar" con invitación al desglose. `insertDraft` común a todos los borradores.
- Agente: herramientas `draft_income_day_total` (total y/o desglose por método, `when`) y `draft_income_single`; el modelo solo extrae, el backend parsea montos, decide moneda (explícita > umbral > moneda propia del método > defecto del negocio > USD) y fecha. Prompt v1.1 con verbos de venta, métodos y desglose. `reject_out_of_scope` queda para cierres, consultas y correcciones.
- Botones de decisión `choice:<clave>:<id>` (`stated`, `breakdown`, `replace`, `append`) enrutados sin LLM; Guardar sobre un borrador con desglose sin cuadrar o día ya cerrado vuelve a mostrar la decisión en vez de escribir.
- Plantillas de la Fase 4: "Venta del día por confirmar", desglose que no cuadra, solo total, día ya cerrado, ingreso suelto, "✅ Venta guardada. Hoy: vendiste X, gastaste Y". Dashboard con ventas y neto de hoy y del mes.
- 10 tests nuevos (ledger, borradores, punta a punta con Reemplazar, Agregar y desglose) y 5 evals de ventas. Total: 163 más 21 evals.

**Pendiente en S2**
- Correr `pnpm evals` con la clave (ventas nuevas) y ajustar si el modelo confunde gasto con venta.
- Cierre diario y consultas ("cierre", "cómo va el mes"), corrección y borrado del último movimiento, tasa manual como corrección (ADR-013), onboarding por código, reinyección de listas `currency:`/`cat:`, evals v1 con 40 casos.

### S2 · día 1 (tarde) · 29/09/2026 · Cierre diario y consultas

**Terminado**
- `ledger/reports.ts`: `dailyClose` (ventas por método con su monto original en Bs, gastos por categoría, neto en USD y Bs a la tasa vigente del día, efectivo en caja, conteo), `periodSummary` (totales, cinco gastos más grandes, días con movimientos), `categoryTotal` (coincidencia exacta, parcial o por palabra; sugerencias si no existe) y `resolvePeriod` (hoy, ayer, semana lunes a domingo, mes calendario, rango hasta 12 meses).
- `ledger/summary.ts`: `renderSummary` decide cierre, resumen o categoría y responde "No tengo movimientos registrados…" sin ceros. Lo usan el bot, la palabra clave y el dashboard: la misma cifra en los tres.
- Sin LLM: "cierre", "cierre de hoy", "cómo fue hoy" y el botón **Ver cierre** dan el cierre de hoy. Empleados reciben "El cierre lo ve el dueño".
- Herramienta `get_summary` (período, rango, categoría) para las variantes en lenguaje libre; el rechazo queda solo para corregir y borrar.
- Plantillas de la Fase 4: cierre diario con bloques de máximo 6 líneas ("Otros N"), neto con signo, cierre del mes, total por categoría, categoría no encontrada, período demasiado largo.
- Dashboard: pestaña Cierres con el cierre de hoy y el resumen del mes desde las mismas funciones.
- 5 tests nuevos y 5 evals de cierres. Total: 168 más 26 evals.
- Operación: Railway saltaba deploys que no tocaban `apps/worker` por los "watch patterns"; ampliados desde el conector a `packages/**` y los manifiestos. El arranque del worker registra el commit y el agente activo.

### S2 · día 2 · 29/09/2026 · Corregir y borrar el último movimiento; tasa manual

**Terminado**
- Migración `0003_manual_rate.sql`: `movement.rate_id` pasa a nulo y aparece `rate_source` (`bcv` | `manual`) con la restricción de que una tasa `bcv` siempre tenga fila. `Rate` en dominio lleva `source`; `manualRate()` valida entre 1 y 1.000.000 Bs por dólar.
- **Tasa manual (ADR-013)**: las tres herramientas de borrador aceptan `rate` ("a tasa 850") y el borrador lo muestra como "(manual)"; el movimiento guarda `rate_source = manual` sin fila en `bcv_rate`. Al corregir un borrador sin guardar, el modelo recibe el borrador (gasto, venta o ingreso) y vuelve a llamar la misma herramienta con todos los campos.
- **Corregir el último guardado (US-B8)**: `amend_last_movement` solo con los campos que cambian (monto, moneda, categoría, descripción, fecha, método, tasa). El backend busca el último movimiento vivo del mismo teléfono con menos de 30 minutos; si cambia la fecha recalcula la tasa; muestra "Cambio el último gasto: Champú · $15,00 → *$20,00*" con Guardar / Cancelar y al confirmar actualiza y audita antes y después. Después de 30 minutos remite al dashboard.
- **Borrar el último**: "bórralo", "quita eso", "elimina el último" sin LLM, y `delete_last_movement` para variantes; "Elimino el último gasto: Champú · $15,00 · hoy" con Eliminar / Cancelar; borrado lógico con auditoría; respuesta con el total del día.
- El rechazo por "llega pronto" queda solo para lo que no existe (inventario, deudas, clientes).
- 4 tests de punta a punta y 5 evals. Total: 149 en core, 172 en total, más 31 evals.

**Operación**: hay que correr `pnpm db:migrate` en Supabase antes de que el worker nuevo reciba un gasto; si llega antes, el job falla por la columna nueva y pg-boss lo reintenta, así que no se pierde, solo se retrasa.

**Corrección tras la prueba real (S2 día 2).** Con nueve herramientas, el modo `strict` de Anthropic rechazó la petición: admite como máximo 16 parámetros con tipo unión en todo el conjunto y cada `nullable` cuenta (teníamos 23). Los "no lo dijo" pasan a `""` en textos y `unknown` / `keep` / `unspecified` en listas; el backend normaliza. Un test cuenta las uniones de todas las herramientas y falla si superan 16, para que no vuelva a pasar en producción.

### S2 · día 3 · 30/09/2026 · Onboarding por código de vinculación

**Terminado**
- `onboarding/register.ts`: `registerBusiness` (tenant en prueba, categorías por tipo, membresía del dashboard, número del dueño en `pending`, primer código), `issueCode` (6 dígitos, solo el hash SHA-256 con el id del teléfono, 15 minutos, vence los anteriores), `verifyCode` (3 intentos; al tercero el código muere), `activatePhone` (auditoría `verify`), `addEmployee`, `setPhoneStatus`, `tenantPhones`, `ownerPhone`. Un número pertenece a un solo negocio en toda la plataforma (`app.phone_is_taken` antes de escribir; `PhoneTakenError`).
- Procesador: un número del dueño en `pending` solo acepta el código; sin código pide el del dashboard; no guarda el contenido, no usa LLM y comparte el límite de 5 respuestas por hora de los desconocidos. Con el código correcto responde la bienvenida con la tasa y el menú (US-A2). El empleado dado de alta desde el dashboard queda `active` sin `verified_at`: su primer mensaje lo verifica, recibe "Hola, Carlos. Quedaste registrado como empleado…" y a continuación la respuesta normal (US-A4). Desactivado = trato de desconocido.
- Dashboard: `/registro` en dos pasos (negocio → código con "Abrir WhatsApp" por `wa.me` y polling cada 3 s a `/registro/estado`; "Generar otro código"). El código en claro viaja solo en una cookie `httpOnly` acotada a `/registro` que dura lo que el código. `requireTenant` manda a `/registro` a quien no tiene negocio; Inicio y Ajustes avisan si el número del dueño sigue sin vincular. Ajustes → Números de WhatsApp: lista con estado, alta de empleado, desactivar y reactivar (solo el dueño).
- Teléfonos del formulario: selector de país (+58 por defecto), quita el 0 inicial venezolano y exige 10 dígitos nacionales.
- Variable nueva en Vercel: `PLATFORM_WA_NUMBER`. Sin migración: `phone_verification` existía desde 0001.
- 9 tests de punta a punta del onboarding y 4 del formato de teléfonos. Total: 159 en core, 183 en la corrida local sin Postgres real, más 28 evals (28/28 con el modelo real).

**Pendiente en S2**: reinyección de listas `currency:`/`cat:`, evals v1 con los fallos reales de la semana, health check y alerta, Sentry con DSN.

### S2 · día 3 (tarde) · 30/09/2026 · Preparación para el cobro por mensaje del 1 de octubre

Contexto: Meta cobra desde el 1/10/2026 cada respuesta libre como mensaje de servicio, con 1.000 gratis al mes por número; reacciones y mensajes del cliente gratis; sin tarjeta no se entregan. ADR-014.

**Terminado**
- Auditoría de envíos: todos los flujos respondían con un solo mensaje salvo la bienvenida del empleado (dos). `mergeOutbound` los fusiona en un envío: bienvenida + respuesta con sus botones.
- `MetaClient.sendReaction` y el tipo `Outbound` de reacción. Cancelar un borrador responde con 🗑️ sobre el toque del botón, gratis, en lugar de "Listo, descartado". Se guarda en `message` con `kind = reaction` para que el conteo lo excluya.
- `pnpm metrics`: primera tabla con el cupo del mes (enviados sin reacciones, reacciones, entrantes, sobre cupo, costo estimado con `META_MSG_RATE_USD`, salientes por entrante, proyección del mes) y reparto de salientes por negocio. Probado contra Postgres local.
- Runbook: tarjeta en el Billing Hub antes del 1/10, prueba de entrega temprano, lectura del cupo cada domingo, y la señal para reabrir ADR-002 (un número por negocio) si la proyección supera el cupo.

**Lo que no cambia**: el LLM nunca envía texto (ADR-006), así que la regla "una respuesta en un solo mensaje" ya estaba garantizada por diseño; el indicador de escribiendo y el acuse de lectura no son mensajes. Guardar sigue siendo texto porque lleva el total del día.

**Corrección tras la prueba real del onboarding (S2 día 3).** El registro en el dashboard y el código funcionaron, pero el bot no respondió al número pendiente: el job fallaba en `allowUnknownReply` porque postgres-js no serializa un `Date` como parámetro de SQL crudo (PGlite sí, y el test pasaba). Con eso, los números desconocidos tampoco recibían nunca el texto de registro en producción. Las fechas van ahora como ISO con `::timestamptz`, y hay un test contra Postgres real (`identity-pg.test.ts`, con `TEST_DATABASE_URL`) para ese camino. Regla: toda consulta cruda con `sql` pasa fechas como texto con cast; las demás ya lo hacían con `::date`.

**Segunda corrección de la misma prueba (S2 día 3).** Tras el fix anterior el bot siguió mudo con ese teléfono: la cola `process-message` es `key_strict_fifo` por teléfono y pg-boss no entrega un job mientras exista uno anterior con la misma clave en `active`, `retry` o `failed`. El job que falló por el `Date` agotó su único reintento, quedó en `failed` y bloqueó para siempre los mensajes siguientes de ese número (los jobs nuevos se quedaban en `created`). En producción se resolvió pasando ese job a `retry` a mano. En código: (1) el handler captura el error del último intento, marca el evento como `failed`, avisa a Sentry y cierra el job sin dejarlo en `failed`; (2) el housekeeping de cada 5 minutos pasa a `cancelled` cualquier `failed` que quede (por ejemplo por vencimiento de tiempo) con `cancelFailedFifoJobs`; (3) test contra Postgres real que reproduce el bloqueo y comprueba la liberación. Además, en cada deploy conviven dos workers unos segundos y el pooler de sesión de Supabase (15 clientes por rol) rechazaba conexiones: los pools del worker bajan a 3 + 3.

### S2 · día 3 (noche) · 30/09/2026 · Reinyección de botones de moneda y categoría

**Terminado**
- "¿500 en qué moneda?" sale con botones **Dólares** / **Bolívares** (`currency:USD` / `currency:VES`) en vez de pedir que se escriba "500$ o 500 bs". Solo ocurre cuando el negocio no tiene moneda por defecto y el monto está bajo el umbral; con el onboarding, la moneda por defecto siempre existe, así que es un caso raro.
- El toque de `currency:` y de `cat:<id>` vuelve al agente como texto ("Respuesta al botón de moneda: dólares (USD). Registra lo del mensaje anterior en esa moneda."), con el historial de los últimos 30 minutos, que ya contiene el mensaje original y la pregunta. El título del botón queda como cuerpo del mensaje entrante, así el historial ve "Dólares" o "Guardar". Un `cat:` con id ajeno responde "No encontré esa categoría".
- Bug de historial encontrado por el test: entrante y respuesta se escriben en la misma transacción y comparten `created_at`; con el empate, el orden era aleatorio y a veces la respuesta quedaba antes del mensaje y se descartaba (la API exige que el primer turno sea del usuario). Desempate por `direction`.
- No se ofrece lista de categorías antes del borrador (ADR-014: sería un mensaje más por gasto); el borrador sugiere una categoría y "es mantenimiento" la corrige.
- 2 tests de punta a punta. Total: 161 en core, 190 en total con Postgres real, más 28 evals.

### S2 · día 3 (noche) · 30/09/2026 · Health check

**Terminado**
- `@caja/db/health`: `checkHealth` lee de pg-boss el último `housekeeping` terminado (worker vivo si hace menos de 15 min) y el mensaje más viejo en espera en `process-message` (cola atascada si pasa de 3 min). Sin tabla de latidos ni proceso nuevo.
- `GET /api/health` en el dashboard: 200 o 503 con banderas y edades, sin datos de negocio; incluye el commit desplegado. Público y fuera del proxy de sesión.
- Test contra Postgres real: worker caído → vivo tras un housekeeping → cola atascada con un job esperando 5 minutos.
- Runbook: cómo crear el monitor externo (Better Stack o UptimeRobot cada 5 min) y las notificaciones de Railway. Eso queda en manos de Javier; el código ya responde.

### S2 · día 4 · 01/10/2026 · Notas de voz (US-B5)

**Terminado**
- `speech/client.ts`: interfaz `SpeechClient` y `DeepgramClient` (Nova-3 por HTTP, sin SDK; `language` configurable, `es` por defecto). `SpeechError` con estado y si conviene reintentar. El audio va de la descarga a la transcripción en memoria; nunca se guarda.
- Procesador: una nota de voz recibe al instante una reacción 🎧 (gratis, ADR-014; sustituye el acuse de texto "Recibí tu nota de voz" del diseño), se descarga con tope de 5 MB, se transcribe, y la transcripción va al agente como entrada `voice` (el movimiento queda con canal `voice`). La respuesta es un solo mensaje: `🎤 "…"` más el borrador o la pregunta. Más de 2 minutos o de 5 MB → "Solo proceso notas de voz cortas"; transcripción vacía o proveedor caído → "No pude escuchar bien la nota de voz. ¿Me lo escribes?". Sin `DEEPGRAM_API_KEY` sigue "llegan pronto".
- La transcripción queda como cuerpo del mensaje entrante: el historial del agente la ve y "no, eran 25" funciona igual que con texto.
- `RouteCtx.ack` para acuses previos a la respuesta (envía y registra el mensaje). Worker: `DEEPGRAM_API_KEY`, `DEEPGRAM_LANGUAGE`; el arranque registra `speech`.
- 3 tests del cliente y 5 de punta a punta. Sin `keyterm` por ahora: Deepgram lo documenta para inglés en Nova-3; se evalúa con las 30 notas reales de la Fase 8.

### S2 · día 4 (tarde) · 01/10/2026 · Fotos de facturas (US-B6)

**Terminado**
- `vision/receipt.ts`: lectura con el mismo modelo del agente (ADR-007), una llamada con la imagen y una sola herramienta estricta `read_receipt` → `{is_receipt, total, currency, date, vendor, line_items_count, confidence}` sin uniones. `receiptUserText` convierte la lectura en el "mensaje del usuario" que lleva a `draft_expense`; el modelo no inventa lo que no se leyó. El turno de usuario del `LlmClient` admite una imagen (base64 en Anthropic).
- `storage/store.ts`: `ObjectStore` con `SupabaseStorage` por REST (subir, borrar, URL firmada) y `MemoryObjectStore` para tests.
- Procesador: foto → reacción 🧾 → descarga (5 MB; JPEG, PNG, WebP) → lectura → si no es factura "Solo proceso fotos de facturas y recibos"; si la confianza es menor a 0,6 o no hay total "No pude leer bien la factura. ¿Cuánto fue y en qué moneda?" → si sirve, la foto va al bucket como `attachment` provisional y el agente arma el borrador con `attachmentId`; respuesta en un envío: "🧾 Leí la factura: proveedor · total · fecha" más el borrador. Guardar deja `movement.attachment_id`; Cancelar da de baja la foto y la borra del bucket. El costo de la lectura se suma al del turno.
- Housekeeping: hallazgo de un bug latente, `expirePendingActions` corría sin tenant y con RLS nunca vencía nada en producción. Migración `0004_housekeeping.sql` con `app.all_tenant_ids()` (SECURITY DEFINER); el job recorre los negocios bajo `withTenant`, vence borradores y barre fotos provisionales de más de una hora sin movimiento (`sweepOrphanAttachments`).
- Dashboard: "ver foto" en cada gasto con factura → `/adjuntos/<id>` valida la sesión y el tenant, firma una URL de 10 minutos y redirige. Requiere `SUPABASE_SERVICE_ROLE_KEY` en Vercel.
- Worker: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET`; sin bucket la foto se lee y el gasto se registra igual, sin respaldo. El arranque registra `vision` y `store`.
- 12 tests nuevos (lector, bucket, punta a punta con Guardar, Cancelar, no factura, baja confianza, lector caído, foto pesada, tipo no admitido, sin lector, barrido). Pendiente de la Fase 6: `sharp` para reducir a 1.000 px y quitar metadatos antes de guardar.

**Corrección tras la prueba real de fotos (S2 día 4).** Javier mandó una factura, corrigió el monto con una nota de voz y el gasto quedó sin foto. Causa: la corrección arma un borrador nuevo (el modelo vuelve a llamar `draft_expense`) y el adjunto solo viajaba en el contexto del turno de la foto. Ahora toda herramienta recibe el borrador pendiente del teléfono (`prior`), y `draft_expense` hereda `attachmentId` y el canal `image` cuando reemplaza un borrador de gasto con foto, con o sin tocar Corregir. Test de punta a punta: foto → "no, eran 50" → Guardar deja la foto vinculada y no quedan fotos huérfanas.

### S2 · día 4 (noche) · 01/10/2026 · Dashboard: editar, borrar y exportar (US-E2, US-E3)

**Terminado**
- Movimientos: navegación por mes (‹ ›), filtros Todo / Gastos / Ventas / Eliminados y "Excel del mes". Cada fila abre su detalle.
- Detalle `/movimientos/<id>`: monto, moneda, fecha, categoría (gastos) o método (ventas), descripción, foto de la factura si la hay, quién lo registró, por qué canal y el mensaje original (texto o transcripción). Guardar pasa por `computeAmend`, la misma función que la corrección por chat: si cambia la fecha se recalcula la tasa y la pantalla lo avisa; auditoría con `actor_type = user` y canal `dashboard`. Eliminar es borrado lógico y el movimiento sigue visible con el filtro Eliminados.
- Exportar (US-E3): `GET /exportar?desde&hasta` genera un .xlsx con exceljs (una fila por movimiento, columnas de la historia, números como números, hoja Info con el rango). Botones en Movimientos, Cierres y un formulario por rango en Ajustes. Tope de 12 meses por archivo.
- `computeAmend` separado de `createEditLastDraft` para que chat y dashboard compartan el cálculo.
- Tests: generación del libro y nombre del archivo.

### S2 · día 5 · 01/10/2026 · Categorías y configuración del negocio (US-E5, US-E7)

**Terminado**
- `ledger/categories.ts`: `listCategories` (con conteo de gastos vivos), `createCategory`, `renameCategory`, `setCategoryActive` (nunca se borran; una desactivada deja de sugerirse al agente y sus gastos conservan el nombre), duplicados sin distinguir mayúsculas, nombres de 2 a 40 caracteres; `getTenantSettings` y `updateTenantSettings` (nombre, tipo, moneda por defecto). Todo con auditoría `user` por `dashboard`.
- Dashboard: Ajustes → formulario del negocio (solo el dueño) y página `/ajustes/categorias` con renombrar en línea, desactivar, reactivar y crear.
- 2 tests. Con esto queda cubierta la Épica E del MVP salvo el resumen del mes en el dashboard (US-E4), que ya existe en Cierres en su versión básica, y el pulido visual.

**Cierre de S2.** Hecho: onboarding por código, ventas, cierres, correcciones, tasa manual, voz, foto, reacciones y una respuesta por mensaje (ADR-014), health check, métricas de cupo, edición, exportación, categorías y configuración. Pendiente de Javier: migración 0004, prueba del empleado, Sentry, notificaciones de Railway. Siguiente bloque: diseño del dashboard.

### S2 · bloque de diseño · 01/10/2026 · Nuevo diseño del dashboard

**Proceso.** Javier pidió un estilo tipo Raycast (oscuro, capas de elevación, tarjetas con acentos sutiles). Antes de tocar código se hizo un mockup de 6 pantallas (Inicio, Movimientos, Detalle, Cierres, Ajustes, Menú) y se iteró con sus comentarios en el propio mockup: cifras menos aglomeradas, menú lateral que abre y cierra en lugar de pestañas abajo, selects y fechas centrados con chevrón, botón Guardar verde con letras blancas y en píldora, exportar con el mismo botón, barras de la semana con el mejor día en menta, el peor en ámbar y hoy en degradado, icono del calendario en blanco, gastos en ámbar y ventas en menta. Con el "ok listo ya me gusta" se pasó a código.

**Terminado**
- `globals.css` reescrito: solo tema oscuro (fondo `#0B0E13`, tarjetas con degradado, borde de 1 px y brillo superior), fuente Geist, cifras tabulares, dos colores con significado fijo (menta = ventas y neto, ámbar = gastos), radios 20/14 px, botón primario en píldora `#168A66`. En escritorio (≥ 960 px) el menú queda fijo y el contenido ocupa hasta 760 px.
- `Shell` (`sidebar.tsx`): cajón lateral con cortina, cierre con Escape y al navegar; cabecera con ☰, título de la sección y píldora con la tasa BCV. Reemplaza `nav.tsx`. Iconos de trazo propios en `icons.tsx` (sin librería).
- Inicio: una cifra grande (neto de hoy) con ventas y gastos en dos baldosas, tarjetas del mes y de efectivo en caja, últimos 6 movimientos.
- Movimientos: flechas de mes, tira Ventas / Gastos / Neto, filtros y Excel del mes; la lista agrupa por día con el neto del día y filas con icono, concepto, canal y equivalente.
- Detalle: etiqueta Gasto/Venta, monto grande en su color, formulario con selects centrados y calendario blanco, tarjeta de origen con avatar y botón "Foto", Guardar en píldora y Eliminar abajo.
- Cierres: segmento Día / Semana / Mes / Rango (`?periodo=`; rango con dos fechas y las validaciones de `resolvePeriod`), neto grande con las barras de los últimos 7 días (`dailyNets`), ventas por método y gastos por categoría, efectivo en caja y exportar.
- Ajustes se divide en páginas: portada con tarjetas, `/ajustes/negocio`, `/ajustes/numeros` (empleados), `/ajustes/exportar` (rango y atajos de 30 y 90 días) y `/ajustes/categorias` con el mismo lenguaje visual. Los redirects de las acciones apuntan a cada subpágina.
- Sin cambios en el bot ni en la base. Lint, typecheck, `next build` y 216 tests en verde.

### S2 · bloque de diseño · 01/10/2026 · QA de la versión móvil

**Método.** Base local con migraciones al día y un negocio sembrado (dueño, empleada sin vincular, 4 categorías, 40 días de tasa, 89 movimientos con texto, voz, foto, dashboard, uno eliminado y una venta grande en Bs). El dashboard se construyó en modo producción con un puente de sesión temporal (no versionado) y Playwright recorrió las 18 pantallas como iPhone 13 (390 px): captura completa, ancho de scroll, elementos que se salen del viewport, objetivos táctiles menores de 40 px, errores de consola; luego las acciones: abrir y cerrar el menú (cortina, Escape, navegar), editar un movimiento, renombrar y crear categoría, descargar el .xlsx.

**Resultado.** Ninguna pantalla con scroll horizontal ni errores de JavaScript; todos los flujos devuelven el aviso esperado. Hallazgos corregidos:
- Categorías: el renombrado en línea quedaba en un campo de 60 px con los botones amontonados. Ahora cada categoría ocupa dos líneas (nombre + Guardar, conteo + Desactivar como enlace).
- Cierres: en las tarjetas Ventas/Gastos a dos columnas el método de pago chocaba con el monto; en el teléfono van apiladas y las etiquetas largas parten de línea. Con "Rango" sin fechas solo se muestra el formulario (antes salía un $0,00 engañoso). Pie "Neto de los últimos 7 días" bajo las barras para que no se confundan con el período elegido.
- Ajustes: la fila "Números de WhatsApp" se truncaba por la insignia "1 sin vincular"; ahora la insignia es solo el número y el subtítulo dice "1 activo · 1 sin vincular". Título de la página "Números" para que quepa junto a la píldora de la tasa.
- Textos auxiliares pegados al elemento anterior: `p.sub` ya no anula el espaciado de `.stack`.
- Detalle: montos largos (Bs con millones) bajan a 30 px para no partir en dos líneas.
- Menú: el nombre del negocio parte en dos líneas en lugar de truncarse.
- Objetivos táctiles: chips 38 px, segmento 40 px, botones pequeños 36 px.

**Nota.** En `next dev` dentro del sandbox el cliente no hidrataba (HMR bloqueado) y el botón ☰ no respondía; en el build de producción, que es lo que corre Vercel, funciona. No es un bug del producto, pero conviene probarlo en el teléfono real.

### S2 · 01/10/2026 · Sentry en Next: build, túnel y runtime

Javier pidió seguir la guía `skills.sentry.dev/instrument`; el entorno bloqueó ese host, así que se completó con la configuración documentada del SDK (`@sentry/nextjs` 11). Ya existían `instrumentation.ts`, `instrumentation-client.ts` y `global-error.tsx`; faltaba el envoltorio del build. Ahora `next.config.ts` pasa por `withSentryConfig` (importado de `@sentry/nextjs/config` en v11): túnel `/monitoring` (excluido del proxy de sesión), source maps solo si hay `SENTRY_AUTH_TOKEN`, sin telemetría. El `register()` del servidor solo inicia en los runtimes `nodejs`/`edge` y etiqueta `release` con el commit de Vercel; el navegador igual. `sendDefaultPii` ya no existe en v11; la política sigue siendo no enviar cuerpos de mensajes. Build de producción en verde con la reescritura `/monitoring` en el manifiesto.

**Sentry activo (S2, 01/10 06:33 UTC).** Javier creó la organización y los dos proyectos y pasó los DSN. Se fijaron `SENTRY_DSN` en el worker (Railway) y `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` en el web (Vercel, producción), con redeploy de ambos. El worker arrancó con `sentry activo` en el commit `c3711b1`; el web desplegó en verde. La migración 0004 ya está aplicada en producción: los avisos de housekeeping cesaron a las 05:05 y corrió el primer barrido de fotos. Pendiente opcional: `SENTRY_ORG`, `SENTRY_PROJECT` y `SENTRY_AUTH_TOKEN` en Vercel para los source maps.

### S2 · 01/10/2026 · Seguridad S2, evals v1 y runbook del piloto

**Terminado**
- Rate limit de conocidos (checklist S2): `countHit` generaliza el contador por clave y ventana sobre `unknown_sender_hit`; `checkKnownLimit` devuelve `ok`, `notify` (justo al cruzar 30 mensajes en 5 minutos) o `drop`. El procesador avisa una sola vez ("Me llegaron muchos mensajes seguidos…") y después calla sin tocar el LLM ni enviar mensajes de servicio, marcando el evento `ignored`. Configurable por `knownMax`/`knownWindowMs`. Tests en identidad y en el procesador.
- Alerta de firmas inválidas: el webhook llama a `onInvalidSignature` (su fallo no cambia el 401); `lib/alerts.ts` cuenta en la clave `sig:invalid` y manda un solo aviso a Sentry al pasar de 10 por minuto. Un ataque no infla Sentry: a partir de la 12.ª solo suma.
- Evals v1: 51 casos (antes 28). El formato admite `kind: voice`, `receipt` (lectura de factura) e `history` (turnos previos insertados en `message`, como los ve el agente). Casos nuevos salidos de las pruebas reales: dictados con números en palabras, venta por voz, respuestas a los botones de moneda y categoría, aclaración respondida solo con el monto, facturas con y sin moneda, "anota", "verdes", moneda al final, corregir moneda, pago puntual por pago móvil en Bs, rango de fechas, empleado que pide el cierre, saludo con conversación. No se pudieron correr desde este entorno (sin `ANTHROPIC_API_KEY`); corren con `pnpm evals` desde la máquina de Javier.
- `docs/runbooks/piloto-1.md`: preparación, guion de la cajera, rutina del dueño, cómo anotar fallos para que sean casos de eval, tabla semanal con las métricas de la Fase 0 y criterios de parada.

**Evals v1, primera corrida (Javier, 01/10):** 49/51, 0,16 USD, Sonnet 5.5. Los dos fallos y su arreglo en el prompt: (1) un empleado que pide "cómo fue hoy?" recibía "fuera de alcance" en vez de "el cierre lo ve el dueño", porque el bloque del tenant decía "no ver cierres" y el modelo lo rechazaba antes de llegar a `get_summary`; ahora le dice que use `get_summary` igual y el sistema responde lo del dueño. (2) "no eran cincuenta no treinta" dictado sin comas se leía como 30; regla nueva en 7b: en "no, eran X, no Y" el correcto es X. Pendiente: volver a correr para confirmar 51/51.

**Segunda corrida (Javier, 01/10): 50/51.** Los dos arreglos del prompt funcionaron. El fallo nuevo es ruido del modelo: "anota un gasto de 0$ en nómina" eligió `draft_expense` con 0 (en la corrida anterior había elegido preguntar). Da igual: `draft_expense` rechaza el 0 en el backend ("No entendí el monto. ¿Cuánto fue?") y no queda borrador. Los dos casos de monto cero ahora comprueban el resultado (`no_draft: true`, cero borradores) y no la herramienta elegida.

**Tercera corrida (Javier, 01/10): 51/51.** Evals v1 cerradas en 0,17 USD por corrida con Sonnet 5.5. Regla que queda: cada fallo del piloto entra como caso antes de tocar el prompt, y el prompt no cambia sin volver a correr la suite.

### S2 · 01/10/2026 · Modelo de negocio v0 y landing

**Terminado**
- `docs/MODELO-NEGOCIO.md`: borrador con mercado (92 % usa WhatsApp con empresas; e-commerce +125 % en 2025), competencia (bots personales 3,99 a 9,99 USD; POS venezolanos 10 a 35 USD), costos unitarios (Meta 0,0113 USD por mensaje de servicio desde el 1/10 tras 1.000 gratis por número de plataforma; IA 0,0032 USD por turno medido en evals; Deepgram 0,0077 USD/min), planes Personal 4,99 / Negocio 19,99 / Negocio Plus 39,99 (hipótesis), márgenes ~46 % y punto de equilibrio en 5 negocios. Hallazgo clave: Meta es el 70 % del costo variable y los 1.000 gratis son por número de plataforma, lo que reabre ADR-002 para el plan Negocio. Lista de lo que el piloto debe medir para reemplazar cada hipótesis.
- `apps/web/lib/plans.ts`: única fuente de planes y límites; la landing la lee. `pnpm metrics` usa 0,0113 por defecto.
- Landing en `/` (antes redirigía a login): portada con teléfono animado que reproduce una conversación real, tres hábitos, funciones, maqueta del dashboard, planes, preguntas y cierre. Efectos de scroll con `animation-timeline: view()` y respaldo por IntersectionObserver; respeta "reducir movimiento". Probada a 390 y 1280 px sin scroll horizontal ni errores.
- Enlaces de campaña `/ir/<slug>` con UTM (`app/ir/links.ts`) y `docs/runbooks/marketing.md` con la convención, textos de anuncios y requisitos de Meta Ads.

**Landing v2 (01/10, tarde).** Javier cambió el enfoque: no "tu caja" sino "un asistente administrativo", con el ancla del sueldo (una administradora 300 USD/mes, el asistente 19,99) y pidió una experiencia tipo sloshseltzer.com donde el visitante interactúa con el teléfono. Hecho sin librerías: `story.tsx` fija el teléfono y traduce el scroll en ocho escenas (mensaje del usuario, "escribiendo…", respuesta), cada una con su titular lateral; las respuestas son el servicio (qué hace, un gasto real, Guardar, cierre, precios, datos, empezar). El chat baja solo como WhatsApp, el pie muestra el próximo mensaje "a punto de enviarse" y con "reducir movimiento" se ve la conversación completa sin fijar nada. Comparación de sueldo en la portada, planes con el nuevo copy, FAQ con la pregunta honesta de qué parte reemplaza. Probada a 390 y 1280 px en cinco puntos del scroll. Textos de anuncios actualizados en el runbook de marketing.

**Landing v3 (01/10, noche).** Javier probó la v2 en el iPhone: el teléfono se veía pequeño, el scroll fijo se trababa en iOS y pidió que pareciera un iPhone real, más grande, y que en el móvil se avanzara tocando "enviar". Hecho: marco de iPhone en CSS puro (titanio con degradado, Dynamic Island, botones laterales, barra de estado con hora 9:41 e iconos SVG, barra de inicio), cabecera de WhatsApp con flecha y acciones, burbujas con hora y doble check, chip "Hoy". Dos modos en el mismo componente: en pantallas de menos de 900 px no se fija nada ni se secuestra el scroll, el próximo mensaje aparece escrito en el cuadro y la persona toca el botón de enviar (con pulso) para avanzar; en escritorio sigue el teléfono fijo guiado por scroll. Teléfono de 76 svh en móvil y 78 svh en escritorio. Sin librerías ni imágenes: nada que cargar y sin problemas de licencia por usar un render de Apple. Probado con Playwright tocando los ocho envíos en 390 px y por scroll en 1280 px.

**Landing v4 y login (01/10, noche).** Tras la prueba de Javier en el iPhone: el botón final quedaba bajo la sombra del teléfono (ahora con margen y por encima), la pista de "toca enviar" pasa a una píldora menta con brillo, el icono de enviar queda centrado, y la portada acepta una foto real en `public/hero.jpg` (se activa sola, con las tarjetas de la comparación encima). El runbook de marketing trae el prompt para generarla con Nano Banana y tres variantes por tipo de negocio. La pantalla de entrada explica el proceso en tres pasos, con botón a lo ancho y nota de datos; en el registro los botones van a lo ancho o centrados.

**Foto del hero (01/10).** Javier generó la imagen con Nano Banana a partir del prompt del runbook: dueño de "Autolavado El Rayo" al atardecer, teléfono en mano, carro recién lavado detrás. Recortada a 4:5 (921 × 1152) y comprimida a 176 KB en `apps/web/public/hero.jpg`; la portada la muestra con las tarjetas de la comparación encima. Negocio y persona ficticios, sin logos de marcas.

**Foto del hero, retirada (01/10).** Vista en el teléfono, a Javier le pareció peor que la versión sin foto. Se quita el archivo; la portada vuelve a las dos tarjetas de la comparación. El soporte queda en el código por si otra imagen funciona mejor: basta con volver a dejar `public/hero.jpg`.

### S2 · 01/10/2026 · Bug: varios gastos en un mensaje

**Síntoma (Javier, WhatsApp real):** "los gastos de hoy fueron 7$ en una arepa y una malta y 7.5$ en una partida de pádel" generó un borrador solo con la arepa ($7,00). El pádel se perdía sin aviso.

**Causa:** `draft_expense` acepta un solo gasto y el agente elige una herramienta por turno (ADR-005). El modelo hizo lo único que podía: registrar el primero.

**Arreglo**
- Herramienta nueva `draft_expenses`: lista de 2 a 6 gastos, cada uno con monto, moneda, descripción, categoría y fecha, más una tasa manual opcional para todos. Sin campos `nullable`, así que no suma uniones al tope del modo estricto.
- Borrador nuevo `create_expenses` (migración `0005_multi_expense.sql` amplía el CHECK de `pending_action.kind`). Un solo mensaje con un renglón por gasto, el total en $ y Bs y los botones Guardar / Corregir / Cancelar. Si las fechas difieren, cada renglón lleva su día.
- Guardar escribe un movimiento por renglón en la misma transacción y responde "✅ Guardados 2 gastos. Gastos de hoy: …". Cancelar borra las fotos de todos los renglones. Corregir funciona igual que en un gasto: el agente vuelve a llamar `draft_expenses` con todos los renglones.
- Si algún renglón tiene moneda ambigua se pregunta una sola vez por todos; si un monto o una fecha no se entiende, se pregunta por ese renglón con su descripción.
- Regla 3 del prompt: con dos o más montos, `draft_expenses` con todos; nunca solo el primero. Un monto con varias cosas ("15$ en champú y cera") sigue siendo un gasto.
- Tests: render del borrador múltiple, procesador de punta a punta (mensaje → borrador con los dos → Guardar → dos movimientos). Tres casos de eval nuevos, entre ellos el mensaje real del piloto (54 casos).

**Para desplegar:** correr `pnpm db:migrate` (aplica la 0005) antes o junto con el deploy del worker. Sin la migración, un mensaje con varios gastos falla al guardar el borrador.

**Autocorrección en el mismo mensaje (02/10).** Javier preguntó qué pasa con una nota de voz como "registrar champú, no, no fueron 20, fueron 15 dólares". Dos riesgos: que la regla nueva de varios gastos la partiera en dos, y que la regla 7b ("en 'no, eran X, no Y' el correcto es el primero") eligiera 20, justo el monto rechazado. Arreglo en el prompt: la regla 3 aclara que corregirse sobre la misma cosa es un solo gasto con `draft_expense`, y la nueva 7c elige el monto por sentido y no por posición (el que el usuario afirma es el bueno, el que rechaza es el equivocado), con ejemplos en los dos órdenes y dictados sin comas. Cuatro casos de eval nuevos (58 en total): voz y texto para gasto nuevo, "digo" y corrección de un guardado con el bueno de último. Pendiente: correr `pnpm evals` en la máquina de Javier.

### S2 · 02/10/2026 · Cola de borradores

**Síntoma (Javier, WhatsApp real):** mandó la foto de una factura y, mientras se leía, "Registrar compra de arepa 5$". Llegó el borrador de la factura y enseguida el de la arepa con "Descarté el borrador anterior sin guardar". La factura se perdía.

**Causa:** ADR-006 decía un solo borrador activo por teléfono (índice único en `pending_action`), así que cualquier borrador nuevo cancelaba al anterior. El orden de procesamiento ya era correcto (`key_strict_fifo` por teléfono).

**Arreglo**
- Migración `0006_draft_queue.sql`: se quita el índice único y queda uno normal. Hasta 5 borradores pueden esperar a la vez por teléfono, cada uno con sus botones; si se pasa del tope, se cancelan los más viejos.
- Un borrador nuevo solo reemplaza a otro cuando es una corrección: el que está en Corregir (al tocar Corregir en uno, los demás salen de corrección) o el más reciente si el modelo marca `corrects_draft: true` ("no, eran 50", "era en bolívares"). Campo nuevo en las cuatro herramientas de borrador; es booleano, así que no suma uniones al tope del modo estricto.
- El modelo ve la lista de borradores que esperan y la regla: registro nuevo → `corrects_draft: false`, no los toca; corrección → `true`.
- Cuando quedan otros esperando, el borrador nuevo lo dice: "Tienes 1 borrador más sin guardar arriba."
- ADR-006 y la tabla de casos borde de DISENO-MVP actualizados.
- Tests: cola, corrección y tope en el ledger; agente con factura esperando + gasto nuevo y con corrección del más reciente. Las evals ahora admiten `pending` (borradores sembrados) y `pending_after`; cinco casos nuevos en `cola.yaml`, entre ellos el mensaje real (63 casos).

**Para desplegar:** `pnpm db:migrate` (aplica la 0005 y la 0006) antes o junto con el deploy del worker, y `pnpm evals`.

**Evals y despliegue (Javier, 02/10): 63/63, 0,24 USD, Sonnet 5.5.** Pasan los cinco casos de la cola, los de varios gastos y los de autocorrección; el caso viejo "no eran cincuenta no treinta" sigue dando 50 con la regla 7c. Producción verificada: 0005 y 0006 aplicadas (05:42 UTC) y el worker corre el commit de la cola. El worker se desplegó unas tres horas antes de la migración; en ese intervalo los 8 eventos de webhook quedaron `done`, sin fallos. Regla para la próxima migración: correr `pnpm db:migrate` antes de subir el código que la necesita.

### S2 · 02/10/2026 · Borrar varios movimientos por chat

**Síntoma (Javier, WhatsApp real):** guardó varios gastos por equivocación y al pedir que los eliminara recibió "Eso todavía no lo hago por chat".

**Causa:** `delete_last_movement` solo borraba el último movimiento, y la descripción de `reject_out_of_scope` mandaba fuera de alcance "corregir algo que no sea el último movimiento". El modelo hizo lo que decían las instrucciones.

**Arreglo**
- `delete_last_movement` recibe `scope`: `last` (el último, como antes y como la palabra clave "bórralo"), `last_batch` (los que se guardaron con el último Guardar, que comparten `created_at` por ir en una transacción), `last_n` con `count` (2 a 10) y `matching` con `description` ("borra el de la arepa"). Sin uniones nuevas en el modo estricto.
- Misma ventana que antes: solo movimientos del mismo teléfono de los últimos 30 minutos. Si pide más de los que caben, el borrador lo dice y da el enlace del dashboard para los viejos. Si no encuentra lo que nombra, pregunta.
- Varios se confirman en un solo mensaje ("Elimino 2 gastos: 1. … 2. …", botones Eliminar / Cancelar) y se borran con auditoría, uno por uno, en la misma transacción. Sin migración: reutiliza el tipo `delete_last` con la lista en `items`.
- Prompt (regla 7b) y descripción de `reject_out_of_scope`: borrar varios sí se hace por chat.
- Tests de punta a punta (por nombre, los del último Guardar, los N últimos, nombre no encontrado) y cuatro casos de eval, entre ellos la frase del piloto (67 casos).

**Evals (Javier, 02/10): 67/67, 0,26 USD.** El borrado de varios pasa en los cuatro casos.

### S2 · 02/10/2026 · Lectura de `pnpm metrics` (primeros 4 días)

- **Meta:** 19 mensajes de servicio en octubre, proyección de 295 en el mes, todo dentro de los 1.000 gratis. 0,95 salientes por entrante: las reacciones como acuse funcionan (ADR-014).
- **IA:** 46 turnos, 0,40 USD, 0,0088 USD por turno, 2,7 veces lo que asume el modelo de negocio (0,0032). La causa es el caché del prompt: dos turnos casi iguales del 30/09 con dos minutos de diferencia costaron 0,0168 (escribe el caché) y 0,0035 (lo lee). Con pocos mensajes el caché de 5 minutos vence entre uno y otro. Opción a medir en el piloto: caché de 1 hora, que escribe más caro pero se reutiliza en mensajes espaciados.
- **Latencia del agente:** p50 4,5 s, p95 23 s. Los cuatro turnos de texto lentos (15 a 28 s) son del 29 y 30/09; desde el 01/10 el texto más lento tardó 5,4 s. Las fotos de facturas tienen p50 9,7 s y máximo 35 s: es lo que dejó la factura detrás del gasto de la arepa y motivó la cola de borradores.
- **Rechazos (8):** dos correctos (un chiste, "cuáles son tus capacidades"); cinco ventas del 29/09 antes de que existieran las herramientas de ventas; uno es el borrado de varios ("eliminar los cuatro gastos"), ya arreglado y agregado como caso de eval (68 casos).
- **Webhook:** 91 eventos `done`, 3 `ignored`, 1 `failed` del 29/09 (el incidente de `key_strict_fifo` ya resuelto).

### S2 · 02/10/2026 · Caché del prompt de 1 hora

**Por qué:** las métricas de los primeros 4 días dieron 0,0088 USD por turno, 2,7 veces lo previsto. Con mensajes separados de 5 a 60 minutos el caché de 5 minutos vencía entre uno y otro y casi cada turno pagaba la escritura (0,0168 USD) en vez de la lectura (0,0035 USD).

**Cambio**
- `AnthropicLlmClient` marca los dos bloques de sistema con `cache_control: { type: "ephemeral", ttl: "1h" }`. Las herramientas van antes en el prefijo y quedan dentro del caché. Los dos breakpoints llevan el mismo TTL, como exige la API.
- Precio: la escritura de 1 hora cuesta 2 veces la entrada (Sonnet 5.5: 4 USD/M) contra 1,25 veces la de 5 minutos. El cliente lee `usage.cache_creation.ephemeral_1h_input_tokens` y `costFor` cobra cada parte a su tarifa, así `message.cost_usd` sigue siendo exacto.
- Variable `LLM_CACHE_TTL` en el worker (`1h` por defecto; `5m` vuelve al caché corto sin tocar código). Las evals usan `5m`: mandan turnos seguidos y ahí la escritura corta es más barata.
- Se paga solo si el mismo prefijo se reutiliza 3 o más veces por hora. Con el piloto de un negocio debería cumplirse en horas de trabajo.

**Cómo medirlo:** en una semana, `pnpm metrics 7` y comparar el costo promedio por turno con los 0,0088 USD de la línea base. Si no baja, volver a `LLM_CACHE_TTL=5m` en Railway.

### S2 · 02/10/2026 · Cobros fase 1: planes, pagos, tasa euro y panel de administración

**Decisiones de Javier:** pago móvil, Zelle y Binance; 14 días de prueba; 3 de gracia; al pasar el límite de mensajes el bot sigue y avisa. Javier planteó la brecha cambiaria: los servicios se pagan en dólares y un pago móvil a tasa BCV pierde ~90 Bs por dólar al comprar USDT. Datos del 01/10: dólar BCV 860,17, euro BCV 976,84, USDT Binance 957,66. Se cobra el pago móvil a tasa euro del BCV (ADR-015).

**Terminado**
- Migración 0007 (aditiva e idempotente): plan y vigencia en `tenant` (los existentes arrancan su prueba desde su alta; los nuevos, desde el registro), tabla `payment` con RLS, `bcv_rate.rate_eur` y `every_tenant_id()` para recorrer también los suspendidos.
- Tasa euro: el BCV la publica en el bloque `id="euro"` y DolarAPI en `/v1/euros/oficial` (solo si rige el mismo día). El respaldo completa el euro sin pisar el dólar del BCV.
- `packages/core/src/billing`: catálogo de planes (movido desde la web), estado calculado de la suscripción (prueba, activo, gracia, vencido, suspendido), monto a cobrar por método, registrar/aprobar/rechazar pagos con auditoría, uso del mes y la vuelta de cobros del housekeeping (suspende vencidos y avisa límites una vez por mes vía Sentry).
- El bot le responde a un negocio suspendido "Tu plan del asistente venció…" con el contacto de soporte, en vez del enlace de registro de un desconocido.
- Panel `/admin` (solo `PLATFORM_ADMIN_EMAILS`; los demás reciben 404): ingreso mensual, costos de IA y Meta por negocio y margen, cuánto cobrar por pago móvil hoy, pagos por verificar con Aprobar/Rechazar, ficha de cada negocio con números, registro de pagos, cambio de plan, extender días, suspender o reactivar e historial.
- QA en Postgres real con datos: la migración aplica sobre datos existentes; con el rol de la app solo se ven los pagos del propio negocio e insertar uno ajeno lo rechaza RLS; flujo de aprobar, registrar y monto ilegible probado con navegador a 390 y 1280 px sin desbordes. 238 tests.

**Pendiente (fase 2):** página "Mi plan" para que el cliente vea su vigencia y reporte el pago; recordatorio por WhatsApp 3 días antes (plantilla de utilidad aprobada por Meta); límite de números por plan al dar de alta empleados.

### S2 · 02/10/2026 · Alerta del monitor: `/api/health` en 503 con `db: false`

**Síntoma:** a las 07:34 UTC, unos minutos después del deploy de cobros, el monitor externo recibió 503 con `db: false` (la web no pudo consultar la base). El worker sí: terminó su housekeeping a las 07:35 UTC con el código nuevo, y la base respondía con 30 de 60 conexiones.

**Causa probable:** el pooler de sesión de Supabase admite 15 clientes por rol (ya anotado en `semana-1.md`) y había 15 conexiones de `caja_app` abiertas. En cada deploy conviven dos workers (hasta 6 conexiones cada uno) y la web abría hasta 3 por instancia sin soltarlas nunca: postgres.js no cierra conexiones inactivas por defecto, y una instancia de Vercel caliente o congelada retiene sus lugares. La consulta del health no toca las tablas migradas. No se pudo confirmar con los registros: Vercel no da acceso a los logs desde esta sesión y la API de logs de Supabase respondió con error.

**Mitigación en código:** la web usa 2 conexiones por instancia y las suelta a los 20 s de inactividad (`createDb(..., { max: 2, idleTimeoutSec: 20 })`). El worker no cambia. pg-boss ya suelta las suyas a los 10 s (valor por defecto de `pg`).

**Arreglo de fondo (Javier):** Supabase → Project Settings → Database → Connection pooling → Pool Size 30. Más adelante, evaluar el transaction pooler solo para la web.

**Pool Size a 30 (Javier, 02/10)** en Supabase. Además, el menú lateral muestra una sección "Plataforma" con "Consola de administración" solo a los correos de `PLATFORM_ADMIN_EMAILS`; los demás no ven el enlace y `/admin` les responde 404.

### S2 · 02/10/2026 · Consola con menú, colores de planes, Perfil y Mi plan

**Pedido de Javier** (captura del iPhone): la consola no tenía el menú lateral; colores distintos por plan y vencimientos en ámbar; una página de ajustes para que el usuario cambie su perfil y gestione su plan.

**Terminado**
- La consola usa el mismo menú lateral del dashboard (`lib/shell.ts` arma sus datos para los dos layouts), con contenido más ancho. El menú suma "Mi plan" con una etiqueta cuando hay algo que mirar ("prueba · 2 d", "vence en 4 d", "vencido").
- Colores de los planes: Personal azul, Negocio menta, Negocio Plus violeta (fichas, nombres y borde de las tarjetas). Vencimientos en ámbar; vencidos y suspendidos en rojo. El margen negativo se ve "−$0,12" en vez de "$-0,12".
- Ajustes → Perfil: nombre de la cuenta, que también es como el asistente llama al dueño por WhatsApp; correo y número de solo lectura; cerrar sesión.
- Ajustes → Mi plan: plan, estado, vencimiento y uso del mes; los tres planes con precio en dólares y en bolívares a tasa euro; cómo pagar por pago móvil, Zelle y Binance con los datos de `PAYMENT_PAGO_MOVIL`, `PAYMENT_ZELLE` y `PAYMENT_BINANCE`; formulario "Ya pagué" que deja el pago por verificar en la consola (`reportPayment`, auditado con canal `dashboard`, tope de 3 pendientes) e historial de pagos.
- QA con navegador a 390 px: menú en las cuatro pantallas, reporte que llega a la cola de la consola, nombre guardado, sin desbordes. 239 tests.

**Pendiente de Javier:** poner en Vercel `PAYMENT_PAGO_MOVIL`, `PAYMENT_ZELLE`, `PAYMENT_BINANCE` y `SUPPORT_HINT` (este último también en Railway). Sin ellos, "Mi plan" le pide al cliente escribir a soporte para recibir los datos.

### S2 · 02/10/2026 · Tasa euro en gastos y ventas por chat

**Síntoma (Javier, WhatsApp real):** "Necesito pagar en nómina 225.6$ a la tasa euro del día" quedó a tasa dólar (866,56), y al corregir con "Usa la tasa € del día de hoy" el bot respondió "No manejo la tasa del euro". La tasa euro que se agregó en la mañana solo se usaba para cobrar los planes, no en los movimientos.

**Arreglo**
- El campo `rate` de las herramientas acepta "euro" ("a tasa euro", "tasa €", "al euro del día"). `rateOverride` lo resuelve con `euroRateFor`: el euro BCV publicado en o antes de la fecha del movimiento. El monto sigue en su moneda: 225,60 $ a tasa euro 973,93 = Bs 219.718,19.
- Nuevo origen de tasa `bcv_eur` (migración 0008, aplicada en producción antes del deploy): el movimiento guarda la tasa euro y la fila de `bcv_rate` de donde salió. Los mensajes dicen "a tasa euro 973,93" y el detalle del dashboard "tasa euro".
- Funciona en gastos, varios gastos, ventas del día, ingresos sueltos y correcciones de lo guardado. Al corregir un borrador, el modelo ve la tasa que tenía ("euro" o el número) para no perderla.
- Antes del 02/10 no se guardaba el euro: para esas fechas el bot pide la tasa en vez de inventarla.
- Tests de punta a punta (borrador, guardado, corrección de un guardado, día sin euro) y cuatro casos de eval con los mensajes reales (72 casos).

### S2 · 02/10/2026 · Redacción de los borradores

Javier marcó que el borrador se leía mal: `*$10,00* (Bs 9.739,28 a tasa euro 973,93) · entendí dólares` en una sola línea. Ahora gastos, varios gastos, ventas del día e ingresos sueltos llevan un dato por línea y la tasa siempre nombrada (BCV, euro o manual):

```
*Gasto por confirmar*
Productos de limpieza: *$10,00*
Bs 9.739,28 · tasa euro 973,93
Categoría: Insumos
Fecha: hoy, vie 02/10
_No dijiste la moneda: lo tomé en dólares._
```

La aclaración de la moneda pasa a una nota al final. Las correcciones muestran "(tasa manual 850,00)" o "(tasa euro 973,93)". Tests de render y de punta a punta actualizados.

### S2 · 02/10/2026 · Montos en euros

**Síntoma (Javier, WhatsApp real):** "Registrar clases de pilates 15 euros , Gatorade 3$ y taxi 1900bs" registró las clases como $15,00 a tasa BCV ("No dijiste la moneda: lo tomé en dólares"). La moneda de las herramientas solo admitía USD y VES.

**Arreglo**
- La moneda de un monto acepta `EUR` ("15 euros", "15 €", "15 eur") en gastos, varios gastos, ventas del día e ingresos sueltos. No hay cuentas en euros: el monto se pasa a bolívares con el euro BCV de la fecha del movimiento y se guarda en Bs (su equivalente en $ sale a tasa BCV, como cualquier gasto en Bs).
- La descripción guarda de dónde salió: "Clases de pilates (15,00 € a tasa euro 976,84)". El borrador lo muestra igual: `1. Clases de pilates (15,00 € a tasa euro 976,84): *Bs 14.652,60* · Otros`.
- Distinto de "a tasa euro" (monto en $ o Bs con la tasa euro). El prompt explica la diferencia y que en una lista cada ítem lleva su moneda.
- Sin euro BCV para esa fecha (antes del 02/10) el bot pide el monto en dólares o en bolívares.
- Test de punta a punta con el mensaje real y tres casos de eval (75 casos); el eval compara la moneda de cada ítem con `item_currencies`. Sin migración.

### S2 · 02/10/2026 · Entrar con Google

- Botón "Continuar con Google" en /login, encima del magic link ("o con tu correo"). Usa el OAuth de Supabase con PKCE: la acción `signInWithGoogle` arma la URL y deja el verificador en una cookie; `/auth/callback` lo canjea por la sesión y manda a /inicio (sin negocio, a /registro, igual que el magic link).
- Misma cuenta con los dos métodos: Supabase vincula la identidad de Google al usuario que ya tenía ese correo, y `claim_account` cubre el caso de un id nuevo con el mismo correo.
- Cancelar en Google vuelve a /login con "No se completó la entrada con Google".
- Detrás de `GOOGLE_AUTH_ENABLED=1` (Vercel): sin el proveedor activo en Supabase el botón llevaría a un error, así que no se muestra hasta configurarlo.
- **Configuración (Javier):** cliente OAuth "Web" en Google Cloud con la redirección `https://daomgsvvhvuhiccttrlg.supabase.co/auth/v1/callback`; client ID y secret en Supabase → Authentication → Providers → Google; `https://caja.jpsoftwaredev.com/auth/callback` en Authentication → URL Configuration → Redirect URLs.

### S2 · 03/10/2026 · Presupuestos por categoría (ADR-016)

**Pedido (Javier):** presupuestos por categoría como en Rial, quincenales o mensuales, y que el bot diga cuánto queda.

**Qué se hizo**
- Migración 0009: tabla `app.budget` (categoría, período `monthly`/`biweekly`, tope en $), uno por categoría, con RLS y prueba de aislamiento. Aplicada en producción antes del deploy.
- Core: `budgetWindow` (mes calendario; quincenas 1–15 y 16–fin), `budgetStatuses` (lo gastado de cada tope en su ventana, en una consulta, solo gastos vivos), `setBudget` (crea, cambia o quita con auditoría `budget`).
- Bot, solo para el dueño:
  - Al guardar uno o varios gastos, una línea por presupuesto tocado: `Insumos: te quedan *$45,00* de $200,00 este mes.`, `⚠️ ... vas por el 85 %`, `🔴 ... te pasaste por *$12,00*`. Un gasto de otro período lo nombra ("en septiembre", "en la 2ª quincena de septiembre").
  - Herramienta `get_budgets`: "cuánto me queda en insumos", "cómo voy con los presupuestos" (con los días que faltan para reiniciar). "Ponle 200$ a insumos" manda al dashboard. El empleado recibe "Los presupuestos los ve el dueño".
- Dashboard: en Ajustes → Categorías, cada categoría tiene monto en $ y período (vacío lo quita) con la barra de lo gastado; Inicio muestra la tarjeta "Presupuestos" (verde, ámbar desde 80 %, rojo en el tope).
- **Bug viejo arreglado de paso:** el conteo de gastos por categoría en Ajustes → Categorías siempre decía "sin gastos". La subconsulta comparaba `m.category_id = "id"`, que Postgres resolvía como el id del movimiento. Ahora va calificada con la tabla; test que lo cubre.
- Tests: ventanas, redacción, cálculo, auditoría, RLS y de punta a punta (dueño, empleado, consultas). Cinco casos de eval nuevos (80 casos). QA a 390 px de las dos pantallas.

### S2 · 03/10/2026 · Facturas en PDF y fotos mandadas como documento

**Pedido (Javier):** que el bot lea documentos. Se acordó solo PDF de factura y fotos mandadas "como documento"; Word, Excel y demás no.

**Qué se hizo**
- WhatsApp: los mensajes `document` se normalizan con tipo, nombre de archivo y leyenda.
- Un PDF o una imagen (JPEG, PNG, WebP) mandados como documento siguen el mismo camino que la foto: acuse 🧾, lectura con el modelo, respaldo en el bucket (`.pdf` para los PDF), borrador con lo leído y Guardar/Corregir/Cancelar. El PDF va al modelo como bloque `document` en base64.
- Límites: 5 MB y hasta 5 páginas (contadas en el PDF sin librería; si las páginas van comprimidas no se ven y manda el tope de 5 MB). Un archivo que dice ser PDF y no empieza con `%PDF-` no se manda al modelo.
- Otro archivo: "No puedo leer "presupuesto.docx". De archivos solo leo facturas en PDF o en foto…", sin descargarlo.
- Dashboard: el detalle del movimiento dice "por PDF" y el botón abre el PDF.
- Textos de ayuda y de "no es factura" mencionan foto o PDF.
- **Producción:** el bucket `receipts` ahora admite `application/pdf` (cambiado antes del deploy; sin eso el respaldo del PDF fallaría y el gasto se guardaría sin adjunto).
- Tests: parseo, PDF de punta a punta, foto como documento, Word rechazado, PDF largo/pesado/falso, bloque `document` en la petición a Anthropic. 261 tests.

### S2 · 03/10/2026 · Reportes de ventas en PDF y ventas sin método

**Síntoma (Javier, WhatsApp real):** mandó "Detalles de ventas(149).pdf" de su propio negocio (Jp Car Wash) y el bot armó un *Gasto por confirmar* de $115,80. Al corregir con "No es un gasto es una venta" salió "Jp Car Wash: $115,80 por Sin especificar", y al tocar Guardar no se guardó.

**Causas y arreglos**
- El lector trataba todo documento como factura de compra. Ahora devuelve `document_type` (`expense`, `sales`, `unknown`) y recibe el nombre del negocio en el turno (no en el sistema, para no romper la caché): si el emisor es el propio negocio o el título habla de ventas o cierre, es `sales`. Un reporte de ventas va a `draft_income_day_total` y el mensaje dice "🧾 Leí el reporte de ventas: …".
- La leyenda que el usuario escribe junto a la foto o el PDF llega al agente y manda sobre lo leído ("esto es una venta").
- Las ventas (del día y sueltas) ahora llevan la foto o el PDF: el borrador guarda `attachmentId`, una corrección hereda el archivo del borrador que reemplaza (de cualquier tipo), Guardar lo vincula al movimiento y Cancelar lo borra.
- **Bug viejo:** `draft_income_single` aceptaba método "unspecified" y mostraba el borrador, pero la restricción `movement_income_needs_method` (0001) rechazaba el Guardar. La venta del día ya lo permitía. Migración 0010 la quita (aplicada en producción antes del deploy). El borrador ya no dice "por Sin especificar".
- Tests: reporte de ventas de punta a punta con PDF adjunto, corrección gasto → venta que conserva el PDF y guarda sin método, texto del agente para ventas y leyenda. Dos casos de eval nuevos (82). 264 tests.

**Pendiente conocido:** si el usuario manda la aclaración ("Ventas del día") como mensaje aparte mientras el PDF se lee, el bot la contesta sola. Mejor escribirla como leyenda del archivo.

### S2 · 03/10/2026 · Renovar el plan por el bot (ADR-015 fase 2)

**Pedido (Javier):** renovar el plan desde WhatsApp. Decisiones: funciona con el plan vencido, solo el dueño, referencia por texto (la foto del comprobante después), un mes del plan actual por defecto con meses y cambio de plan, aviso de "pago verificado" solo dentro de la ventana de 24 horas.

**Flujo**
1. "quiero renovar", "¿cuándo se me vence el plan?", "pásame a negocio plus 3 meses" → herramienta `renew_plan` → plan, vencimiento y monto por método (pago móvil a tasa euro, Zelle, Binance) con un botón por método. Con el plan vencido, "renovar", "pagar" o "plan" dan lo mismo sin pasar por el LLM; cualquier otra cosa responde "tu plan venció… escribe *renovar*".
2. Botón → datos de cobro y monto exacto; queda la intención `renew_plan` (48 h, fuera de la cola de borradores).
3. "ref 123456" (o el número solo, o "ya pagué 12345678" sin moneda, con la intención abierta) → pago pendiente con nota "Reportado por WhatsApp", auditado como teléfono por canal `whatsapp`, sin LLM. Sin intención: botones "¿Por dónde pagaste?" que reportan de un toque. Tope de 3 pendientes.
4. Aprobar o rechazar en `/admin` → el housekeeping (cada 5 min) manda "✅ Pago verificado. Tu plan Negocio quedó activo hasta el …" o "No pudimos verificar tu pago… Motivo: …" si el dueño escribió en 24 h; cada pago se avisa una sola vez (`payment.notified_at`).

**Cambios:** migración 0011 (`renew_plan` en `pending_action_kind_check`, `payment.notified_at`; los pagos ya revisados quedan marcados), `billing/renew.ts` y `renew-chat.ts`, `inbox/notices.ts`, la puerta de suspendidos deja pasar al dueño, `PAYMENT_*` también en el worker (Railway). La consola marca "por WhatsApp" y los meses.

**Tests:** extracción de referencias (un gasto con monto no es referencia), oferta y botones, intención, reporte sin LLM, cambio de plan y meses, empleado, plan vencido (sin LLM), tope de 3, avisos aprobado/rechazado una sola vez y fuera de la ventana. Cinco casos de eval nuevos (87). 272 tests.

### S2 · 03/10/2026 · Revisión completa del proyecto y QA de la web

**Cómo:** cuatro revisiones de código en paralelo (flujo de WhatsApp y agente; cobros y seguridad; dinero, tasas y fechas; web) y QA en navegador de las 30 rutas a 390 y 1280 px: estado HTTP, errores de consola, desborde horizontal, campos sin etiqueta, los 43 enlaces internos y los formularios de punta a punta (editar y borrar movimiento, perfil, negocio, reportar pago con tope, aprobar, rechazar, extender, números, exportar, cierres). Cada hallazgo se verificó en el código antes de tocarlo.

**Arreglado**
- *Seguridad:* las páginas y consultas de `/admin` verifican el administrador ellas mismas (antes solo el layout, que no se vuelve a renderizar en cada navegación). Los avisos `?error=` ya no muestran texto arbitrario de la URL. `/ir/constructor` y `in` sobre objetos usan `Object.hasOwn`. Un fragmento del texto del modelo ya no va a los logs.
- *Cobros:* aprobar y rechazar bloquean el negocio y solo cambian pagos pendientes (dos aprobaciones a la vez perdían meses; un rechazo podía pisar una aprobación). La vuelta de suspensión bloquea el negocio igual, así que no suspende a uno que acaba de pagar, y un negocio con error no frena a los demás. Los avisos de pago se marcan y confirman antes de enviarse (no se repiten si falla el commit). El pago móvil no usa una tasa euro de más de 7 días.
- *WhatsApp:* un envío sin respuesta de Meta (red, tiempo agotado) ya no deshace el turno ni lo reintenta (podía guardar dos veces y mandar dos "✅ Guardado"); un mensaje fuera de los límites se recorta en vez de dejar al usuario sin respuesta; la nota de voz no repite la transcripción. La venta del día se revisa de nuevo al Guardar (dos borradores del mismo día la sumaban dos veces). El empleado recibe "✅ Guardado." sin los totales del negocio y no puede reemplazar la venta del día. El modelo ya no ve dos veces el mensaje actual en notas de voz y fotos. "15 euros a tasa euro" no convierte dos veces. Ids de categoría inválidos no tumban el job.
- *Dinero:* una tasa manual con tres decimales ("189,385" → "189.385") ya no se lee como 189.385 Bs por dólar, y una tasa fuera de la mitad o el doble de la BCV se rechaza. Cambiar la fecha de un movimiento conserva la tasa euro o manual. DolarAPI en fin de semana guarda la tasa para el lunes. `parseVenezuelanAmount` devuelve null en vez de lanzar ("1,200.50"). Completar una venta en Bs no deja céntimos de diferencia. El signo negativo va antes del símbolo ("−$5,00"). El Excel muestra la tasa con todos sus decimales.
- *Web:* 404 propio en español y página de error con "Reintentar" dentro de la app. `?mes=2026-13` ya no da 500. Editar un movimiento no borra su categoría si está desactivada. La hora del movimiento usa la fecha de Caracas. Los errores de editar y borrar se muestran. Un monto armado a mano no da 500. El arranque de la cola en la web no queda roto tras un fallo. La cuenta regresiva del registro no desajusta la hidratación y deja de consultar al vencer el código. Exportar con un rango malo vuelve con aviso. Menú: un solo ítem activo y el cajón cerrado no recibe el foco. Campos con etiqueta.
- Tests nuevos: dos ventas del día en cola, tasa con tres decimales y tasa absurda, parser, fin de semana de DolarAPI. 276 tests.

**Pendiente (anotado, no urgente):** commit-then-send completo del turno (hoy se evita el reintento duplicado, pero el envío sigue dentro de la transacción); heredar la foto en las respuestas a botones de moneda y en `draft_expenses`; `pendingDrafts` sin filtrar vencidos hasta el housekeeping; una corrección por chat puede pisar una edición del dashboard hecha en esos minutos; límites de números y empleados por plan; reactivar o extender un negocio de cortesía (sin `paid_until`) lo trata como prueba; confirmación antes de "Suspender ahora"; el login toma el origen del encabezado (lo protege la lista de URLs de Supabase).

### S2 · 03/10/2026 · Factura ilegible: un solo mensaje y la respuesta va directo al borrador

**Reporte (Javier):** un ticket fiscal con los céntimos cortados en el borde (TOTAL Bs 12.955,1x) dio "No pude leer bien la factura. ¿Cuánto fue y en qué moneda?"; "12956 bs" → "¿Es un gasto o una venta?"; "Gasto" → "No entendí bien…". Tres mensajes y nada guardado.

**Causas**
1. El lector devolvió confianza 0,3 (log "factura leída" de las 14:17 UTC) y el bot descartaba la lectura y la foto.
2. La pregunta "¿En qué fueron esos 12956 Bs?" citaba una cifra del mensaje anterior; la validación de cifras inventadas solo miraba el mensaje del turno ("Gasto") y la cambiaba por "No entendí bien".

**Cambios**
- Factura ilegible → un solo mensaje: "🧾 No pude leer bien la factura. Me pareció ver un total de *Bs 12.955,10*, pero no estoy seguro. Escríbeme en *un solo mensaje*: si fue *gasto* o *venta*, el *monto con la moneda* y *en qué fue* y la guardo con la foto. Ejemplo: _gasto 12.955 Bs en comida_".
- La foto se guarda igual (provisional, el barrido la borra en una hora si no se usa). El saliente lleva la marca `receipt_unclear` en `tool_calls`; si lo siguiente que escribe o dice el usuario (dentro de 30 minutos) responde a eso, el agente recibe el contexto y registra directo: gasto por defecto, descripción "Factura" (o el proveedor) si no dice en qué, solo el monto que escribió el usuario. El borrador lleva la foto. Sin migración.
- Las cifras de una aclaración se validan contra este mensaje y los anteriores del usuario en la ventana del historial.
- Lector: céntimos cortados con la parte entera clara ya no bajan la confianza de 0,6 (el usuario confirma el borrador).

**Tests:** el caso "12956 bs → Gasto", el contexto en el turno, y la foto ilegible de punta a punta (mensaje, foto guardada, "12956 bs" → borrador → Guardar con la foto; el mensaje siguiente ya no hereda). Tres casos de eval nuevos (90). 279 tests.

### S2 · 03/10/2026 · Pedir el enlace del dashboard por chat

**Pedido (Javier):** "Link del dashboard" respondía "Eso todavía no lo hago por chat".

**Cambios:** palabra clave `dashboard` sin LLM para mensajes cortos sin cifras que nombran dashboard, panel, link, enlace, página o web ("link del dashboard", "pásame el enlace", "¿cuál es la página?"); "el link de pago" o "pagué 20$ de la página web" no cuentan. Las frases libres ("¿dónde veo mis gastos en la computadora?") van por el agente: `reject_out_of_scope` con `reason: dashboard_link` manda el enlace. Respuesta: "📊 Tu dashboard: …", qué se hace ahí y cómo entrar (correo con enlace). El empleado recibe "El dashboard lo ve el dueño del negocio".

**Tests:** palabras clave (incluidos los que no deben contar), el mensaje de punta a punta, la razón del agente para dueño y empleado. Dos casos de eval nuevos (92). 286 tests.

### S2 · 03/10/2026 · Calculadora de monedas y pago móvil desde foto

**Pedido (Javier):** "cuánto es 8000 bs en $", "17€ en bs", "15$ en bolívares"; y mandar la foto de unos datos de pago móvil para recibirlos escritos, listos para pegar en el banco, y de una vez registrar el gasto.

**Calculadora:** herramienta `convert_currency` (13 herramientas) con monto, moneda de origen, destino (`auto`: Bs → $, $ o € → Bs) y tasa opcional. Bs ↔ $ con la BCV del día, € con el euro BCV, "a 220" con esa tasa (entre la mitad y el doble de la BCV) y "a tasa euro". $ ↔ € pasa por bolívares con las dos tasas oficiales. Bs → $ muestra también el equivalente en euros. No registra nada. Ej.: "🧮 Bs 8.000,00 son *$9,32* (≈ 8,33 €)" y la tasa con su fecha debajo. Regla 6b del prompt.

**Pago móvil:** el lector de facturas reconoce los DATOS para pagar (`document_type: pago_movil` con `payee`: banco, teléfono, cédula o RIF, titular); un comprobante de un pago ya hecho sigue siendo gasto. El backend normaliza (código de banco de la Sudeban por nombre o apodo, teléfono a 11 dígitos, cédula sin puntos, nunca inventa dígitos) y responde:
1. Resumen: banco con código, teléfono, cédula/RIF, titular y monto (en $ se pasa a Bs a tasa BCV).
2. Un mensaje por dato (teléfono, cédula, monto "1250,00") para copiar con un toque.
3. Con monto: el borrador de gasto "Pago móvil a <titular>" (o la leyenda) con la foto, encabezado "💸 ¿Es un gasto? Si lo es, toca *Guardar* cuando hagas el pago". Sin monto: pregunta monto y en qué es, y la respuesta siguiente arma el gasto con la foto (el mismo mecanismo de la factura ilegible, con `source: pago_movil`).
Si no se leen al menos dos de banco, teléfono y cédula, pide una foto más clara. "Ayuda" menciona las dos funciones.

**Tests:** conversiones (Bs→$ con €, €→Bs, $→Bs con BCV, tasa propia y euro, $→€, errores), normalización de bancos, teléfonos y cédulas, y los flujos de punta a punta (con monto y Guardar con la foto, en dólares, sin monto con la respuesta, ilegible). Ocho casos de eval nuevos (100). 317 tests. El límite de mensajes por teléfono se sube en el test de fotos (todos los casos comparten teléfono y reloj).

**Sin probar con el modelo real:** que el lector distinga bien una foto de datos de pago móvil de un comprobante. Correr `pnpm evals` y probar con fotos reales.

### S2 · 03/10/2026 · Incidente: el agente caído por la gramática de herramientas estrictas

**Qué pasó:** después del despliegue de la calculadora (16:08 UTC) cada mensaje que pasaba por el agente respondía "Ahora mismo no puedo procesar esto". La API devolvía 400: "The compiled grammar is too large… reduce the number of strict tools". Con la herramienta 13 (`convert_currency`) el conjunto estricto pasó el tope de la API. El lector de facturas (una sola herramienta, otra llamada) siguió funcionando. Lo vio Javier a las 16:20 con un comprobante de Bancamiga.

**Arreglo:** `ToolSpec.strict: false` para las herramientas de esquema trivial (`reject_out_of_scope`, `get_bcv_rate`, `convert_currency`); Zod las sigue validando y un argumento inválido tiene su reintento. Quedan 10 estrictas. `STRICT_TOOL_LIMIT = 12` (el último conjunto aceptado en producción) y un test que falla si se pasa, porque los tests con LLM falso no ven este error.

**Lección:** un cambio en las herramientas del agente se prueba contra la API real antes de subir (`pnpm evals` o una llamada de humo), no solo con el LLM falso.

### S2 · 03/10/2026 · Reenvío con texto aparte: la leyenda se une a la foto

**Reporte (Javier):** al reenviar un comprobante con "Registrar compra de cepillos y pala", WhatsApp manda el texto como mensaje aparte y lo entrega ANTES que la foto (la imagen tarda en subir). La cola por teléfono los atiende en ese orden: el bot preguntaba "¿Cuánto pagaste…?" y luego armaba el borrador de la foto como "Factura", sin la descripción.

**Cambios (opciones 1 + 2 acordadas)**
1. *Esperar la foto:* si un texto sin cifras iba a recibir una pregunta (`ask_clarification`), el job espera hasta 6 s (`captionWaitMs`) sondeando `webhook_event` en la misma transacción por una foto o PDF del mismo remitente que siga en cola. Si llega, el texto no se contesta. Los textos con monto o que no dan pregunta no esperan.
2. *Unir después:* al leer una foto sin leyenda, si el mensaje entrante anterior (menos de 2 min) es un texto sin cifras que no se contestó o se contestó solo con una pregunta, se usa como leyenda. Con leyenda, el lector pide usarla como descripción corta ("Cepillos y pala") y categoría.
3. *Foto primero:* un texto sin cifras justo después de una foto que quedó en borrador lleva contexto al agente para corregir la descripción de ese borrador (corrects_draft, conserva la foto); una pregunta como "cómo va el mes" lo ignora.

**Tests:** los cuatro casos (foto durante la espera, foto tarde, texto con monto que no espera, foto primero). Tres casos de eval nuevos (103). 323 tests.

### S2 · 03/10/2026 · Fechas de facturas en día/mes y la foto se conserva tras una pregunta

**Reporte (Javier):** un ticket de McDonald's con fecha "03/10/2026" se leyó como 10 de marzo (formato de EE. UU.); el bot preguntó "¿El gasto fue el 2026-03-10? Es de hace más de un mes". Con "El gasto es del día de hoy" armó el borrador, pero sin la foto.

**Cambios**
- Lector: regla explícita "en Venezuela las fechas van día/mes/año" en el prompt y en la descripción del campo.
- Red de seguridad `fixDayMonth`: si la fecha leída queda en el futuro o a más de un mes y con día y mes al revés cae dentro del último mes, se voltea antes del agente ("2026-03-10" con hoy 03/10 → "2026-10-03"). Si volteada tampoco sirve, queda como vino y el agente pregunta.
- Si el agente pregunta algo sobre una factura leída (fecha, moneda) en vez de armar el borrador, el saliente lleva la marca `receipt_unclear` con `source: receipt_question`; la respuesta siguiente registra con lo leído y lo que diga el usuario, y hereda la foto.

**Tests:** `fixDayMonth` (volteos válidos y los que no), fecha volteada de punta a punta, pregunta de fecha → respuesta → borrador con la foto. Un caso de eval nuevo (104). 326 tests.

### S2 · 04/10/2026 · Fin de semana a la tasa del lunes

**Reporte (Javier):** el sábado y el domingo el bot calculaba a la tasa del viernes; en Venezuela el fin de semana se cobra a la tasa del próximo día hábil, que el BCV publica el viernes en la tarde.

**Cambios**
- `rateFor`, `euroRateFor` y `getRateInfo` (bot, calculadora, dashboard, "Tasa BCV hoy"): 1) la tasa del mismo día; 2) si el día no tiene publicación propia (sábado, domingo o feriado), la del próximo día hábil ya publicada, hasta 4 días adelante (Carnaval, Semana Santa); 3) si aún no está, la última anterior; 4) sin historia, la más antigua posterior. El euro solo salta si el día no tiene ninguna fila (un día hábil con dólar y sin euro no toma el euro de otro día).
- El error de una fuente de tasa registra la causa de undici (`fetch failed (CÓDIGO)`).

**Hallazgo en producción:** no hay fila del lunes 05/10. El BCV directo falla en cada intento con "fetch failed" desde el 30/09 (probablemente el certificado TLS de bcv.org.ve; el log nuevo dirá la causa) y DolarAPI solo cambia de tasa cuando empieza su fecha valor (todo el fin de semana devuelve la del viernes). Sin la fuente del BCV, la regla nueva no tiene la tasa del lunes hasta el lunes. Pendiente: arreglar la conexión al BCV.

**Tests:** fin de semana con y sin el lunes publicado, feriado entre semana, euro, "vigente hoy" y "próxima", el euro que no salta, el gasto de domingo en el ledger, la causa del error. 328 tests.

### S2 · 04/10/2026 · El BCV directo: certificado intermedio por AIA

**Diagnóstico:** con el log nuevo, un fetch manual (job encolado en `pgboss.job`) dio `fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)`: bcv.org.ve no manda su certificado intermedio y Node rechaza la conexión. Por eso el BCV falló en cada intento desde el 30/09 y la tasa del lunes (que el BCV publica el viernes) nunca llegaba; DolarAPI solo cambia cuando empieza la fecha valor.

**Arreglo:** `rates/aia.ts`. Si el fetch normal falla por cadena incompleta, se lee la dirección "CA Issuers" (AIA) del certificado del servidor, se descarga el intermedio y se repite la petición con `https` y `ca = raíces del sistema + intermedio`: la cadena se sigue verificando hasta una raíz de confianza (lo mismo que hacen los navegadores). El intermedio queda en memoria. Solo la lectura de la dirección abre una conexión sin verificar, y de ella no se usa nada de la página.

**Confirmado en producción (04/10, 01:41 UTC):** primero el lector no encontraba el bloque del dólar; con la respuesta descomprimida y el lector más tolerante, el BCV guardó la tasa del lunes 05/10 (USD 871,3689 · EUR 981,1788, fuente `bcv`). Desde ahora la tasa del lunes entra el viernes en la tarde (cron cada 30 min de 15:00 a 20:30 Caracas, lunes a viernes, más las 08:00 todos los días) y el fin de semana la usa.

### S2 · 04/10/2026 · Cambios USDT: gastos en Bs a la tasa a la que cambiaste (lotes FIFO)

**Pedido (Javier, para un amigo que cobra por Binance):** registrar sus gastos sin sacar la calculadora. Cobra en USDT, los cambia a Bs y paga en Bs; quiere saber cuánto le costó cada gasto en USDT, no a la BCV. Decisiones: el negocio elige cómo van sus Bs (BCV, siempre de sus cambios o preguntar cada vez, con botones Mi cambio USDT / Tasa BCV antes del borrador); los totales quedan en dólares = USDT; para todos los planes (enfocado en el personal).

**Diseño:** cada cambio es un **lote** (USDT, Bs recibidos, tasa, saldo). Un gasto en Bs toma del lote más viejo con saldo (FIFO); si cruza dos lotes queda a la tasa ponderada y el total en dólares cuadra al centavo; si los lotes no alcanzan, lo que falta va a la tasa del último cambio y se avisa. `exchange_allocation` dice qué lote pagó cada gasto: borrar el gasto devuelve sus Bs; corregirlo devuelve y vuelve a tomar (pasarlo a dólares los suelta y usa la BCV). La tasa se recalcula al Guardar con los lotes bloqueados (`FOR UPDATE`).

**Cambios**
- Migración 0012 (aplicada en producción antes del push): `tenant.bs_rate_mode` (bcv/usdt/ask), `exchange_lot` y `exchange_allocation` con RLS por negocio, `rate_source` 'exchange' (sin `bcv_rate`), `pending_action` kind `create_exchange`.
- `ledger/exchange.ts`: `planAllocation`, `saveAllocation`, `releaseAllocation`, `completeExchange` (dos de tres datos), `implausibleExchangeRate` (fuera de ½–3× la BCV), lotes, modo.
- Borradores: `bsRate` exchange/ask; un borrador de varios no cuenta dos veces los mismos Bs; `applyBsChoice` para la respuesta del modo preguntar. `amendMovement` y `deleteMovement` (chat y dashboard) devuelven y retoman.
- Bot: herramienta `exchange_usdt` (sin strict; 14 herramientas, 10 estrictas) para registrar ("cambié 100 usdt a 970", "vendí 50 usdt y me dieron 48.500") y ver el saldo; borrador del cambio con Guardar; al guardar el primer cambio de un negocio a la BCV, botones Siempre / Preguntarme / No, tasa BCV. Borrador de gasto: "$10,00 · tasa de tu cambio 970,00 · Quedarán Bs 87.300", aviso si no alcanza; al guardar, "Te quedan Bs X de tus cambios". Regla 6c del prompt; "usdt" = USD; "ayuda" lo menciona.
- Dashboard: Ajustes → Cambios USDT (saldo, registrar con USDT + tasa o Bs recibidos, lista con saldo por cambio, borrar uno sin usar); Negocio → "Tasa para tus gastos en bolívares"; el movimiento muestra "tasa de tu cambio".
- QA en navegador (390 px): el formulario leía "49.250" como 49,25 y aceptaba una tasa de 0,99 → montos con la regla venezolana primero y la misma validación de tasa que el bot. Títulos de la lista acortados ("50 USDT a 985").

**Tests:** núcleo (FIFO, ponderada, faltante, devolver al borrar y corregir, borrador múltiple, modo preguntar, borrar cambio usado), flujo por WhatsApp de punta a punta (registrar, modo, gastar, preguntar, saldo, tasa absurda), ajustes. Cinco casos de eval nuevos (109). 349 tests.

### S2 · 04/10/2026 · Captura de Binance → cambio

**Pedido (Javier):** que el bot reconozca la captura de la orden P2P de Binance ("Order Details · Sell USDT · Fiat Amount Bs30,000 · USDT Price Bs973.15 · Total Quantity 30.88 USDT") como un cambio, sin escribirlo.

**Cambios:** el lector de fotos tiene `document_type: usdt_exchange` y `exchange` (side sell/buy, usdt_amount, fiat_amount, price), con la regla de que Binance escribe los montos en formato inglés (coma de miles, punto decimal). La foto no se guarda ni pasa por el agente: sale "🧾 Leí tu cambio de Binance:" + el borrador del cambio con Guardar. La tasa es Bs ÷ USDT reales (30.000 ÷ 30,88 = 971,50), no el "USDT Price" (973,15): la diferencia es la comisión y lo que importa es cuánto USDT costaron esos Bs. Fecha de la orden si se ve y es del último mes; si no, hoy. Una compra de USDT (Buy) se explica y no arma nada; montos ilegibles o tasa absurda piden escribirlo.

**Tests:** venta → borrador a 971,50 sin foto → Guardar crea el lote; compra → aviso. 351 tests. **Sin probar con el modelo real:** la lectura de la captura verdadera.
- Segunda muestra (04/10): la pantalla de éxito "Bs 30,000 · Successfully sold 30.92 USDT" (o "Vendiste…") también cuenta; no trae precio y la tasa sale de USDT y Bs (970,25). Test agregado.

### S2 · 04/10/2026 · Desglose cuando un gasto toma de dos cambios

**Reporte (Javier):** "gasté 97.000 bs en mercancía" salió "$99,85 · tasa de tu cambio 971,48" y no se entendía de dónde venía 971,48 (la tasa ponderada de Bs 87.300 a 970 y Bs 9.700 a 985). Ahora, cuando el gasto toma de dos o más cambios, el borrador muestra "$99,85 · de tus cambios:" y una línea por cambio ("• Bs 87.300 a 970 → $90,00"); con uno solo sigue "tasa de tu cambio 970,00". El borrador guarda las partes (`exchange.parts`). Test del caso. 352 tests.


### S2 · 04/10/2026 · Cuentas (fase 1, como Rial)

**Pedido (Javier):** que el dinero viva en cuentas (Banco de Venezuela en Bs, Binance en USDT, Zelle, Efectivo) para que cada bolívar salga de una cuenta concreta y no haya diferencias entre la tasa del cambio y la BCV. Decisiones: los Bs que ya hay al crear una cuenta valen a la BCV del día; el total muestra los Bs a la BCV de hoy; las cuentas son opcionales para todos (negocios incluidos).

**Diseño**
- Saldo de una cuenta = saldo inicial + ventas − gastos + cambios recibidos − cambios enviados, todo en SQL. Un movimiento en otra moneda cuenta por su equivalente (un gasto en $ pagado con pago móvil resta sus Bs).
- Los lotes de 0012 pasan a ser **por cuenta**. En una cuenta en Bs cada bolívar tiene su costo: un cambio (a su tasa), una venta en Bs (a la tasa de la venta) o el saldo inicial (a la BCV del día de apertura). Un gasto de una cuenta en Bs siempre toma de sus lotes (aunque vaya a la BCV), así quedan al día si el negocio cambia de modo; la tasa del gasto sigue saliendo de `bs_rate_mode`.
- La primera cuenta en Bs **adopta** los cambios de antes de las cuentas (`adopted_at`): sus Bs restantes son parte del saldo inicial (no se suman dos veces) y solo el resto va a la BCV. Si el saldo inicial es menor, se recortan del más viejo.
- **A qué cuenta va**, sin preguntar: (1) una cuenta de esa moneda nombrada en el mensaje ("con Banesco", "el BDV" por los apodos de bancos del pago móvil); (2) el método o las palabras (pago móvil/punto → banco, efectivo, Zelle, Binance); (3) una de otra moneda nombrada ("pagué 10$ con Banesco"); (4) la principal de la moneda (la primera). El borrador muestra "Cuenta: X" y se corrige diciendo "fue de Banesco" (borrador) o "ese fue del efectivo" (ya guardado, por `amend_last_movement` sin campo nuevo). Sin preguntas ni campos estrictos nuevos: 16 herramientas, 10 estrictas.

**Cambios**
- Migración 0013: `account` (RLS, nombre único por negocio entre las activas), `movement.account_id`, `exchange_lot.account_id/from_account_id/source/movement_id/adopted_at`.
- `ledger/accounts.ts`: saldos, patrimonio, crear (con adopción y lote inicial), editar saldo inicial (ajusta su lote), archivar, `syncIncomeLot` (crear, corregir, borrar o reemplazar una venta en Bs), `resolveAccount`.
- Borradores, guardado, corrección y borrado llevan la cuenta; un cambio sale de la cuenta en dólares (Binance primero) y entra al banco en Bs. Al guardar: "💳 Banesco: *Bs 9.500,00*". El desglose de un gasto dice de dónde vino cada parte ("cambio 03/10", "venta 02/10", "saldo inicial").
- Bot: `get_accounts` ("mis cuentas", "cuánto tengo en Binance") y `create_account` ("crea la cuenta Banesco en bolívares con 5.000"), solo el dueño y sin strict. Regla 6d del prompt, cuentas en el bloque del negocio, línea en "ayuda". La captura de Binance también elige las cuentas.
- Dashboard: Ajustes → Cuentas (total con los Bs a la BCV de hoy, saldo por cuenta, crear, editar, archivar); Cambios elige de qué cuenta a cuál y lo muestra en la lista; el movimiento muestra y cambia su cuenta (solo cuentas del negocio).
- QA en navegador (390 px): crear, nombre repetido, saldo ilegible, editar saldo inicial, cambio entre cuentas, asignar cuenta a un gasto (tomó sus Bs de los lotes). Sin scroll horizontal.

**Tests:** núcleo (adopción con y sin recorte, saldos con monedas cruzadas y cambios, patrimonio, lote de venta al crear/corregir/borrar, lotes por cuenta, mover un gasto de cuenta, saldo inicial, archivar, nombres repetidos, resolución de cuenta) y el flujo por WhatsApp (crear por chat, gasto con su saldo, corregir la cuenta de lo guardado, cambio entre cuentas, "mis cuentas"). Siete casos de eval (116). 370 tests.

**Fase 2 (pendiente):** transferencias entre cuentas de la misma moneda, comisiones, reportes por cuenta.

### S2 · 04/10/2026 · Cuentas (fase 2): transferencias, comprar USDT, comisiones y estado de cuenta

**Pedido (Javier):** seguir con la fase 2 de cuentas.

**Diseño**
- **Transferencia** entre cuentas: no es gasto ni venta, solo cambia dónde está el dinero. Misma moneda ("pasé 100$ de Zelle a Binance", "del BDV a Banesco") o **Bs → USDT** (comprar USDT con bolívares). Dólares → Bs sigue siendo un cambio (lote); si el bot o el usuario lo piden como transferencia, sale el borrador de cambio con esas cuentas.
- Entre cuentas en Bs los bolívares **se llevan su costo**: salen de los lotes de la cuenta de origen (`exchange_allocation.transfer_id`) y entran como lote `transfer` de la de destino a esa tasa. Comprando USDT, los Bs salen de los lotes del banco.
- La **comisión** es un gasto aparte de la cuenta de origen ("Comisión Zelle → Binance", categoría que diga comisión o banco, si no Otros), para que cuente en los gastos del negocio.
- Borrar una transferencia devuelve los Bs a sus lotes, quita el lote de destino y la comisión; si un gasto ya usó esos Bs, no se puede (como un cambio usado).
- **Estado de cuenta**: cada cosa que movió la cuenta (saldo inicial, gastos, ventas, cambios, transferencias) con el saldo después, como el extracto del banco, y lo que entró y salió en el mes.

**Cambios**
- Migración 0014: `account_transfer` (RLS), `exchange_allocation.transfer_id` (de un gasto o de una transferencia), `exchange_lot.transfer_id` y origen `transfer`, `pending_action` kind `create_transfer`.
- `ledger/transfers.ts` (`transferAmounts`, `createTransfer`, `deleteTransfer`); saldos con transferencias; `accountStatement`; `accountFromWords`.
- Bot: `transfer_between_accounts` (dueño, sin strict; 17 herramientas, 10 estrictas) con borrador y Guardar; al guardar, el saldo de las dos cuentas. Si el modelo da los montos de una compra de USDT al revés, se voltean (los Bs siempre son más). La captura de **compra** de USDT en Binance, con cuentas, es una transferencia del banco a Binance (sin cuentas explica cómo crearlas). `get_accounts` con `account` da el detalle de una ("cómo va Banesco": saldo, el mes y lo último). Regla 6d ampliada.
- Dashboard: cada cuenta abre su estado de cuenta (enlace a cada movimiento, borrar transferencias); formulario "Pasar dinero entre cuentas" con comisión; columna Cuenta en el Excel.
- QA en navegador (390 px): transferencia con comisión, compra de USDT, compra sin USDT recibidos, dólares → Bs (manda a Cambios), misma cuenta, estado de cuenta y borrar. Corregido: el mes salía "2026-10" y la compra mostraba "50,00" sin "USDT".

**Tests:** núcleo (montos por moneda, comisión como gasto, Bs con su costo, compra de USDT, errores, extracto con saldo por línea, borrar) y WhatsApp (transferencia con comisión, compra de USDT con montos al revés, detalle de una cuenta, captura de compra con cuentas). Cinco casos de eval (121). 381 tests.

### S2 · 04/10/2026 · "¿Cuáles son tus funciones?" responde la ayuda completa

**Reporte (Javier):** "Cuáles son tus funciones" caía en fuera de alcance: "Solo te ayudo con tu caja: registrar gastos, registrar ventas y ver el cierre", un mensaje viejo que no nombra la tasa, la calculadora, los cambios ni las cuentas.

**Cambios:** "tus funciones", "qué sabes/puedes hacer", "para qué sirves", "cómo te uso" (mensaje corto, sin cifras) van directo a la ayuda, sin pasar por el modelo; si el modelo lo recibe igual, `reject_out_of_scope` tiene `reason: help` y manda la ayuda. La ayuda suma presupuestos, cuentas ("cómo va Banesco"), transferencias y corregir/borrar. El mensaje de fuera de alcance y el de "todavía no lo hago" nombran todo y dicen "escribe *ayuda*". La descripción de fuera de alcance ya no lista presupuestos como algo que no existe. Tests de palabras clave y de la razón help; un caso de eval (122).

### S2 · 04/10/2026 · Primera corrida de evals con el modelo real

Javier corrió `pnpm evals` con claude-sonnet-5-5: **97/97 pasaron** (incluidos los 12 de cuentas y transferencias y el de "tus funciones"), costo 0,50 USD. Los otros 25 (renovar, tasa euro, tasa, ventas, voz) no llegaron a correr: tocaron el tope `EVALS_MAX_USD` de 0,50. Con 122 casos la corrida completa cuesta ~0,63 USD, así que el tope por defecto sube a 1,00.
- Segunda corrida (05/10, solo renovar, tasa, ventas y voz): 27/30, costo 0,14 USD. Las 3 fallas eran del eval, no del bot: esperaban el formato viejo del borrador de venta ("Total *$350*", "Pago Móvil · *Bs …*") y el mensaje ahora usa dos puntos. Expectativas actualizadas. Con eso las 122 pasan con el modelo real.

### S2 · 05/10/2026 · Entrar con Google activado

Javier configuró la pantalla de consentimiento y el cliente OAuth en Google Cloud, y el proveedor Google y la URL de retorno en Supabase. `GOOGLE_AUTH_ENABLED=1` en Vercel (producción y preview) y panel desplegado de nuevo: /login muestra "Continuar con Google". Prueba de punta a punta: Javier desde su teléfono.

### S2 · 05/10/2026 · Nueva entrada y onboarding paso a paso (como Rial)

**Pedido (Javier):** la página de entrada se veía plana y el registro era un formulario. Referencia: el onboarding de Rial (barra de progreso, tarjetas grandes con ícono, categorías elegibles, "Primeros pasos"). Decisiones: web primero y después el registro por WhatsApp; categorías en lista simple con íconos (sin subcategorías); quien se registre por chat dará su correo para entrar al panel.

**Entrada (/login):** a la izquierda (arriba en el teléfono) el título "Tu caja, en un chat de WhatsApp", una conversación de ejemplo (gasto por confirmar y "cómo va el mes") y chips de funciones; a la derecha la tarjeta para entrar (Google o correo), los 3 pasos y "gratis durante el piloto". En el teléfono el formulario va antes que la demo.

**Registro (/registro), 6 pasos con barra de progreso y botón redondo:**
1. Plan: Personal, Negocio o Negocio Plus, con precio y lo que incluye (14 días de prueba; el piloto no cobra).
2. Perfil: Personal pide tu nombre y la moneda; un negocio pide nombre, tipo (tarjetas con ícono), tu nombre y la moneda.
3. Categorías: las del tipo marcadas, se quitan con un toque, "Más ideas" en chips y una propia; máximo 10 con Otros.
4. Cuentas (opcional): banco en Bs, Binance, Zelle, efectivo $ o Bs, con nombre y saldo de hoy (hasta 3).
5. WhatsApp: el número y un resumen de lo elegido.
6. Código: botón verde "Enviar el código por WhatsApp" con el código ya escrito; al vincular, "Ver qué puedo hacer".

**Inicio:** con `?bienvenida=1`, una tarjeta con las 6 funciones del asistente y "Abrir WhatsApp". Tarjeta "Completa los primeros pasos" (vincular, crear una cuenta, primer gasto, primera venta o ingreso) que se va tachando y desaparece al completar.

**Núcleo:** migración 0015 (tipo de negocio `personal`, aplicada en producción antes del push), categorías del plan Personal y sugerencias; `registerBusiness` recibe plan, categorías (`onboardingCategories`: sin repetidas, Otros al final, máximo 10) y cuentas iniciales.

**QA en navegador (390 px y escritorio):** entrada, los 6 pasos con plan Personal y con Negocio (categoría quitada, idea agregada, propia agregada, dos cuentas), datos guardados bien, bienvenida y primeros pasos. Corregido en QA: la clase `.cat` chocaba con la de Ajustes (tarjetas gigantes); el formulario de entrada quedaba muy abajo en el teléfono.

**Prueba con fecha fija:** `renew.test` empezó a fallar hoy: los mensajes guardan la hora real y el reloj de la prueba (03/10 + 2 días) ya la alcanzó. El salto ahora parte de la hora más tardía.

### S2 · 06/10/2026 · Tope de gasto de la prueba gratis

**Pedido (Javier):** un tope exacto para que una prueba gratis no cueste más de lo previsto. Decisiones: 1,50 USD en Personal, 4 en Negocio y 8 en Negocio Plus; al llegar, el bot para y ofrece activar el plan, y el administrador puede darle más.

**Qué se cuenta** (`billing/trial.ts`, desde que se registró el negocio): la IA de cada turno (`message.cost_usd`, agente y lectura de fotos, exacto) + cada respuesta entregada sin reacciones a 0,0113 USD (tarifa de Meta, ADR-014; se cuenta aunque caiga en las 1.000 gratis del mes: el tope es el peor caso) + 0,003 USD por nota de voz (Deepgram). Solo mientras `status = trial`; al pagar desaparece.

**Al llegar al tope:** el mensaje se guarda pero no pasa por el LLM ni por la transcripción. El dueño recibe "Llegaste al límite de uso de tu prueba gratis… escribe *renovar*" una vez al día (cada respuesta también cuesta; el resto del día, silencio) y renovar sigue funcionando (palabras, botones y referencia del pago, sin LLM). Un empleado recibe "avísale al dueño".

**Migración 0016** (aplicada en producción antes del push): `tenant.trial_budget_usd` (tope propio; null = el del plan), `tenant.trial_cap_notified_at` e índice `message (tenant_id, created_at)` para la suma. Los 4 negocios del piloto, creados antes del tope, quedan con 20 USD: el más activo ya llevaba ~2,44 USD en 7 días (1,00 de IA y 127 respuestas) y con 4 se habría cortado antes de terminar su prueba.

**Administrador:** la ficha del negocio muestra "Prueba: $gastado de $tope (IA · Meta · voz)" y un campo "Tope de prueba (USD)" (vacío = el del plan; queda en el historial). El housekeeping avisa por Sentry una vez cuando una prueba llega al tope; si se cambia el tope, vuelve a avisar.

**Usuario:** en Ajustes → Mi plan, durante la prueba la barra muestra el uso incluido ("llevas el 59 %") y, al llegar, que el asistente dejó de registrar y cómo pagar.

**Tests:** suma de costos (sin reacciones ni envíos fallidos), tope por plan y propio, aviso al administrador una sola vez; en el inbox, sin registro ni LLM, aviso una vez al día, renovar sí y el empleado. QA en navegador: Mi plan y la ficha del administrador con un tope de 2 USD (llegó) y vuelta al del plan.

### S2 · 06/10/2026 · Eliminar un negocio, papelera de 15 días y retención por impago

**Pedido (Javier):** borrar la cuenta del número 584127806000 ("Cinnamon rolls (piloto 2)", correo jpaxieacademy@gmail.com, vacía) y tener la función para no hacerlo a mano. Después: que lo eliminado se guarde al menos 15 días por si fue un error, y decidir cuánto guardar los datos de quien deja de pagar. Decisiones: papelera de 15 días; impago, 90 días con avisos y luego papelera; Cinnamon rolls se borra ya. `/eliminar-datos` (la que pide Meta) prometía "eliminar mi cuenta" por WhatsApp y no existía.

**Migración 0017:**
- `tenant`: `deleted_at`, `purge_after`, `deletion_reason` (owner | admin | unpaid), `suspended_at`, `retention_notices`.
- `resolve_phone` y `memberships_for_user` devuelven estado `deleted` para un negocio en la papelera (la columna `status` no cambia, así recuperar lo deja como estaba).
- `app.erase_tenant(id)` SECURITY DEFINER: el rol de la app no tiene DELETE (todo es borrado lógico), así que la función borra en una transacción todas las filas del negocio en orden de dependencias, los eventos del webhook de sus mensajes y números, los avisos a desconocidos y los usuarios del panel que quedan sin negocio ni registros. Solo actúa sobre el tenant fijado con `withTenant`. Devuelve las fotos y los usuarios de Supabase Auth a borrar, que se limpian después del commit (`cleanupErased`).
- Aplicada en producción por partes: columnas, restricción y las dos funciones por MCP; `erase_tenant` lleva `DELETE` y el MCP de Supabase retiene toda sentencia destructiva esperando una confirmación que no llega (se cancela a los 60 s, incluso `delete … where false`), así que Javier la pega en el SQL Editor.

**Papelera (15 días):** pedir la eliminación solo marca el negocio. El bot y el panel dejan de usarlo: el dueño solo puede recuperarlo (*recuperar mi cuenta* por WhatsApp, botón en `/recuperar` del panel o "Recuperar" del administrador); el resto recibe "en proceso de eliminación". Al vencer, el housekeeping lo borra para siempre.

**Impago (90 días):** `setTenantBilling` guarda `suspended_at` al suspender y lo limpia al reactivar. El housekeeping (`retentionSweep`) avisa a los 60 y 83 días y al día 90 lo pasa a la papelera con motivo `unpaid` (recuperarlo lo deja suspendido y los 90 días vuelven a contar). Los avisos van por WhatsApp si el dueño escribió en las últimas 24 h; fuera de esa ventana Meta exige plantilla: si existe `META_RETENTION_TEMPLATE` (plantilla de utilidad aprobada, {{1}} negocio, {{2}} fecha) se usa; si no, el aviso queda en "Mi plan", que muestra hasta cuándo se guardan los datos.

**Tres caminos para eliminar:**
- WhatsApp: el dueño escribe *eliminar mi cuenta* (o "borrar mis datos"; frase completa, "borrar mi cuenta Zelle" no cuenta). Respuesta con qué se borra, la papelera, el enlace al Excel y botones "Sí, eliminar" / "No, cancelar" (el Sí vale 10 minutos). Sin LLM. Un empleado recibe "solo el dueño".
- Panel: Ajustes → Negocio → "Eliminar mi cuenta" (solo dueño), escribiendo el nombre. Cierra la sesión; al volver a entrar ve `/recuperar`.
- Administrador: en la ficha, escribiendo el nombre, "A la papelera" o "Borrar ya" (para cuentas de prueba); en la papelera, "Recuperar". La lista marca "papelera".

`/eliminar-datos` y `/privacidad` describen la papelera, los 90 días por impago y el correo (30 días).

**Tests:** `erase_tenant` borra todo lo del negocio y nada del otro, no corre con otro `app.tenant_id` y conserva al usuario que es miembro de otro negocio; WhatsApp (empleado, botón sin pedirlo, No, Sí a la papelera, aviso una vez al día, recuperar); retención (avisos a los 60 y 83 una vez cada uno, papelera al 90, borrado al 105, recuperar un impago). QA en navegador: administrador (papelera, recuperar, borrar ya) y dueño (eliminar, /recuperar, recuperar).

**Hecho en producción (06/10):** Javier pegó `erase_tenant` en el SQL Editor; verificada (SECURITY DEFINER, `caja_app` puede ejecutarla, `anon` no) y registrada en `schema_migrations`. "Cinnamon rolls (piloto 2)" se borró con ella: negocio, número 584127806000 y el usuario jpaxieacademy@gmail.com (no estaba en Supabase Auth). Quedan 3 negocios.

**Pendiente visto en la revisión:** `/privacidad` prometía borrar el texto de los mensajes a los 90 días y las fotos a los 12 meses y no estaba implementado; hecho en la entrada siguiente.

### S2 · 06/10/2026 · Conservación: texto de los mensajes a los 90 días y fotos a los 12 meses

**Por qué:** `/privacidad` lo prometía desde el principio y no estaba implementado (visto al revisar la retención).

**Qué hace** (`ledger/purge.ts`, en el housekeeping del worker, por negocio y aparte del resto para que un fallo no deshaga lo demás):
- A los 90 días: `message.body` (texto o transcripción) queda en null y `tool_calls` conserva solo los nombres de las herramientas (las métricas los usan; los argumentos traían descripciones); el `payload` de los borradores ya resueltos queda en `{}`; el mensaje crudo de Meta en `webhook_event` (eventos cerrados) queda en `{"purged": true}`.
- A los 12 meses: las fotos y PDF se borran del bucket y el adjunto queda dado de baja (tandas de 100). El detalle del movimiento muestra "Foto borrada (se guardan 12 meses)".
- Los movimientos no se tocan. Nada de esto necesita migración. Las notas de voz ya no se guardaban (se transcriben en memoria).

**Tests:** texto viejo borrado y reciente intacto, nombres de herramientas conservados, borradores resueltos vaciados y pendientes no, foto de 366 días borrada y de 300 no, segunda vuelta sin cambios, eventos del webhook cerrados vaciados y en cola no.

### S2 · 06/10/2026 · Saldos de las cuentas en Inicio y "Cuentas" en el menú

**Pedido (Javier):** Inicio solo mostraba ventas y gastos; faltaba cuánto hay en cada cuenta, y las cuentas no tenían acceso directo en el menú.

- Inicio: tarjeta "Mis cuentas" después de la cifra de hoy, con "Tienes en total" (los Bs a la BCV de hoy), el desglose en dólares y bolívares, y cada cuenta con su saldo (toca para ver su estado de cuenta). Solo aparece si hay cuentas; si no, "Crear una cuenta" sigue en los primeros pasos.
- Menú: "Cuentas" entre Movimientos y Cierres; el título de la página dice "Cuentas" (antes "Ajustes") y "Ajustes" no se marca a la vez. La página de cuentas ya no tiene "‹ Ajustes" porque ahora está en el menú.
- `lib/accounts.ts`: el formato de saldo ("250,00 USDT", "Bs 36.400,00") y la línea de tipo se comparten entre Inicio y Cuentas.

QA en navegador (390 px y escritorio) con tres cuentas (Bs, USDT y efectivo $): total y saldos correctos, sin desborde, menú marcado.

### S2 · 06/10/2026 · Calculadora de sumas y dividir la cuenta

**Pedido (Javier):** su novia, probando, quería sumar los montos en Bs de los gastos del día para saber cuántos USDT cambiar, y el bot respondía "eso todavía no lo hago". También: mandar la foto de una factura, decir quién consumió qué y que el bot diga cuánto paga cada uno.

**Sumas (`sum_amounts`, herramienta no estricta; quedan 10 estrictas de 12):** el modelo solo copia los montos (con su signo) y la cuenta la hace el backend con Decimal. Cada monto tiene que estar en el texto del usuario (si no, pregunta). Sin moneda: si hay montos de miles son Bs, si no, dólares (lo dice: "asumí bolívares"). Bs → $ a la BCV y, si hay un cambio USDT registrado en los últimos 30 días, también cuántos USDT a esa tasa ("lo que hay que cambiar"). Admite tasa propia ("a 970"), $ → Bs y "divide 120$ entre 4". Regla 6e del prompt; cuatro evals nuevas (incluida la captura: 134.164,86 Bs).

**Dividir la cuenta (`inbox/split.ts`, `vision/bill.ts`, `domain/split.ts`):**
- Foto (o PDF) con leyenda "dividir", "repartir", "cuánto paga cada quien", "por persona"… no va como factura: una llamada lee los renglones (nombre, cantidad, importe) y el total; otra traduce lo que escribió el usuario a renglones por persona ("yo" = Tú, a medias, unidades: "yo 2 de las 3 cervezas", "el resto entre todos", "entre 3 iguales").
- La cuenta la hace `computeSplit` con Decimal: lo que la factura cobra aparte de los renglones (IVA, servicio, propina o un descuento) se reparte en proporción a lo que consumió cada uno; lo que nadie nombró queda "sin asignar" con su parte del servicio.
- Si la leyenda no dice quién consumió qué: la lista numerada y la pregunta. La respuesta siguiente (30 minutos) reparte; otra respuesta corrige sobre lo dicho ("no, el refresco lo compartimos").
- Si quien escribe tiene parte: botones "Guardar mi parte" / "No, gracias" sobre un borrador de gasto normal ("Mi parte · Pizzería…", categoría comida fuera, restaurante o salidas si existe); cada corrección reemplaza el borrador anterior. Una cuenta en Bs muestra también el equivalente en $ a la BCV.
- Ayuda del bot y bienvenida del panel mencionan las dos funciones.

**Tests:** sumas (los montos de la captura, USDT al último cambio, restas y dividir, monto inventado), `computeSplit` (servicio proporcional, a medias, unidades, resto entre todos, sin asignar, partes iguales, índices inválidos) y el flujo por WhatsApp (foto sin reparto → lista; respuesta → reparto con botones; corrección reemplaza el borrador; Guardar registra "Mi parte"; "entre 3" de una vez). 381 tests.

### S2 · 06/10/2026 · Calculadora: cada monto convertido y nunca uno por uno

**Prueba de Javier:** "calcúlame a tasa BCV estos montos (13,70$ 15$ 60$ 65$) y súmame todo en Bs". La suma salía en $ con el total en Bs, sin cada monto en Bs. Al pedir "quiero todos los montos en bs", el modelo usó `convert_currency` (un solo monto) y respondió uno por mensaje ("y los demás?" → el segundo).

**Arreglo:**
- `sum_amounts`, cuando convierte, muestra cada monto en las dos monedas ("$13,70 = Bs 11.951,74") y el total como suma de esas líneas redondeadas, para que cuadre al céntimo con lo que se ve.
- `convert_currency` es para UN monto; con dos o más, `sum_amounts` (descripciones y reglas 6b y 6e del prompt). Si pide el desglose de montos de un mensaje anterior, los copia todos de ahí (la validación ya acepta números del historial reciente).
- Test con los montos exactos de la captura; dos evals nuevas (la pregunta de un solo mensaje y el desglose pedido después).

### S2 · 07/10/2026 · Número real del bot

Javier compró la línea Movistar **+58 424-699-5167** y la agregó en Meta con el panel nuevo (casos de uso → Configuración básica → Paso 2: Configuración de producción). Cuenta de WhatsApp Business **Rocco** (2338829886855969, portafolio Just Travel), número registrado con PIN desde el panel, webhooks suscritos, método de pago asignado y acceso de `caja-worker`. Cambios: Railway `META_PHONE_NUMBER_ID=1448159538369862`, Vercel `PLATFORM_WA_NUMBER=584246995167`. El número de prueba deja de responder. La guía `docs/runbooks/numero-real.md` se reescribió con el flujo real de octubre de 2026 (el botón "Agregar número" de la cuenta de prueba sale gris; la API queda como alternativa).

Datos del negocio en Meta: nombre comercial JP Software Dev, Venezuela, sin verificar (hasta 2 números). La verificación queda para cuando haya documento (RNE o el registro mercantil ampliado).

### S2 · 07/10/2026 · Marca Rocco: voz del bot

**Decisión (Javier y su novia):** el asistente se llama **Rocco**, como su pug, con la frase *Tu amigo fiel con tus finanzas*. El tono es el de un hermano: cercano y venezolano. La chispa va solo a veces, y en lo que toca dinero habla serio. Pocos emojis.

**Hecho:**
- Guía de marca y de voz en `docs/marca/rocco.md`.
- Mensajes del bot con la voz de Rocco: bienvenida del dueño y del empleado, ayuda, número desconocido, fuera de tema, "todavía no lo sé hacer", mensajes seguidos, IA caída, nota de voz que no se oyó, sin movimientos, cancelar el borrado, recuperar la cuenta, pago verificado y plan vencido.
- 🐾 solo cuando Rocco se presenta. Cierre del día y resumen del período con ganancia terminan con "Buen día. ¡Sigue así!" o "Vas bien. ¡Sigue así!".
- Prompt: Rocco como identidad; las preguntas de aclaración (lo único que redacta la IA) en su voz, sin emojis ni chistes.
- `ASSISTANT_NAME` del worker pasa a "Rocco" por defecto.

**Pendiente:**
- Logo del pug y paleta.
- Web y dominio (holarocco.com o rocco.lat, por confirmar).
- Nombre visible "Rocco" en WhatsApp (revisión de Meta, después de la web) y foto de perfil.
- Plantillas de Meta con la voz nueva.
- Presentación para clientes con la marca.
- Registro en el SAPI.

### S2 · 07/10/2026 · Registro por WhatsApp con Rocco

**Pedido (Javier):** compartir el número de Rocco y que cada quien cree su cuenta en el chat, sin ir a la web ("la gente es floja"), con un registro tan completo como el del asistente web. Que cueste unos 10 mensajes no importa frente a lo que vale un usuario nuevo.

**Flujo (`onboarding/chat-signup.ts`, sin IA y con botones donde se puede):**
1. Presentación de Rocco, 14 días gratis, aviso de privacidad y "¿cómo te llamas?". Si hay nombre de perfil, el botón "Llámame Javier".
2. "¿Para ti o para tu negocio?" (botones).
3. Negocio: nombre y tipo (lista: autolavado, comida, tienda, servicios, otro). Personal: el nombre de la persona.
4. Moneda principal (botones).
5. Categorías sugeridas según el tipo, con "Usar estas" o "Escribir las mías". También se pueden sumar: "agrega Gimnasio, Mascotas". Se avisa que se cambian en el dashboard.
6. Cuentas escritas ("Banesco 5.000 bs, Binance 120 usdt, efectivo 40$"). Rocco deduce tipo y moneda y pide confirmar con "Así está bien" / "Corregir", o se salta.
7. Presupuesto mensual en dólares por categoría ("Mercado 200, comida 80"), o "Ahora no".
8. Resumen de la cuenta creada y un recorrido corto de funciones (ventas solo para negocios), el dashboard y la invitación al primer gasto.

Atajos en cualquier paso: *web* (enlace al registro web), *empezar de nuevo*, *ayuda*. Notas de voz y fotos durante el registro reciben "respóndeme con texto". El paso vive en `app.signup`: si la persona vuelve otro día, sigue donde quedó. Límites: el de mensajes de un conocido (30 cada 5 min) y 60 registros nuevos por hora en toda la plataforma (después, el texto fijo de siempre).

**Al terminar (`registerFromChat`):** negocio en prueba con `signup_channel = whatsapp`, categorías, número del dueño ya activo (escribirle a Rocco prueba que es suyo), cuentas con saldo inicial y presupuestos. Cada cuenta va en un punto de guardado: si una falla, el registro sigue.

**Dashboard para quien se registró por chat:** entra en /login con su correo y luego en /registro toca "Ya me registré con Rocco" (/registro/conectar). La web da un código de 6 dígitos (15 min, solo el hash en `app.dashboard_link`) y la persona se lo manda a Rocco desde su número. Eso prueba el correo (enlace mágico) y el número (WhatsApp), y su usuario queda como dueño. "link del dashboard" explica estos pasos si el negocio todavía no tiene a nadie en el panel.

**Migración 0018:**
- Tablas `app.signup` y `app.dashboard_link`, globales, sin llaves foráneas para no estorbar a `erase_tenant`.
- `tenant.signup_channel` para el CRM.
- Aplicada en producción antes del push. El MCP de Supabase no acepta la palabra DELETE, así que el permiso es SELECT/INSERT/UPDATE.

**Pendiente:** purgar los registros abandonados a los 90 días (guardan nombre y cuentas) junto con la purga de privacidad.

**Tests:** lectores de nombre, tipo, cuentas, categorías y presupuestos; flujo de negocio completo con la base revisada; flujo personal con saltos, audio y "empezar de nuevo"; conectar el dashboard con código (y que no sirva dos veces). 393 tests.

### S2 · 07/10/2026 · Precios nuevos, límites duros, recargas, fundadores, encuesta y CRM

**Decisiones (Javier, sobre el análisis de costos con datos reales):**
- Costo en el peor caso: ~$0,021 por mensaje (IA ~$0,01 + Meta $0,0113 por respuesta desde el 01/10/2026, que cobra el servicio después de 1.000 gratis al mes).
- Planes con ~58 % de margen: Personal $5,99 / 120 mensajes, Negocio $19,99 / 400, Negocio Plus $39,99 / 1.000.
- Límites duros con recarga de +100 mensajes por $4.
- Beta con amigos sin precios publicados, con precio de fundador.
- Encuesta de precio el día 10 y resumen de valor el día 12.
- CRM interno.

**Límite duro (`billing/limits.ts`):**
- En un plan pagado (activo o en gracia), pasar los mensajes del mes más la recarga del mes hace que Rocco deje de registrar, sin IA.
- Le avisa una vez al día al dueño, con recargar o cambiar de plan, y al empleado que le avise al dueño.
- Al 80 % manda un aviso único al dueño después de la respuesta (`cap_warned_month`).
- La prueba sigue con su tope de gasto (0016).
- El aviso al administrador de "sobre el límite" ahora cuenta la recarga.

**Recargas:**
- "recargar" (o "más mensajes") muestra los montos por método. En la prueba ofrece activar el plan.
- El botón usa el mismo flujo de "renovar" con `kind: recharge`.
- La referencia crea un pago `payment.kind = recharge`.
- Al aprobarlo suma +100 a `extra_messages` del mes en curso sin tocar la vigencia, y Rocco avisa "Recarga verificada".
- El administrador puede regalar una recarga desde la ficha.

**Precio fundador:**
- 40 % por 7 meses (`tenant.founder_until`), automático para los primeros 50 negocios (web y WhatsApp).
- Los 4 negocios actuales quedaron como fundadores.
- Se aplica en la oferta de renovar del chat, en el pago por chat y en "Mi plan" de la web, con una línea que lo explica.
- El cierre del registro por WhatsApp lo menciona.
- El administrador lo da o lo quita en la ficha.

**Ciclo de la prueba (`inbox/lifecycle.ts`, housekeeping):**
- Día 10: encuesta con listas de rangos al mes ("precio justo", luego "precio caro").
- Día 12: resumen de lo anotado (movimientos, gastos y ventas en $), fin de la prueba, precio de fundador y "¿Seguimos?" con los botones "Sí, sigamos" y "Tengo dudas" (esta muestra el contacto).
- Solo dentro de la ventana de 24 h de Meta; si no, se reintenta en la próxima vuelta.
- Las respuestas quedan en `tenant.survey`.

**CRM en /admin:**
- Embudo: registros por WhatsApp, terminados, negocios (web y chat), activados (3 o más movimientos el primer día), activos en 7 días y pagando.
- Registros sin terminar, con el paso donde se quedaron y el botón "Escribirle" (wa.me).
- Resumen de la encuesta de precio.
- Por negocio: semáforo (al día, 3+ días o 7+ días sin escribir), fundador, canal y etiquetas.
- Ficha: precio fundador, regalar recarga, estado de la encuesta y del resumen, etiquetas y notas internas.

**Migración 0019 (aplicada en producción):** columnas en `tenant` (founder_until, extra_messages, extra_month, cap_warned_month, survey_sent_at, value_sent_at, survey, crm_notes, crm_tags) y `payment.kind`. Sin tablas nuevas, así `erase_tenant` las borra con el negocio.

**Tests:** límite al 80 % y al 100 % sin IA, recarga de punta a punta (oferta, método, referencia, aprobación, vuelve a responder), precio fundador, encuesta y resumen con la ventana de 24 h. 402 tests.

### S2 · 07/10/2026 · La web con la marca Rocco

**Pedido (Javier):** cambiar todo el texto de la página a la marca Rocco y que la animación del chat sea hablando con Rocco. Los colores se quedan: van con WhatsApp y con finanzas.

**Hecho:**
- **Landing:** "Rocco · Fiel a tus cuentas" / "Tu amigo fiel con tus finanzas".
  - Ya no vende "tu asistente contra una administradora de $300": habla de lo personal y del negocio.
  - El botón principal "Escribirle a Rocco" abre WhatsApp con "Hola Rocco" y el registro ocurre en el chat. "Crear cuenta en la web" queda como segunda opción.
  - La comparación es "Sin Rocco: 3 apps / Con Rocco: 1 chat".
  - Las 8 escenas del chat se rehicieron con la voz y los mensajes reales de Rocco: saludo, qué sabe hacer, borrador con Guardar, guardado, calculadora, resumen del mes, privacidad y cómo empezar.
  - Preguntas nuevas: quién es Rocco, personal o negocio, cómo se paga desde el chat.
  - Planes con 14 días gratis, precio fundador y nota de beta.
- **Logo provisional:** un pug sencillo en los mismos verdes (ícono de la pestaña, landing y login), hasta tener el del ilustrador.
- **Rocco en el resto de la web:** título, manifiesto, login (con el chat de ejemplo actualizado a la tasa 866,56), confirmación del correo, privacidad, eliminar datos, Excel exportado y textos del panel ("el asistente" → "Rocco"). "Piloto" pasa a "beta".

**Pendiente:** el asunto y el remitente del correo de acceso (plantilla de Supabase Auth) todavía dicen el nombre viejo, y falta el dominio holarocco.com.

### S2 · 07/10/2026 · Web sin precios: gratis durante la beta

**Pedido (Javier):** no mostrar precios; "gratis durante la beta".

**Hecho:**
- `BETA = true` en `billing/plans.ts`.
- Mientras esté encendido:
  - La landing muestra "Gratis durante la beta" en cada plan.
  - La pregunta "¿Cuánto cuesta?" responde que es gratis y que los precios se avisarán con 30 días de anticipación (con precio de fundador para los primeros 50).
  - El registro web dice "Gratis en la beta".
  - "Mi plan" muestra "Gratis" a quien está en prueba.
- Los precios de `PLANS` siguen definidos para el cobro (renovar por chat, panel). Para publicarlos se apaga `BETA`.

**Ajuste (Javier):** la beta es "14 días gratis" contados desde el día que cada quien empieza: la prueba de siempre. La web lo dice así en la landing (planes, pregunta de precio, cierre y chat), el registro, "Mi plan" y el login. Al terminar la prueba, Rocco ofrece el plan con su precio (fundador para los primeros 50).

### S2 · 07/10/2026 · Prueba por mensajes y recargas de $1 y $4

**Pedido (Javier):** medir la prueba en mensajes, no en dólares, y vender recargas: +20 mensajes por $1 y +100 por $4. Nada ilimitado: quien usa más paga lo que usa.

**Hecho:**
- **Prueba gratis:** 14 días o hasta *100 mensajes* (Personal), *200* (Negocio) o *300* (Plus), lo que llegue primero (`plan.trialMessages`).
  - Al 80 % Rocco avisa una vez ("te quedan 20 de 100") y sugiere juntar varios gastos en un mensaje.
  - El mensaje 101 ya no llama a la IA: "Usaste los 100 mensajes de tu prueba gratis…" y ofrece activar el plan.
  - El tope en dólares se queda como red de seguridad ($4 / $8 / $12) por si alguien manda muchas fotos. Si para por ahí, el texto es el genérico.
  - "Mi plan" muestra "llevas X de 100 mensajes".
- **Recargas:** "recargar" muestra dos botones, +20 por $1 y +100 por $4. Después vienen el método, los datos y la referencia, igual que antes.
  - El pago guarda cuántos mensajes compra (`payment.extra_messages`). Al aprobarlo se suman al mes en curso.
  - El aviso del tope del mes lista las dos opciones.
  - El regalo del administrador sigue siendo de +100.
- **Margen en el peor caso** (~$0,021 por mensaje): recarga chica 57 %, recarga grande 47 %. Una prueba Personal usada completa cuesta ~$2,13 y una de Negocio ~$4,26.
- **Excel** (`docs/finanzas/rocco-modelo-financiero.xlsx`): prueba en mensajes, fila de la recarga chica y recomendaciones al día.

**Migración 0020 (aplicada en producción):** `payment.extra_messages` con check > 0.

**Tests:** prueba por mensajes (aviso al 80 % y corte en el 101 sin IA), elegir recarga, recarga chica de $1 y pago con 100 mensajes. 404 tests en core.

### S2 · 07/10/2026 · Modo beta y modo live (interruptor en /admin)

**Pedido (Javier):** en la beta, el bot no debe dar precios. Si alguien escribe "recargar" o "¿cuántos mensajes me quedan?", Rocco debe decir los días y los mensajes que le quedan. Al terminar los 14 días, sí le muestra los precios y le pregunta si quiere seguir. Cuando termine la beta se pasa a "live".

**Hecho:**
- **Interruptor en /admin ("Modo de lanzamiento"):** Beta o Live, más el día de la encuesta de precio y el del resumen "¿seguimos?". Se guarda en `app.app_setting` (migración 0021). Rocco lo lee en cada mensaje, así que no hace falta redesplegar.
- **Beta, durante la prueba:**
  - "renovar", "recargar", "mi plan", "¿cuántos mensajes me quedan?" (herramienta `renew_plan`) y los botones viejos de pago responden: "*Tu prueba gratis* · beta de Rocco / Te quedan *6 días* (hasta el mar 13/10) y *150 de 200 mensajes*. Durante la prueba no pagas nada…".
  - No muestra montos ni botones, y no se abre ningún cobro.
- **Al terminar la prueba (beta o live):**
  - Aviso único por la ventana de 24 h: "Se terminó tu prueba gratis…" con el plan, el precio de fundador y un botón por método de pago.
  - Si escribe con la prueba ya suspendida y nunca pagó: "Tu prueba gratis terminó…" con la misma oferta. Antes decía "tu plan venció".
  - Si se acaban los mensajes antes de los 14 días, también se muestran los precios.
- **Live:** los precios se muestran siempre, como antes. La oferta ahora dice "Llevas X de Y mensajes", así que "¿cuántos mensajes me quedan?" se responde también en live.
- **Web:**
  - La portada y el registro siguen el interruptor. La portada se relee cada 5 minutos y al guardar.
  - En "Mi plan", durante la prueba en beta, se ocultan los precios, cómo pagar y "Ya pagué".

**Migración 0021 (aplicada en producción):** `app.app_setting` (global, como `bcv_rate`), con `launch = {beta: true, surveyDay: 10, valueDay: 12}`.

**Tests:** beta sin precios (texto y botón viejo), fin de la prueba con precios (una sola vez), prueba suspendida sin pago, días configurables. 410 tests en core.

### S2 · 07/10/2026 · Una sola prueba gratis: 14 días o 100 mensajes para todos

**Pedido (Javier):** que nadie pueda elegir Plus para tener más prueba gratis. Una sola prueba, cuidando el capital.

**Hecho:**
- **Prueba única:** `TRIAL_MESSAGES = 100` y una red de seguridad de $4 (`TRIAL_BUDGET_USD`), iguales para todos los planes. Antes eran 100/200/300 y $4/$8/$12 según el plan. El plan se elige al pagar.
- **Mensajes regalados en la prueba:** "Regalar +100 mensajes" en /admin ahora sube el tope de la prueba (100 + regalados) y la red de seguridad en proporción. En la prueba, los regalos se acumulan aunque cambie el mes. En un plan pagado siguen valiendo para el mes.
- **Registro web:** el primer paso ya no pide plan. Pregunta "¿Cómo lo vas a usar?" (finanzas personales o negocio) y explica "14 días o 100 mensajes gratis; el plan lo eliges cuando termine". El servidor solo acepta personal o negocio.
- **Landing:** "14 días o 100 mensajes gratis, lo que llegue primero".
- **Pilotos en prueba:** el autolavado (133 mensajes) y "Finanzas personales" (87) empezaron con 200. Se les regalaron +100 en producción, con registro en `audit_log`, para que mantengan 200.
- **Excel:** la prueba única baja el costo por cliente conseguido entre dueños de negocio de ~$11 a ~$5,7 (peor caso).

**Tests:** el tope único, el regalo que sube el tope de la prueba y vuelve a responder, y la beta con 100 mensajes. 409 en core.

### S2 · 07/10/2026 · Voz más casual: Rocco, tu pana que está pendiente por ti

**Pedido (Javier):** un copy más casual, sin caer en lo coloquial pesado. Rocco tiene que ser el punto medio entre un administrador profesional y tu pana: el que está en todos lados, pendiente de la tasa oficial en cada movimiento para que tú no te preocupes. El público tiene menos de 45 años: la nueva generación de dueños de negocio y gente que quiere que algo se lo haga todo.

**Hecho:**
- **Guía de marca** (`docs/marca/rocco.md`):
  - A quién le habla y la promesa: "Rocco está pendiente por ti".
  - El punto medio, con palabras que sí van ("epa", "pana", "dale", "al toque", "tranqui", "arrancamos") y que no van ("vaina", "pa' chao", groserías).
  - Cómo se presenta: "tu pana con las finanzas".
- **Web:**
  - El hero: "tu pana en WhatsApp para moverte en la economía venezolana… pendiente de la tasa del BCV por ti".
  - Las insignias: "Pendiente de la tasa BCV por ti".
  - La comparación: "Un rollo" / "Tú tranqui".
  - La escena de la tasa: "La tasa, que la vigile Rocco".
  - La pregunta "¿Tengo que estar pendiente de la tasa?" ("No, de eso se encarga Rocco").
  - El cierre "Deja que Rocco te lleve las cuentas" y la descripción para buscadores.
- **Bot:** la bienvenida, el registro, la ayuda, el número desconocido, el empleado y "fuera de tema" usan "¡Epa!", "tu pana con las finanzas" y "pendiente de la tasa por ti". Pagos, errores y límites siguen serios.
- **IA:** la regla de las preguntas de aclaración pide la voz casual, sin "vaina" ni groserías.
- El eslogan y la frase de la marca no cambian: "Fiel a tus cuentas" y "Tu amigo fiel con tus finanzas".
