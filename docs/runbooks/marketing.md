# Runbook · Landing y enlaces de campaña

## 1. La landing

Vive en `https://caja.jpsoftwaredev.com/` (`apps/web/app/page.tsx` + `(marketing)/landing.tsx`,
`story.tsx` y `landing.css`). Posicionamiento: **un asistente administrativo por WhatsApp** que
hace la parte de la caja que hoy hace una persona, por una fracción del sueldo (300 USD de
referencia, en `ADMIN_SALARY` dentro de `landing.tsx`).

La página es una conversación. Tras la portada, el teléfono queda fijo y, al bajar, el visitante
"le escribe" al asistente (hola, qué haces, un gasto, Guardar, cierre, cuánto cuestas, mis datos,
quiero empezar) y las respuestas son el servicio. Las escenas están en `scenes()` dentro de
`landing.tsx`: cada una tiene el mensaje del usuario, la respuesta y el titular lateral. Agregar
una escena es agregar un objeto a esa lista. Debajo: planes, preguntas y cierre.

- **Cambiar un precio o un límite**: `apps/web/lib/plans.ts`. La landing lo lee de ahí.
- **Cambiar la nota del piloto** ("Durante el piloto no se cobra…"): `PILOT_NOTE` en el mismo archivo.
- **Cambiar textos**: `landing.tsx`. Las preguntas frecuentes están en `FAQ`, las funciones en `FEATURES`.
- **El botón "Probar por WhatsApp"** usa `PLATFORM_WA_NUMBER` de Vercel. Sin la variable manda a /login.
- Los efectos de scroll se apagan solos si el teléfono tiene "reducir movimiento" activado.

## 2. Enlaces cortos con UTM

Cada canal tiene su enlace `/ir/<slug>` que redirige a la portada con sus parámetros UTM. Así se
sabe de dónde vino cada visita y cada registro. Se definen en `apps/web/app/ir/links.ts`.

| Enlace | Para qué | UTM |
|---|---|---|
| `caja.jpsoftwaredev.com/ir/ig` | bio de Instagram | instagram / bio / lanzamiento |
| `…/ir/igad` | anuncios de Instagram | instagram / ad / lanzamiento |
| `…/ir/fb` | publicaciones de Facebook | facebook / post / lanzamiento |
| `…/ir/tiktok` | videos | tiktok / video / lanzamiento |
| `…/ir/wa` | estados y grupos de WhatsApp | whatsapp / estado / lanzamiento |
| `…/ir/flyer` | código QR impreso en autolavados | flyer / qr / autolavados |
| `…/ir/registro` | mensaje directo a un interesado | whatsapp / mensaje / piloto |

Convención: `utm_source` = canal, `utm_medium` = formato, `utm_campaign` = nombre corto de la
pieza, `utm_content` = el slug. Para una campaña nueva se agrega una línea en `links.ts`.

**Medir.** Activa Vercel Analytics en el proyecto (Analytics → Enable, plan gratuito). Muestra
visitas por página y por `utm_source`. Cuando haga falta más, se agrega `@vercel/analytics` al
layout; no está puesto para no cargar nada que no se use todavía.

## 3. Textos listos para anuncios

**Instagram / Facebook, imagen del teléfono con el chat**

> Una administradora cuesta $300 al mes. Tu asistente de caja, $20. Le escribes "gasté 15$ en
> champú" y lo anota con la tasa BCV del día; al cerrar le escribes "cierre" y te dice cuánto
> efectivo debe haber. 24 horas, sin app, sin sueldo. Pruébalo gratis → caja.jpsoftwaredev.com/ir/igad

**Estado de WhatsApp (corto)**

> ¿Pagas a alguien solo para que lleve el cuaderno de la caja? Un asistente por WhatsApp lo hace
> por $20 al mes, y nunca se le olvida la tasa. Gratis durante el piloto: caja.jpsoftwaredev.com/ir/wa

**Flyer con QR, para autolavados y bodegas**

> Tu asistente administrativo por WhatsApp. Anota gastos y ventas, cuida la tasa BCV y te da el
> cierre cada noche. Lo que cuesta una tarde de trabajo, no un sueldo. Escanea y empieza en 3 minutos.

**Sobre la comparación con el sueldo.** Es honesta solo si se dice qué parte reemplaza: anotar,
convertir, cuadrar y cerrar. No factura, no lleva inventario ni nómina. La pregunta frecuente
"¿De verdad reemplaza a una administradora?" lo deja claro en la landing; en anuncios cortos se
usa "la parte de la caja" cuando quepa.

## 4. Antes de pagar un anuncio

- La cuenta de Meta Ads debe tener el método de pago y el dominio verificado (Business Manager →
  Dominios). Es el mismo portafolio del WhatsApp Business.
- Enlazar anuncios directo a WhatsApp ("click to WhatsApp") requiere el número real, no el de
  prueba: hasta la verificación del negocio, los anuncios van a la landing.
