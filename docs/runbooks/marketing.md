# Runbook · Landing y enlaces de campaña

## 1. La landing

Vive en `https://caja.jpsoftwaredev.com/` (`apps/web/app/page.tsx` + `(marketing)/landing.tsx` +
`landing.css`). Mismo sistema visual del dashboard. Secciones, en orden: portada con el teléfono
animado, cómo funciona (los tres hábitos), funciones, dashboard, planes, preguntas, cierre.

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

> Tu caja, por WhatsApp. Escribes "gasté 15$ en champú" y queda registrado con la tasa BCV del
> día. Al cerrar escribes "cierre" y sabes cuánto efectivo debe haber. Sin app, sin Excel.
> Pruébalo gratis → caja.jpsoftwaredev.com/ir/igad

**Estado de WhatsApp (corto)**

> ¿Cierras la caja en un cuaderno? Dictale los gastos a un número de WhatsApp y te da el cierre.
> Gratis durante el piloto: caja.jpsoftwaredev.com/ir/wa

**Flyer con QR, para autolavados y bodegas**

> La caja del día sin sentarte. Escribe, dicta o manda la foto de la factura. Bs y $ con la tasa
> del BCV. Escanea y empieza en 3 minutos.

## 4. Antes de pagar un anuncio

- La cuenta de Meta Ads debe tener el método de pago y el dominio verificado (Business Manager →
  Dominios). Es el mismo portafolio del WhatsApp Business.
- Enlazar anuncios directo a WhatsApp ("click to WhatsApp") requiere el número real, no el de
  prueba: hasta la verificación del negocio, los anuncios van a la landing.
