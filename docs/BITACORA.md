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
