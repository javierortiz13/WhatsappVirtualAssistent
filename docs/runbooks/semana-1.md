# Semana 1 · Operación del walking skeleton y prueba con cinco personas

Estado al 29/09/2026: el hilo completo funciona en producción. Un mensaje al número de prueba
de Meta llega a Vercel (`/api/whatsapp/webhook`), se encola en Postgres, el worker en Railway lo
procesa con Claude Sonnet 5.5, guarda el movimiento en Supabase y el dueño lo ve en
`https://caja.jpsoftwaredev.com` tras entrar con un enlace por correo.

## 1. Dónde vive cada cosa

| Pieza | Dónde | Cómo se despliega | Logs |
|---|---|---|---|
| Web (webhook, dashboard) | Vercel, proyecto `whatsapp-virtual-assistent-web`, root `apps/web` | push a `claude/whatsapp-assistant-venezuela-wijnh8` (rama de producción) | Vercel → Logs, filtrar `whatsapp` o `confirm` |
| Worker (cola, agente, cron de tasa) | Railway, servicio `@caja/worker` | push a la misma rama. Los "watch patterns" del servicio deben incluir `/apps/worker/**`, `/packages/**` y los manifiestos de la raíz; si no, Railway marca el deploy como SKIPPED y sigue corriendo la versión vieja | Railway → Deploy Logs; "worker listo" muestra `commit` y `agent` |
| Base y cola | Supabase Pro `asistente-caja` (`daomgsvvhvuhiccttrlg`), schemas `app` y `pgboss` | `pnpm db:migrate` desde tu máquina con `DATABASE_ADMIN_URL` | Supabase → Logs → Postgres |
| Acceso al dashboard | Supabase Auth con SMTP de Resend | plantillas "Confirm signup" y "Magic Link" con `token_hash` | Supabase → Logs → Auth; Resend → Emails |
| WhatsApp | Meta app `Asistente de Caja` (publicada), número de prueba `15551800369`, WABA `1086626347062304` | webhook en WhatsApp → Configuración | Meta → WhatsApp → Inicio rápido → actividad del webhook |
| LLM | Anthropic, clave `caja-worker` con tope de gasto | `ANTHROPIC_API_KEY` en Railway | Anthropic console → Usage |

Variables que deben coincidir entre sitios: `META_VERIFY_TOKEN` (Vercel y Meta), `META_APP_SECRET`
(Vercel = clave secreta de la app), `META_ACCESS_TOKEN` (Railway y `.env`, token del usuario del
sistema `caja-worker`, caducidad "Nunca"), `DATABASE_URL` (Vercel, Railway y `.env`, usuario
`caja_app` por el pooler de sesión), `DATABASE_SSL_CA` (Vercel y Railway, PEM completo).

## 2. Rutina diaria de esta semana (5 min)

1. Railway: el log del día debe tener "tasa actualizada" alrededor de las 15:00 a 18:00 Caracas.
   Si dice "ninguna fuente de tasa respondió" dos días seguidos, revisar `parseBcvHtml` contra la
   página del BCV: cambió la estructura.
2. `pnpm metrics` (o `pnpm metrics 1` para solo hoy): mensajes, fallidos, latencia, costo.
3. Vercel → Logs: cualquier 401 en el webhook significa que Meta rotó algo o alguien prueba la URL.

## 3. Prueba con cinco personas

**En Meta** (solo el número de prueba permite hasta 5 destinatarios): Meta → WhatsApp → Inicio
rápido → "Para" → **Administrar lista de números** → agregar el número → la persona recibe un
código por WhatsApp y lo introduce. Sin este paso Meta rechaza la respuesta del bot con el
código 131030 y en Railway sale "Meta rechazó el envío".

**En la base**, cada teléfono debe pertenecer a un negocio. Desde S2 día 3 hay dos caminos:

- **Dashboard** (el de verdad): la persona entra con su correo en `/login`, completa `/registro`
  (nombre, tipo, moneda, su número) y envía el código de 6 dígitos por WhatsApp. Sus empleados los
  agrega en **Ajustes → Números de WhatsApp**; sin código, el primer mensaje los activa. Para que
  el botón "Abrir WhatsApp" lleve el código ya escrito, Vercel necesita `PLATFORM_WA_NUMBER`
  (el número de la plataforma en E.164 sin `+`); sin la variable el botón no aparece y la
  persona escribe el código a mano.
- **CLI** (respaldo mientras dura el número de prueba). Desde tu máquina, con el `.env`:

```bash
# Empleado del autolavado (tu negocio, dueño 17869660391)
pnpm db:phone:add -- --owner 17869660391 --phone 5841XXXXXXX --role employee --name "Carlos"

# Dueña del segundo negocio (cinnamon rolls): ya está en el seed como SEED_SECOND_TENANT_PHONE.
# Para agregarle una empleada:
pnpm db:phone:add -- --owner 5841YYYYYYY --phone 5841ZZZZZZZ --role employee --name "Ana"
```

Un número desconocido recibe el texto fijo con el enlace de registro y no gasta LLM.

**Guion para cada persona** (mándaselo por WhatsApp, tarda 3 minutos):

1. Escribe `hola`. Debe llegar el menú con la tasa.
2. Escribe un gasto real de hoy como lo dirías: `gasté 15$ en champú`, `pagué 450 mil de hielo`,
   `compré 20 dólares de gasolina`. Toca **Guardar**.
2b. Escribe la venta del día: `hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto`. Guardar.
   Luego `hoy vendí 400$` y toca **Agregar** o **Reemplazar** para ver la diferencia.
3. Escribe un gasto de ayer: `ayer pagué 30$ de almuerzo`. Guardar.
4. Escribe algo ambiguo: `compré cera` (sin monto). Debe preguntar el monto.
5. Escribe algo que no es caja: `qué hora es`. Debe decir que solo ayuda con la caja.
6. Toca **Corregir** en un borrador y escribe `eran 18` (o el dato corregido). Guardar.
7. Toca **Cancelar** en otro borrador.

Anota lo que la persona esperaba y no pasó. Eso alimenta las evals de la semana 2.

## 4. Historia de tasas (una vez por proyecto)

El cron solo guarda tasas desde el día en que arrancó. Para que "ayer pagué" y las cargas de
gastos viejos usen la tasa real de su fecha:

1. bcv.org.ve → **Estadísticas → Tipo de cambio de referencia (SMC)** → descarga el Excel del
   período reciente (uno o dos archivos cubren 60 días).
2. Abre el Excel, deja dos columnas, **fecha valor** y **USD**, y guárdalo como CSV
   (`;` como separador está bien; decimales con coma también).
3. `pnpm --filter @caja/worker rates:import ../../tasas.csv`

La importación nunca pisa una tasa tomada en vivo del BCV, y repetirla es inofensiva.

## 5. Medir la semana

**Cupo de Meta desde el 1 de octubre (ADR-014).** Cada respuesta del bot es un mensaje de servicio
cobrado a la tarifa de utilidad del país del cliente, con 1.000 gratis al mes por número de
negocio; las reacciones y lo que escribe el cliente son gratis. Antes del primer mensaje del 1/10:

1. Meta Business Suite → Facturación y pagos → confirma que la cuenta de WhatsApp del portafolio
   tiene una tarjeta válida, sin bloqueo de cargos internacionales. Sin tarjeta, Meta no factura:
   deja de entregar las respuestas y el bot parece mudo. El número de prueba sigue gratis con sus
   5 destinatarios; la tarjeta importa al pasar al número real.
2. El 1/10 temprano, escribe `hola` desde tu teléfono y confirma que llega la respuesta.
3. Cada domingo, la primera tabla de `pnpm metrics` dice cuánto del cupo va usado, la proyección
   del mes y el costo estimado por encima de 1.000 (tarifa en `META_MSG_RATE_USD`, 0,013 por
   defecto; verifica la de Venezuela en la tabla oficial de precios de Meta). Si la proyección
   pasa de 1.000 con pocos negocios, toca la conversación de un número por negocio (ADR-002).


`pnpm metrics` imprime, para los últimos 7 días: mensajes por día, latencia p50 y p95 separando
turnos del agente de respuestas deterministas, costo del LLM total y promedio, herramientas
elegidas, eventos del webhook por estado y movimientos guardados. Llena esta tabla el domingo:

| Métrica | Valor | Meta de la Fase 8 |
|---|---|---|
| Mensajes entrantes en la semana | | ≥ 30 de ≥ 2 personas |
| Gastos guardados | | ≥ 10 |
| Latencia p50 turno de agente | | ≤ 4 s |
| Latencia p95 turno de agente | | ≤ 8 s |
| Costo promedio por turno de agente | | ≤ 0,01 USD |
| Envíos fallidos | | 0 tras la configuración |
| Mensajes de servicio enviados en el mes (cupo 1.000) | | proyección < 1.000 |
| Salientes por entrante | | ≤ 1,1 |
| Fallos del agente (respuesta equivocada) | | anotar cada uno |

## 6. Rotación y emergencias

**Un teléfono no recibe respuesta y los demás sí.** Mira en Supabase si hay jobs de ese número
atascados: `select id, state, created_on from pgboss.job where name = 'process-message' and
singleton_key = '<e164>' order by created_on desc`. Si hay uno en `failed`, bloquea a los demás
(cola FIFO por teléfono). El housekeeping lo cancela solo en menos de 5 minutos; para no esperar,
`update pgboss.job set state = 'cancelled' where id = '<id>'`. Después revisa en Railway por qué
falló.

**Monitor de salud (S2 día 3).** `GET /api/health` en el dashboard responde 200 si la base
contesta, el worker terminó un housekeeping hace menos de 15 minutos y ningún mensaje lleva más de
3 minutos esperando; 503 si algo de eso falla, con el detalle en JSON (solo banderas y edades, sin
datos de negocio). Para que alguien avise, un monitor externo gratuito lo consulta cada 5 minutos:

1. Better Stack (betterstack.com, plan gratuito) o UptimeRobot → nuevo monitor HTTP →
   URL `https://<dominio del dashboard>/api/health` → intervalo 5 min → alerta por correo y
   por la app del móvil cuando el estado no sea 200.
2. En Railway → servicio worker → Settings → Notifications: avisos de deploy fallido y de
   reinicio por crash al correo.
3. Prueba: pausa el worker en Railway; a los 15 minutos el monitor debe avisar; reanuda y debe
   recuperarse solo.

**"max clients reached in session mode" en Railway.** El pooler de Supabase admite 15 clientes por
rol y en cada deploy conviven dos workers. Si se repite, sube el Pool Size a 30 en Supabase →
Project Settings → Database → Connection pooling.


- **Token de Meta comprometido**: Business Manager → Usuarios del sistema → `caja-worker` →
  Revocar tokens → generar uno nuevo → Railway y `.env`. Un minuto de corte.
- **Clave de Anthropic**: console → API keys → desactivar → crear → Railway. El worker arranca en
  modo stub si falta la variable (responde "fuera de alcance"), así que no se cae.
- **Pausar el bot**: Railway → servicio → **Remove deployment** o poner `WORKER_CONCURRENCY=0`
  no existe; lo más simple es detener el servicio. Los mensajes quedan en la cola y se procesan
  al volver, salvo los de más de 12 h, que se marcan vencidos sin responder.
- **Meta bloquea el número de prueba**: no hay recurso; pasar a número propio (S2).

## 7. Deuda técnica explícita al cierre de S1

Ordenada por lo que más duele en el piloto:

1. ~~Onboarding~~ Hecho en S2 día 3: registro en `/registro`, código por WhatsApp, empleados desde Ajustes.
2. ~~Cierres, consultas, corregir y borrar por chat~~ Hechos en S2 (días 1 y 2).
3. ~~Listas `currency:` y `cat:`~~ Hecho en S2 día 3: botones Dólares / Bolívares y reinyección al
   agente con el historial.
4. ~~Tasa manual como corrección~~ Hecho en S2 día 2 (migración 0003).
5. **Historia de tasas automática**: hoy es CSV manual; evaluar el Excel del BCV por script. S2.
6. **Voz y foto**: responden "todavía no". S4.
7. **Dashboard**: solo lectura; sin edición, borrado, exportación, categorías ni números. S5.
8. **Términos de servicio**: la URL en Meta apunta a la política de privacidad. Antes del primer cobro.
9. **Portafolio de Meta**: la app vive en "Just Travel"; mover la WABA al portafolio de la empresa
   venezolana al verificarla. S2.
10. **Sentry sin DSN**: el código está, falta crear los proyectos y poner las variables. Cuando
    haya un error que no se vea en logs.
11. ~~Railway sin health check ni alerta~~ Hecho en S2 día 3: `/api/health` en el web; falta
    crear el monitor externo (sección 6).
12. **Evals**: 16 casos; agregar los fallos reales de esta semana antes de tocar el prompt.
