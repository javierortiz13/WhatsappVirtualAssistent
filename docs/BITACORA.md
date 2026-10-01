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
