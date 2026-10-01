# Runbook · Landing y enlaces de campaña

## 1. La landing

Vive en `https://caja.jpsoftwaredev.com/` (`apps/web/app/page.tsx` + `(marketing)/landing.tsx`,
`story.tsx` y `landing.css`). Posicionamiento: **un asistente administrativo por WhatsApp** que
hace la parte de la caja que hoy hace una persona, por una fracción del sueldo (300 USD de
referencia, en `ADMIN_SALARY` dentro de `landing.tsx`).

La página es una conversación. Tras la portada, en escritorio el teléfono queda fijo y el scroll
envía los mensajes; en el móvil el visitante toca el botón de enviar de un iPhone dibujado en CSS
(sin imágenes ni librerías) y así "le escribe" al asistente (hola, qué haces, un gasto, Guardar, cierre, cuánto cuestas, mis datos,
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

## 5. Foto del hero (Nano Banana u otro generador)

La portada se activa sola con una foto: deja el archivo en `apps/web/public/hero.jpg` y la
página la muestra con las dos tarjetas de la comparación encima. Sin el archivo se ven solo las
tarjetas. Formato: JPG, 1200 × 1500 px (4:5, vertical), menos de 300 KB (exporta a calidad 80).

Lo que tiene que transmitir: una persona real de un negocio pequeño venezolano, en su local, con
el teléfono en la mano, tranquila. Nada de pantallas con texto (lo pone la página), nada de
oficinas ni laptops, nada de "stock" sonriendo a cámara.

**Prompt principal (en inglés, los generadores responden mejor):**

> Editorial photograph, vertical 4:5. A Venezuelan small business owner in his late 30s stands
> behind the counter of his car wash at dusk, holding a smartphone in one hand and glancing at it
> with a calm half-smile, as if he just sent a quick message. Behind him, out of focus: a freshly
> washed car with water drops catching warm light, pressure washer hoses, a hand-painted price
> board in Spanish. He wears a worn polo shirt with a small logo, a cap, a towel over one
> shoulder. Natural light mixed with warm tungsten bulbs, teal and amber tones, shallow depth of
> field, 35 mm lens, candid documentary style, slight film grain. No text on the phone screen, no
> visible brand logos, no watermark.

**Variantes para probar:**

- Bodega: *"…a woman in her 50s at the counter of a small neighborhood grocery store (bodega) in
  Caracas, shelves of products behind her, a bolívar and dollar price sign, holding her phone
  with one hand while the other rests on the counter…"*
- Panadería: *"…a young baker in a flour-dusted apron leaning on the glass counter of a small
  bakery at closing time, trays of cachitos behind her, phone in hand…"*
- Peluquería: *"…a barber in his 40s in his two-chair barbershop, mirror and clippers behind
  him, checking his phone between clients…"*

**Para la imagen del anuncio** (cuadrada, 1:1), el mismo prompt cambiando el encuadre: *"square
1:1, tighter framing on the hands and the phone, the counter and cash drawer visible"*.

Lo que no sirve: fotos con texto generado (sale mal escrito), personas mirando a cámara con
sonrisa de catálogo, iPhones con el logo visible, oficinas.
