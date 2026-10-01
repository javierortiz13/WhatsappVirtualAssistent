# Modelo de negocio · borrador v0 (01/10/2026)

Borrador para discutir y ajustar con los datos del piloto. Todo número marcado con **(h)** es
hipótesis; los demás tienen fuente al pie. Los planes viven en `apps/web/lib/plans.ts` y la
landing los lee de ahí: cambiar un precio es cambiar una línea.

## 1. Resumen en diez líneas

- Producto: un asistente administrativo por WhatsApp que hace la parte de la caja que hoy hace una
  persona. Escribes, dictas o mandas la foto; él registra con la tasa BCV del día y te da el cierre.
  Dashboard para corregir y exportar. Ancla de precio: el sueldo de una administradora (~300 USD/mes,
  hipótesis) frente a 19,99 del plan Negocio.
- Dos segmentos con el mismo motor: **finanzas personales** (una persona, su número) y **negocio
  pequeño** (dueño más empleados, ventas y cierre).
- El costo variable dominante no es la IA: es el mensaje de servicio de WhatsApp, que Meta cobra
  desde el 1/10/2026 a 0,0113 USD en "Rest of Latin America" (Venezuela) tras 1.000 gratis al mes
  por número de plataforma.
- Costo variable estimado por cliente: ~2,5 USD/mes en Personal y ~11 USD/mes en Negocio.
- Precios propuestos: Personal 4,99 · Negocio 19,99 · Negocio Plus 39,99 USD/mes **(h)**.
- Costo fijo de la plataforma hoy: ~45 USD/mes. Punto de equilibrio: 5 clientes Negocio o 18
  Personal.
- Cobro: Pago Móvil, Zelle o USDT a mano los primeros meses; no hay Stripe en Venezuela.
- Lo que el piloto tiene que confirmar: mensajes por cliente al mes, mezcla voz/foto, y cuántos
  mensajes salientes por cada entrante (hoy 1,1 por diseño).

## 2. Mercado

**Por qué WhatsApp y por qué Venezuela.** El 92 % de los venezolanos usa WhatsApp a diario para
hablar con empresas y es la aplicación comercial número uno del país [5]. El comercio electrónico
creció 125 % en 2025 según Cavecom-e [6] y el 90 % de los emprendimientos ya vende por canales
digitales [6]. El pedido por WhatsApp es el flujo por defecto del pequeño comercio [7]. Nadie
tiene que aprender una app nueva: la caja entra por el mismo chat donde ya venden.

**Segmentos.**

| Segmento | Quién | Dolor | Qué paga hoy |
|---|---|---|---|
| Personal | Asalariado o freelancer con ingresos en $ y gastos en Bs; quiere saber en qué se va el dinero | Apps de gastos que se abandonan a la semana; conversión Bs/$ a mano | Nada, o 4 a 10 USD en bots de finanzas (ver §3) |
| Negocio pequeño | Autolavado, panadería, bodega, peluquería: 1 a 5 personas, caja en efectivo, Pago Móvil y punto | El cierre de la noche en papel o Excel; el dueño no sabe el neto del día hasta el fin de semana | 10 a 35 USD/mes en sistemas de punto de venta (ver §3), o cero y un cuaderno |

**Tamaño.** No hay una cifra pública confiable de microempresas activas en Venezuela para 2026; las
fuentes consultadas hablan de tendencias, no de conteos [5][6][7]. Para el borrador basta con la
cuenta de abajo: el punto de equilibrio son cinco negocios.

## 3. Competencia y precios de referencia

**Bots de finanzas personales por WhatsApp (LatAm)** [1][2][3]

| Producto | Gratis | De pago | Notas |
|---|---|---|---|
| Gasti (Argentina, LatAm) | Sí, limitado | Pro 6,99 · Premium 9,99 USD/mes | Voz y foto en los planes de pago; cobra en pesos por Mercado Pago |
| AI Money | 2 registros/día por WhatsApp, audios de 30 s | Pro 3,99 USD/mes | La app completa es gratis; cobra por el canal WhatsApp |
| FinAI | Básico gratis | Premium 3,99 USD/mes | |
| Fadi (Colombia) | Gratis | | Notas de voz |

Lectura: el mercado personal está entre **3,99 y 9,99 USD**, con capa gratis casi siempre. Ninguno
está hecho para Venezuela: no manejan tasa BCV ni la mezcla Bs/$ de un mismo día.

**Sistemas de caja y ventas para negocios en Venezuela** [4]

| Producto | Precio | Qué es |
|---|---|---|
| Clarito | desde 10 USD/mes | Ventas, inventario multimoneda, catálogo |
| AXI | 19,99 a 24,99 USD/mes | Sistema administrativo |
| VE-Commerce | Pro 30 USD/mes | Punto de venta con tasa BCV |
| Fina | 35 USD/mes + IVA | Software de ventas para tiendas |
| FrixPOS | gratis; pagos desde 990 Bs/mes | Punto de venta para bodegas |

Lectura: el rango es **10 a 35 USD/mes** por sistemas que exigen sentarse frente a una pantalla.
Nuestro producto no compite en inventario ni facturación; compite en "la caja del día sin
sentarse". Un precio de 19,99 queda en la mitad del rango y por debajo de lo que un dueño ya
paga por un POS.

## 4. Costos unitarios

**Supuestos de uso (h)**: cada registro del usuario produce 1,1 mensajes de servicio del bot
(ADR-014: una respuesta por mensaje; acuses como reacciones, que son gratis). Un 20 % de los
registros son notas de voz de 20 s; un 10 % son fotos.

| Concepto | Unidad | Costo | Fuente |
|---|---|---|---|
| Mensaje de servicio de WhatsApp | por mensaje del bot | 0,0113 USD tras 1.000 gratis/mes por número de plataforma | [8] |
| Turno del agente (Sonnet 5.5, caché de prompt) | por registro | 0,0032 USD medido en evals; 0,004 para el cálculo | evals v1, 51 casos, 0,165 USD |
| Transcripción (Deepgram Nova-3) | por minuto | 0,0077 USD → 0,0026 por nota de 20 s | [9] |
| Lectura de factura (Sonnet 5.5 con imagen) | por foto | ~0,008 USD **(h)** | estimado por tokens de imagen |

**Por cliente y mes**

| Plan | Registros | Meta (1,1 × 0,0113) | IA | Voz + foto | Total variable |
|---|---|---|---|---|---|
| Personal | 150 | 1,86 | 0,60 | 0,20 | **~2,7 USD** |
| Negocio | 600 | 7,46 | 2,40 | 0,80 | **~10,7 USD** |
| Negocio Plus | 1.500 | 18,64 | 6,00 | 2,00 | **~26,6 USD** |

Dos observaciones que cambian el negocio:

1. **Meta pesa 70 % del costo variable.** Cada mensaje que el bot no manda es margen. De ahí
   ADR-014: una respuesta por mensaje y reacciones en vez de acuses.
2. **Los 1.000 gratis son por número de plataforma, no por cliente.** Con un solo número (ADR-002)
   se agotan con el segundo negocio. Un número propio por negocio regala 1.000 mensajes al mes a
   ese cliente (≈ 11 USD de costo evitado) a cambio de un número, su verificación y la operación.
   Para el plan Negocio Plus el número propio es casi obligatorio; para Personal no tiene sentido.
   Decisión pendiente para después del piloto, con la medición real de mensajes.

**Costo fijo de la plataforma (hoy)**

| Servicio | USD/mes |
|---|---|
| Supabase Pro | 25 |
| Railway (worker) | 5 a 10 |
| Vercel (Hobby) | 0 |
| Sentry, Better Stack, Resend (planes gratis) | 0 |
| Dominio | ~1,5 (anual prorrateado) |
| **Total** | **~35 a 45** |

## 5. Planes propuestos (h)

| | Personal | Negocio | Negocio Plus |
|---|---|---|---|
| Precio | **4,99** USD/mes | **19,99** USD/mes | **39,99** USD/mes |
| Números | 1 | dueño + 1 empleado | dueño + 3 empleados |
| Registros al mes | 150 (~5/día) | 600 (~20/día) | 1.500 |
| Texto, voz, foto | sí | sí | sí |
| Ventas y cierre del día | no (resumen semanal y mensual) | sí | sí |
| Dashboard y Excel | sí | sí | sí |
| Soporte | por correo | por WhatsApp | prioritario |

Reglas de cupo: al 80 % del cupo el bot avisa una vez; al 100 % sigue registrando pero avisa que
el mes que viene conviene el plan siguiente (no se bloquea a nadie a mitad de cierre; el límite
duro se evalúa después del piloto). Los mensajes del bot y las reacciones no cuentan.

**Por qué estos precios.** Personal a 4,99 está en la mitad del rango de Gasti y AI Money y
cobra el diferencial venezolano (Bs/$ y BCV). Negocio a 19,99 es el precio de un POS básico en
Venezuela por un producto que se usa desde el bolsillo, y deja margen para un número propio si
el piloto muestra que hace falta. Negocio Plus existe para que el Negocio no parezca el techo.

## 6. Márgenes y punto de equilibrio

| Plan | Precio | Variable | Margen bruto | % |
|---|---|---|---|---|
| Personal | 4,99 | 2,7 | 2,3 | 46 % |
| Negocio | 19,99 | 10,7 | 9,3 | 46 % |
| Negocio Plus | 39,99 | 26,6 | 13,4 | 33 % |

Con 40 USD de fijo: **5 clientes Negocio**, o 18 Personal, o 3 Plus cubren la plataforma. A
partir de ahí cada Negocio deja ~9 USD. Con 30 negocios: ~280 USD/mes de margen bruto antes del
tiempo del fundador. Es un negocio de volumen o de servicio premium (implementación de Odoo,
fuera del MVP), no de pocos clientes.

**Sensibilidad.** Si los registros reales por negocio son 1.000 en vez de 600, el variable sube
a ~17 USD y el margen de Negocio cae a 15 %. Esa es la cifra que el piloto tiene que dar antes
de fijar precios. Si el número propio por negocio resulta viable, el variable de Negocio baja a
~3,3 USD y el margen sube a 83 %.

## 7. Cobro y operación

- Sin Stripe ni tarjetas en Venezuela: Pago Móvil en Bs a la tasa BCV del día, Zelle o USDT.
  Cobro manual y marcado en el dashboard los primeros meses; automatizar cuando pase de 20 clientes.
- Prueba gratis: el piloto y los primeros clientes entran sin cobro; después, 14 días gratis con
  los límites del plan Negocio.
- Factura: recibo simple por correo; la facturación fiscal queda para cuando haya empresa.

## 8. Qué tiene que responder el piloto

| Pregunta | Dónde se mide | Reemplaza |
|---|---|---|
| Registros por negocio y mes | `pnpm metrics 30` | el 600 (h) |
| Salientes por entrante | `pnpm metrics` | el 1,1 |
| % de voz y de foto | `message.kind` | el 20 % / 10 % |
| Costo de IA por turno en producción | `message.cost_usd` | el 0,004 |
| Si el dueño pagaría 19,99 | preguntarle al día 30 | la hipótesis entera |

## Fuentes

1. Periodismo.com, "10 chatbots de WhatsApp que ayudan a ordenar las finanzas personales" (jul 2026): https://www.periodismo.com/2026/07/14/10-chatbots-de-whatsapp-que-ayudan-a-ordenar-las-finanzas-personales/
2. Gasti: https://gasti.pro/ · FinAI: https://finbotai.co/
3. AI Money, "La mejor app para controlar gastos por WhatsApp": https://www.ai-money.app/es/blog/mejor-app-para-controlar-gastos-por-whatsapp/
4. Clarito: https://clarito.app/ · AXI: https://axivende.com/ · VE-Commerce: https://ve-commerce.com/ · Fina: https://www.finapartner.com/ · FrixPOS: https://frixpos.com/
5. Agencia Since, "Marketing digital en Venezuela 2025": https://agenciasincemarketing.com/blog/marketing-digital-venezuela/
6. El Diario, "Negocios digitales en Venezuela" (abr 2025): https://eldiario.com/2025/04/29/negocios-digitales-venezuela-rentabilidad-redes-sociales/
7. Vercatalogo, "Plataformas para vender online en Venezuela 2026": https://vercatalogo.com/blog/plataformas-para-vender-en-venezuela
8. Meta, "Upcoming pricing updates for service and utility messages": https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages · resumen por región: https://www.flowcall.co/blog/whatsapp-business-api-pricing
9. Deepgram Nova-3, precio por minuto: https://convertaudiototext.com/blog/deepgram-nova-3-explained
