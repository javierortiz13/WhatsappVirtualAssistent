# S0 · Cuentas y accesos

Guía para dejar listas todas las cuentas externas antes del día 3. Tiempo estimado: 2 a 3 horas, más las esperas de Meta. Ve capturando cada valor en tu `.env` local (copia de `.env.example`). **Ningún secreto va al repositorio ni al chat.**

Las pantallas de estos proveedores cambian a menudo. Donde diga "verificar", el nombre exacto del menú puede diferir; el concepto no.

## 0. Preparar el entorno local (10 min)

```bash
git clone git@github.com:javierortiz13/WhatsappVirtualAssistent.git
cd WhatsappVirtualAssistent
git checkout claude/whatsapp-assistant-venezuela-wijnh8
pnpm install
cp .env.example .env
pnpm lint && pnpm typecheck && pnpm test     # debe estar todo en verde antes de tocar nada
openssl rand -hex 32                         # guarda este valor: será META_VERIFY_TOKEN
```

## 1. Meta: Business Manager, app y número de prueba (45 min + esperas)

### 1.1 Business Manager (portafolio de negocio)
1. Entra a business.facebook.com con tu cuenta personal de Facebook (obligatorio: Meta no permite cuentas "de empresa" sueltas). Activa la **verificación en dos pasos** en esa cuenta antes de seguir.
2. Crea un portafolio de negocio a nombre de la **empresa venezolana**: nombre legal exacto como aparece en el Registro Mercantil, correo del negocio, dirección fiscal.
3. Configuración del negocio → **Pagos** (o "Facturación") → agrega tu tarjeta internacional. Aunque el número de prueba es gratis, desde el 01/10/2026 Meta exige método de pago para entregar mensajes de servicio; mejor tenerlo desde ya.
4. Configuración del negocio → **Centro de seguridad** → **Iniciar verificación del negocio**. Ten a mano en PDF o foto legible: acta constitutiva del Registro Mercantil, RIF, y una factura de CANTV o CORPOELEC o estado de cuenta bancario a nombre de la empresa con menos de 12 meses. El nombre, dirección y teléfono deben coincidir en los tres. Envíala y sigue: tarda de horas a semanas y no bloquea nada de esta semana.

### 1.2 App de desarrollador
1. developers.facebook.com → **Mis apps** → **Crear app**. Caso de uso: "Otro" → tipo **Negocio** (Business). Nombre: `Asistente de Caja`. Vincúlala al portafolio del paso 1.1.
2. En el panel de la app → **Agregar producto** → **WhatsApp** → Configurar.
3. **WhatsApp → Configuración de la API** (API Setup). Anota:
   - `META_PHONE_NUMBER_ID`: el "Identificador del número de teléfono" del número de prueba.
   - `META_WABA_ID`: el "Identificador de la cuenta de WhatsApp Business".
   - Número de prueba en sí (empieza por +1): lo vas a agendar en tu teléfono como "Asistente de Caja (prueba)".
4. En esa misma pantalla, **"Para" / destinatarios**: agrega tu número y el de tu novia (formato internacional). Cada uno recibe un código por WhatsApp para confirmarse. Máximo 5.
5. Envía el mensaje de prueba `hello_world` desde la pantalla a tu número. Si te llega, el número de prueba funciona.
6. **Configuración de la app → Básica**: copia el **Identificador de la app** y la **Clave secreta de la app** → `META_APP_SECRET`.

### 1.3 Token permanente (usuario del sistema)
El token que muestra "Configuración de la API" caduca en 24 horas. No lo uses en el `.env` más que para probar hoy.
1. business.facebook.com → Configuración del negocio → **Usuarios → Usuarios del sistema** → **Agregar**. Nombre `caja-worker`, rol **Administrador**.
2. **Asignar activos**: la app `Asistente de Caja` (control total) y la cuenta de WhatsApp Business (control total).
3. **Generar token**: elige la app, caducidad **Nunca**, permisos `whatsapp_business_messaging` y `whatsapp_business_management`. Copia el token una sola vez → `META_ACCESS_TOKEN`.
4. Anota en tu gestor de contraseñas la fecha: rotación a los 90 días (Fase 7).

### 1.4 Webhook (se conecta el día 2)
Meta necesita una URL pública. Hoy solo genera el `META_VERIFY_TOKEN` (paso 0). El día 2 registramos la URL, con un túnel local o con el despliegue en Vercel.

## 2. Supabase: proyecto, migración y rol de la app (25 min)

1. supabase.com → tu organización → **New project**. Nombre `asistente-caja`, región **East US (North Virginia)** (la más cercana a Venezuela), contraseña de base fuerte generada por ellos. Guárdala.
2. Cuando termine de aprovisionar: **Project Settings → Database → Connection string**. Hay tres variantes (verificar nombres):
   - **Direct connection** (puerto 5432, host `db.<ref>.supabase.co`): usa IPv6. Sirve desde tu máquina si tienes IPv6; Railway y Vercel a veces no.
   - **Session pooler** (puerto 5432 vía `aws-0-<region>.pooler.supabase.com`, usuario `postgres.<ref>`): IPv4, mantiene sesión, compatible con `set_config(..., true)` dentro de transacciones. **Usa esta para `DATABASE_URL` y `DATABASE_ADMIN_URL`.**
   - **Transaction pooler** (puerto 6543): no la uses; rompe el `SET LOCAL` fuera de transacciones y no soporta prepared statements.
3. `DATABASE_ADMIN_URL` = cadena del session pooler con el usuario `postgres.<ref>` y la contraseña del paso 1, más `?sslmode=require`.
4. Aplica la migración desde tu máquina:
   ```bash
   pnpm db:migrate
   ```
   Debe imprimir `applied 0001_init.sql` y `migraciones al día`.
5. En Supabase → **SQL Editor**, dale login al rol de la app (elige otra contraseña fuerte):
   ```sql
   ALTER ROLE caja_app LOGIN PASSWORD 'PEGA_AQUI_UNA_CONTRASENA_FUERTE';
   ```
   `DATABASE_URL` = misma cadena del session pooler pero con usuario `caja_app.<ref>` y esa contraseña.
6. Seed de los pilotos (tu número y el de tu novia, sin `+`):
   ```bash
   pnpm db:seed
   ```
7. **Storage → New bucket**: nombre `facturas`, **privado**. Nada más por ahora.
8. **Authentication → Providers → Email**: activa "Enable email provider" y "Magic link" (o "Email OTP", verificar nombre). El SMTP propio (Resend) se configura el día 6.

## 3. Railway: servicio del worker (10 min)

1. railway.com → **New Project** → **Empty project**. Nombre `asistente-caja`.
2. Aún no despliegues nada. El día 3 conectamos el repo con directorio raíz `apps/worker` y comando `pnpm --filter @caja/worker start`.
3. Verifica el plan Hobby (5 USD al mes con 5 de uso incluidos) y agrega tu tarjeta.

## 4. Anthropic: clave de API y tope de gasto (10 min)

1. console.anthropic.com (cuenta aparte de tu suscripción de Claude; la suscripción no da acceso a la API).
2. **Billing**: agrega la tarjeta y carga crédito prepagado (20 USD sobran para el piloto). Fija un **límite mensual de gasto** de 30 USD.
3. **API Keys → Create key**: nombre `caja-worker` → `ANTHROPIC_API_KEY`.

## 5. Deepgram: clave de API (5 min)

1. console.deepgram.com → registro con tu correo. Trae crédito inicial sin tarjeta.
2. **API Keys → Create a new API key**: nombre `caja-worker`, permiso Member → `DEEPGRAM_API_KEY`.

## 6. Dominio y correo (20 min, y DNS puede tardar)

1. Compra el dominio en el registrador que uses (Cloudflare Registrar cobra precio de costo). Hasta que exista la marca, un dominio genérico sirve; el definitivo se cambia después.
2. resend.com → **Domains → Add domain** → agrega los registros DNS (SPF, DKIM) que te indica. La verificación tarda de minutos a horas. **API Keys → Create** → guárdala como `RESEND_API_KEY` para el día 6.
3. Vercel: en tu equipo Pro, **Add New → Project** se hace el día 6 conectando el repo con directorio raíz `apps/web`. Hoy no hace falta nada.

## 7. Sentry (5 min, opcional hoy)

sentry.io → proyecto `caja-worker` (Node) y `caja-web` (Next.js) → copia los DSN. Se conectan el día 6.

## 8. Comprobación final

Con el `.env` completo:

```bash
pnpm typecheck && pnpm test
pnpm dev:worker          # debe imprimir "worker listo" y quedarse esperando; Ctrl+C
```

Valores que deben existir en tu `.env` al terminar: `DATABASE_URL`, `DATABASE_ADMIN_URL`, `SEED_OWNER_PHONE`, `SEED_SECOND_TENANT_PHONE`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_WABA_ID`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`. Los demás pueden esperar.

## Si algo se traba

- **Meta no acepta tu número como destinatario de prueba**: revisa que el número esté en formato internacional y que WhatsApp esté activo en ese teléfono. Los números con WhatsApp Business (app) también sirven.
- **`pnpm db:migrate` falla por conexión**: prueba la cadena con `psql "$DATABASE_ADMIN_URL" -c 'select 1'`. Si falla con "network unreachable", es IPv6: usa el session pooler.
- **`pnpm db:seed` dice que ya existe**: es idempotente por número; borra el tenant desde el SQL Editor solo si estás en desarrollo.
- **Verificación de negocio rechazada**: lee el motivo exacto; casi siempre es un dato que no coincide entre documentos. Corrige y reenvía; no crees otro portafolio.
