# Día 6 · Dashboard en Vercel, acceso por magic link y webhook de Meta

Objetivo: entrar a `https://caja.jpsoftwaredev.com` desde el teléfono con un enlace por correo y
ver el gasto que registraste por WhatsApp. Tiempo estimado: 45 minutos, casi todo en consolas.
Orden: base → Supabase Auth → Vercel → dominio → Meta → Sentry → prueba.

## 1. Base de datos y seed (5 min)

```bash
git pull
pnpm install
pnpm db:migrate        # aplica 0002_dashboard_auth.sql (funciones claim_account y memberships_for_user)
```

En el `.env` de la raíz agrega tu correo (el que usarás para entrar) y vuelve a correr el seed.
Es idempotente: no crea otro negocio, solo te da acceso al que ya existe.

```
SEED_OWNER_EMAIL=tu-correo@jpsoftwaredev.com
```

```bash
pnpm db:seed
# → seed ya aplicado (número del dueño existe); solo se revisan los accesos
# → acceso al dashboard: tu-correo@... → tenant 1
```

## 2. Supabase Auth (10 min)

En el proyecto `asistente-caja`:

1. **Project Settings → API**. Copia al `.env`:
   - `NEXT_PUBLIC_SUPABASE_URL` = Project URL (`https://daomgsvvhvuhiccttrlg.supabase.co`).
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = la clave `anon` / publishable. No es secreta, pero solo sirve con RLS.
2. **Authentication → URL Configuration**:
   - Site URL: `https://caja.jpsoftwaredev.com`
   - Redirect URLs: `https://caja.jpsoftwaredev.com/auth/confirm` y `http://localhost:3000/auth/confirm`.
3. **Authentication → Emails → Templates**. Cambia **las dos** plantillas, **Confirm signup** y
   **Magic Link** (a un correo nuevo Supabase le envía la primera), por este cuerpo con `token_hash`,
   para que el enlace sirva aunque lo abras en otro dispositivo:
   ```html
   <h2>Tu enlace para entrar</h2>
   <p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Entrar a Asistente de Caja</a></p>
   <p>Sirve por 15 minutos y una sola vez. Si no lo pediste, ignora este correo.</p>
   ```
   Asunto: `Tu enlace para entrar a Asistente de Caja`.
4. **Authentication → Sign In / Providers → Email**: deja activo Email, desactiva "Confirm email"
   si aparece (el magic link ya confirma), y pon **Email OTP expiration** en `900` segundos.
5. **Project Settings → Authentication → SMTP Settings** (correo saliente por Resend):
   - Enable Custom SMTP: sí.
   - Sender email: `acceso@caja.jpsoftwaredev.com` · Sender name: `Asistente de Caja`.
   - Host: `smtp.resend.com` · Port: `465` · Username: `resend` · Password: tu `RESEND_API_KEY`.
6. **Authentication → Rate Limits**: sube "emails per hour" a 30 (con SMTP propio se puede).

## 3. Vercel (10 min)

1. vercel.com → **Add New → Project** → importa `javierortiz13/WhatsappVirtualAssistent`.
2. **Root Directory**: `apps/web`. Framework: Next.js (lo detecta). Deja build e install por defecto
   (usa pnpm por el lockfile). Node.js 22.
3. **Environment Variables** (Production y Preview). Las `NEXT_PUBLIC_*` van como **Config**, no como
   Secret (Vercel lo rechaza); las demás como Secret. Tras cambiar cualquiera, **Redeploy**.

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | la misma del `.env` (session pooler, usuario `caja_app`) |
   | `DATABASE_SSL_CA` | el contenido completo de `certs/prod-ca-2021.crt` (pégalo con sus saltos de línea) |
   | `META_APP_SECRET` | del `.env` |
   | `META_VERIFY_TOKEN` | del `.env` |
   | `NEXT_PUBLIC_SUPABASE_URL` | del paso 2 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | del paso 2 |
   | `DASHBOARD_URL` | `https://caja.jpsoftwaredev.com` |
   | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | del paso 6 (pueden esperar) |

4. **Deploy**. Mientras la rama de trabajo sea `claude/whatsapp-assistant-venezuela-wijnh8`, en
   **Settings → Git → Production Branch** pon ese nombre; si no, Vercel despliega `main`, que está vacía.
5. **Settings → Domains → Add**: `caja.jpsoftwaredev.com`. Vercel te muestra un CNAME.

## 4. DNS en Squarespace (2 min, más la propagación)

Squarespace → Domains → `jpsoftwaredev.com` → DNS → **Add record**:

| Host | Tipo | Valor |
|---|---|---|
| `caja` | CNAME | `cname.vercel-dns.com` |

No toca los registros de Google Workspace ni los de Resend (esos están en `send.caja` o similares).
Vercel emite el certificado solo cuando el CNAME propaga (5 a 30 minutos). Comprueba con
`https://caja.jpsoftwaredev.com/login` desde el teléfono.

## 5. Webhook de Meta (15 min)

developers.facebook.com → tu app → **Casos de uso → WhatsApp → Configuración → Webhook → Editar**:

- URL de devolución de llamada: `https://caja.jpsoftwaredev.com/api/whatsapp/webhook`
- Token de verificación: el valor de `META_VERIFY_TOKEN` (el mismo que pusiste en Vercel).
- **Verificar y guardar**. Si falla, revisa que Vercel ya tenga el dominio con certificado y la variable.
- **Administrar** → suscribe el campo `messages`. Toca **Probar** en esa fila: en Vercel debe salir un POST 200.
  Un 401 "firma inválida" significa que `META_APP_SECRET` en Vercel no es la **Clave secreta de la app** (Configuración de la app → Básica).

Tres pasos más que Meta no hace solo y sin los cuales los mensajes reales no llegan:

1. **Publicar la app.** En modo desarrollo Meta no entrega mensajes reales al webhook. Configuración de la app → Básica: URL de privacidad `https://caja.jpsoftwaredev.com/privacidad`, categoría "Negocios y páginas", guardar. Luego menú **Publicar** → publicar.
2. **Token permanente.** El token de "Inicio rápido" caduca en 24 h. Business Manager → Usuarios del sistema → crear `caja-worker` (Administrador) → Asignar activos: la app y la cuenta de WhatsApp con control total → Generar token, caducidad "Nunca", permisos `whatsapp_business_messaging` y `whatsapp_business_management`. Va en `META_ACCESS_TOKEN` del `.env` y de Railway.
3. **Suscribir la WABA a la app**, con el token permanente (sustituye el id de la WABA por el tuyo, `META_WABA_ID`):
   ```bash
   curl -s -X POST "https://graph.facebook.com/v24.0/1086626347062304/subscribed_apps" -H "Authorization: Bearer $META_ACCESS_TOKEN"
   ```
   Debe responder `{"success":true}`.

## 6. Sentry (5 min, opcional hoy)

sentry.io → crea dos proyectos: `caja-web` (plataforma Next.js) y `caja-worker` (Node.js).
Copia cada DSN: el de web a Vercel como `SENTRY_DSN` y `NEXT_PUBLIC_SENTRY_DSN`; el de worker a
Railway como `SENTRY_DSN`. Redespliega ambos. Sin DSN, el código no envía nada.

## 7. Railway (2 min)

El worker cambió (Sentry y guardas de errores): **Redeploy** para tomar el commit nuevo. Agrega
`SENTRY_DSN` si ya lo tienes.

## 8. Prueba de punta a punta (5 min)

1. En el teléfono abre `https://caja.jpsoftwaredev.com/login`, pon tu correo, abre el enlace del
   correo. Debes caer en **Inicio** con el nombre del negocio y la tasa BCV.
2. En WhatsApp, al número de prueba: `gasté 15$ en champú` → borrador con botones → **Guardar**.
3. Recarga el dashboard: la fila aparece en "Últimos movimientos" con monto, equivalente y tasa.
4. **Ajustes → Cerrar sesión** y vuelve a entrar: el segundo enlace también funciona.

Si el correo no llega: Supabase → **Logs → Auth** muestra el intento; Resend → **Emails**
muestra si salió. Si el enlace dice "ya no sirve": venció (15 min), ya se usó (los clientes de
correo a veces lo abren para previsualizarlo; por eso el enlace lleva a una página con botón y
solo se valida al tocarlo), o la plantilla sigue usando `{{ .ConfirmationURL }}` y abriste el
enlace en otro dispositivo. El motivo exacto queda en Vercel → Logs como `"msg":"confirm"`.
