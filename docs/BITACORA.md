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
