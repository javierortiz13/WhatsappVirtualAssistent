# Runbook S2 · Monitoreo y alertas (30 minutos)

Tres piezas, en este orden. Cada una es independiente; si una se traba, sigue con la siguiente.

## 1. Monitor de salud (Better Stack, gratis) · 10 min

Qué vigila: `https://caja.jpsoftwaredev.com/api/health`. Responde 200 si la base contesta, el
worker terminó un housekeeping hace menos de 15 minutos y ningún mensaje lleva más de 3 minutos
esperando. Cualquier otra cosa es 503 y el monitor avisa.

1. Antes de nada, abre esa URL en el navegador. Debe mostrar `"ok": true` y el commit desplegado.
   Si da 404, Vercel todavía no desplegó `1fa215d`; espera y repite.
2. Entra a betterstack.com → Uptime → **Create monitor**.
3. Rellena:
   - URL to monitor: `https://caja.jpsoftwaredev.com/api/health`
   - Alert us when: **URL becomes unavailable** (equivale a "estado distinto de 2xx")
   - Check frequency: **5 minutes** (el plan gratis lo permite)
   - Advanced → Request timeout: 30 s. Confirmation period: 1 minuto (evita avisos por un
     parpadeo de red). Recovery period: 0.
   - Name: `Caja · salud`
4. On-call and escalation → tu correo y, si instalas la app de Better Stack en el teléfono,
   push. Sin llamadas.
5. Guarda y espera al primer check: debe quedar en verde.
6. Prueba de fuego, una sola vez: Railway → servicio worker → botón **Pause** (o Remove del
   deployment activo). Entre 15 y 20 minutos después debe llegar la alerta con "503". Reanuda
   (Deploy / Redeploy) y en 5 minutos el monitor se recupera solo. Si prefieres no tumbar el
   worker, salta este paso; el test de código ya cubre los tres estados.

Alternativa idéntica en UptimeRobot: New Monitor → HTTP(s) → misma URL → intervalo 5 min →
alert contacts: correo.

## 2. Avisos de Railway · 3 min

Railway → proyecto `WhatsApp-assistant` → servicio worker → **Settings** → sección
**Notifications** (si no aparece ahí: avatar → Account Settings → Notifications).

- Deploy failed: activado, por correo.
- Deploy crashed (reinicios por `restartPolicy`): activado.
- Opcional: canal de Slack o Discord vía webhook si ya lo usas.

Esto cubre el caso "el worker arrancó y murió", que el monitor de salud también detecta pero 15
minutos más tarde.

## 3. Sentry · 15 min

El código ya está integrado en los dos procesos; sin DSN no hace nada. Nunca envía cuerpos de
mensajes ni números de teléfono, solo la excepción y sus etiquetas.

### Crear los proyectos

1. sentry.io → crea la organización (plan Developer, gratis, 5.000 errores al mes).
2. **Projects → Create project → Node.js**, nombre `caja-worker`. Copia el DSN (empieza por
   `https://...@o....ingest.sentry.io/...`).
3. **Create project → Next.js**, nombre `caja-web`. Copia su DSN. Si el asistente de Sentry te
   ofrece "run the wizard" o instalar paquetes, ciérralo: ya está hecho en el repo.
4. Alerts → en cada proyecto deja la regla por defecto "Send a notification for new issues" por
   correo. Con eso basta.

### Poner las variables (nunca en el chat ni en el repo)

| Dónde | Variable | Valor | Tipo |
|---|---|---|---|
| Railway → worker → Variables | `SENTRY_DSN` | DSN de `caja-worker` | normal |
| Vercel → proyecto web → Settings → Environment Variables | `SENTRY_DSN` | DSN de `caja-web` | Sensitive está bien |
| Vercel → mismo sitio | `NEXT_PUBLIC_SENTRY_DSN` | DSN de `caja-web` (el mismo) | **Config, no Sensitive**: viaja al navegador |

Marca las de Vercel para Production (y Preview si quieres). Después:

- Railway redespliega solo al guardar la variable. Confirma en Logs la línea `sentry activo`.
- Vercel: Deployments → último → Redeploy (las variables no entran en el deploy que ya corre).

Opcional, para que los errores del navegador muestren la línea de código real y no el bundle
minificado: en Vercel añade `SENTRY_ORG` (el slug de tu organización), `SENTRY_PROJECT` (`caja-web`)
y `SENTRY_AUTH_TOKEN` (Sentry → Settings → Auth Tokens → crear con permiso `project:releases`,
Sensitive). Con esos tres el build sube los source maps; sin ellos no sube nada y no avisa.

Los eventos del navegador salen por `https://caja.jpsoftwaredev.com/monitoring` (túnel propio) y no
directo a sentry.io, así los bloqueadores de contenido del teléfono no los descartan.

### Comprobar

- Worker: en Sentry → `caja-worker` → Issues debe quedar vacío. Para forzar un error sin tocar
  producción, no hace falta: el próximo job que agote reintentos llega solo etiquetado con
  `queue: process-message`.
- Web: abre `https://caja.jpsoftwaredev.com/api/health`; en Sentry → `caja-web` → Performance
  no habrá nada (trazas apagadas, `tracesSampleRate: 0`) y en Issues tampoco. Es lo esperado.
- Si quieres ver un evento real: en el navegador, consola → `throw new Error("prueba sentry")`
  en el dashboard. Aparece en `caja-web` en menos de un minuto. Luego márcalo Resolved.

### Coste

Plan gratuito: 5.000 errores al mes y 30 días de retención. Con las trazas apagadas no se consume
cuota de transacciones. Si un bug en bucle empieza a comerse la cuota, Sentry lo agrupa en un solo
issue y avisa por spike; se corta desactivando la variable.

## Qué queda cubierto después de esto

| Falla | Quién avisa | Cuándo |
|---|---|---|
| Worker muerto o sin base | Better Stack (503) | ≤ 20 min |
| Deploy roto | Railway | al instante |
| Mensaje atascado en la cola | Better Stack (503) | ≤ 8 min |
| Error en un job o en el web | Sentry | al instante, con traza |
| Envíos rechazados por Meta | Railway logs ("Meta rechazó el envío"); `pnpm metrics` los cuenta | manual |
