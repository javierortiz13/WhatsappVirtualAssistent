# Documento de Diseño del MVP

Asistente de caja por WhatsApp para pymes venezolanas.

Documento acumulativo. Cada fase agrega una sección al cerrarse.

| Fase | Estado |
|---|---|
| 0. Descubrimiento (Product Brief) | Aprobado |
| 1. Requerimientos | Aprobado |
| 2. Modelo de dominio y datos | Aprobado |
| 3. Arquitectura | Aprobado |
| 4. UX conversacional | Entregado, pendiente de aprobación |
| 5. UX/UI dashboard | Pendiente |
| 6. Stack tecnológico | Pendiente |
| 7. Seguridad, cumplimiento y riesgos | Pendiente |
| 8. Plan de ejecución | Pendiente |

---

## Fase 0. Product Brief

### Nombre de trabajo

Libro de caja por WhatsApp para pymes venezolanas.

Posicionamiento ante Meta y ante el cliente: sistema de registro de caja con interfaz de WhatsApp. No es un chatbot de IA de propósito general.

### Problema

El dueño de un negocio pequeño en Venezuela sabe cuánto gasta y cuánto vende, pero la información se pierde entre cuadernos, Excel y chats. Lo que se registra llega tarde, con la tasa BCV equivocada, en el día equivocado, o no llega. Al cierre del mes no sabe si ganó o perdió, y no puede analizar nada porque la data no es confiable.

Origen del problema (caso del fundador): autolavado con Odoo implementado. Los gastos se mandan por WhatsApp a la cajera y ella no los registra, o los registra con tasa o fecha equivocadas. La base de datos existe, la data no sirve.

### Usuario objetivo

- Dueño de negocio pequeño, 1 a 10 empleados: autolavado, bodega, ferretería pequeña, emprendimiento de comida, servicios.
- Lleva las cuentas en Excel o cuaderno. No tiene sistema administrativo.
- Opera en USD y Bs. Ejecuta la mayoría de los gastos en persona.
- Vive en WhatsApp. Nivel tecnológico bajo a medio. Muchos solo usan el teléfono.

Pilotos:
1. Autolavado del fundador (Odoo sigue haciendo POS e inventario; el asistente lleva los gastos y el cierre).
2. Emprendimiento de cinnamon rolls (pareja del fundador). Segmento distinto: pedidos, ingredientes, ventas por lote.

Sesgo conocido: ambos pilotos son del círculo del fundador. No validan la disposición a pagar de un desconocido.

### Propuesta de valor

Registras un gasto o la venta del día como le escribirías a tu cajera: texto, nota de voz o foto de la factura. El sistema lo guarda al momento, con la moneda original y la tasa BCV vigente ese día, y te devuelve el cierre del día y el resultado del mes cuando lo pidas, sin abrir nada. El dashboard existe para ver, corregir y exportar a Excel.

### Alcance del MVP (Must)

1. Registrar gasto: texto, nota de voz, foto de factura. Categoría, monto, moneda, tasa del día. Confirmación explícita antes de guardar.
2. Registrar ingreso: totales del día por método de pago (efectivo USD, efectivo Bs, Pago Móvil, punto, Zelle, otro). Transacciones sueltas opcionales.
3. Cierre del día y resultado del período: ingresos, gastos, diferencia, desglose por método y categoría. Cálculo determinista en backend, nunca en el LLM.
4. Consultas simples: "¿cuánto gasté en champú este mes?", "¿cuánto llevo vendido esta semana?".
5. Dashboard web mobile-first: ver, corregir, exportar a Excel. Onboarding del negocio y vinculación del número.
6. Tasa BCV automática diaria (cron, fuente principal más respaldo, distinguiendo "vigente hoy" de "última publicada"). Se expone como consulta porque cuesta cero.
7. Roles por número: dueño (todo) y empleado (registra, no consulta totales). Permiso mínimo, sin flujo propio.

### Fuera de alcance del MVP

- Inventario y stock.
- Presupuestos por categoría y "¿cuánto me queda?".
- Clientes, pedidos, CRM.
- Verificación de Pago Móvil (una captura no verifica nada; a lo sumo "registrado, pendiente de conciliar", y eso es iteración 2).
- Integración con Odoo. Vuelve como servicio premium con implementación cobrada aparte. El patrón adapter queda como costura, pero solo se implementa el proveedor local.
- Costo por carro o cualquier receta de insumos.
- Alertas proactivas por plantilla pagada (recordatorio de cierre, resumen automático a las 7 pm). Iteración 2.
- Bot de atención a clientes finales.
- Más de un número de WhatsApp por tenant.

### Métricas de éxito del piloto (30 días, autolavado)

- 100% de los gastos registrados el mismo día con la tasa BCV vigente, sin tocar Excel ni Odoo para eso.
- Cierre del día pedido al menos 5 de cada 7 días, y cuadra con el conteo de caja.
- Tiempo de revisión diaria del dueño baja al menos 30 minutos. Medir dos semanas antes y dos después.
- Mensajes que el bot no entendió o registró mal: menos del 5%, medido por correcciones hechas en el dashboard.

### Modelo de negocio (hipótesis)

- Suscripción mensual por negocio: 20 USD (hipótesis del fundador, sin análisis de mercado todavía).
- Restricción derivada: costo total por tenant (LLM + Meta + infra) por debajo de 5 USD al mes.
- Odoo como servicio premium: implementación y entrenamiento con cobro único, más la suscripción.
- Medio de cobro al cliente: por definir (Pago Móvil, Zelle, USDT).

### Restricciones del fundador

- Un solo desarrollador. Una semana libre a tiempo completo al inicio; después, horas parciales junto a un trabajo a tiempo completo.
- Presupuesto del piloto para infra, LLM (API) y Meta: se asume un techo de 30 a 50 USD al mes. Las suscripciones de herramientas de desarrollo (Claude, Gemini) no cuentan aquí.
- Se buscará reutilizar componentes de proyectos previos del fundador. Stack por confirmar en la Fase 6.

### Supuestos a validar

1. Un dueño sin sistema escribe los totales del día todos los días. Una fricción diaria es tolerable.
2. La nota de voz venezolana, con ruido de negocio, se transcribe con precisión utilizable.
3. Hay dueños fuera del círculo del fundador que pagan 20 USD al mes por esto.
4. Meta aprueba el número y el caso de uso como sistema de gestión, no como chatbot de IA. El texto vigente de la política debe verificarse antes de solicitar el número.
5. La verificación de negocio en Meta con documentos venezolanos se completa en un plazo razonable.

### Decisiones tomadas en la Fase 0

- Backend único del MVP: base de datos propia. Odoo sale del MVP y vuelve como premium.
- El fundador es el primer piloto sobre la base de datos propia. Su Odoo sigue intacto para POS.
- Producto = libro de caja por WhatsApp. No CRM, no inventario, no presupuestos.
- Ingresos por totales del día; transacción suelta opcional. El modelo de datos trata ambos como movimientos.
- Skill de tasa BCV se mantiene por costo cero, no como gancho.
- El usuario es el dueño. El rol empleado es un permiso, no un flujo.
- El cierre del día se calcula desde la base de datos, nunca interpretando un documento.
- Semana 1 = walking skeleton con el número de prueba de Meta (hasta 5 destinatarios): gastos por texto end-to-end y dashboard con lista y corrección. Voz, foto, ingresos y cierre en semanas 2 y 3.

### Preguntas abiertas

- Stack de los proyectos previos del fundador que se quieren reutilizar (Fase 6).
- Si la Cloud API soporta grupos hoy (verificar en la documentación de Meta). Diseño asume chat 1:1.
- Texto vigente de la política de IA de WhatsApp Business (verificar antes de solicitar el número).
- Créditos de API existentes en Anthropic o Google (Fase 6).
- Medio de cobro al cliente.

### Riesgos detectados

| Riesgo | Mitigación |
|---|---|
| El dueño no escribe el total del día y el cierre no existe | Recordatorio por plantilla en iteración 2; dashboard como respaldo |
| Pilotos sesgados (círculo del fundador) | Tercer piloto desconocido antes de la semana 8 |
| Transcripción de voz con ruido y jerga dispara la tasa de error | Siempre mostrar lo entendido y pedir confirmación antes de guardar |
| Verificación de Meta se demora semanas | Arrancar piloto con número de prueba; solicitar verificación en la semana 1 |
| Un solo número para todos los tenants: un bloqueo de Meta tumba a todos los clientes | Evaluar en Fase 7; respetar políticas al pie de la letra |
| Presión del piloto de cinnamon rolls hacia pedidos y clientes | Fuera de alcance explícito; anotar como backlog post-MVP |

---

## Fase 1. Requerimientos

### Convenciones

- Formato de historia: **Como** [rol], **quiero** [acción], **para** [beneficio]. Criterios en Dado / Cuando / Entonces.
- Roles: **Dueño** (todo), **Empleado** (registra gastos e ingresos, no consulta totales ni configura), **Sistema** (cron, webhooks).
- Prioridad MoSCoW. El MVP incluye solo los **Must**. Los Should son la iteración 2. Los Could no tienen fecha. Los Won't están descartados a propósito.
- Tamaño: S (menos de medio día), M (1 a 2 días), L (3 a 5 días). Estimación para un solo dev con asistencia de IA, ya con el walking skeleton hecho.
- Regla transversal a todas las historias de escritura: **el LLM no calcula ni inventa cifras**. Extrae campos; el backend valida, convierte con la tasa del día y guarda. Toda escritura pide confirmación explícita.

### Épica A. Onboarding y acceso

**US-A1. Registrar el negocio (Must, M).**
Como dueño, quiero crear mi negocio desde el dashboard, para empezar a registrar movimientos.
- Dado que entro al dashboard sin cuenta, cuando indico mi correo, entonces recibo un enlace de acceso (magic link) válido por 15 minutos.
- Dado que accedo por primera vez, cuando completo nombre del negocio, tipo, moneda de referencia (USD por defecto) y mi número de WhatsApp en formato internacional, entonces el sistema crea el tenant con zona horaria America/Caracas y categorías por defecto según el tipo de negocio.
- Dado que el número ya está vinculado a otro tenant, cuando intento registrarlo, entonces el sistema lo rechaza y me indica que un número solo puede pertenecer a un negocio.

**US-A2. Vincular mi número de WhatsApp (Must, M).**
Como dueño, quiero probar que ese número es mío, para que nadie registre gastos en mi negocio.
- Dado que registré mi número, cuando el dashboard me muestra un código de 6 dígitos y un botón "Abrir WhatsApp", entonces al enviar ese código desde ese número al número de la plataforma, el sistema marca el número como verificado y responde con el saludo de bienvenida.
- Dado que envío un código incorrecto, cuando lo recibe el sistema, entonces responde que el código no coincide, sin revelar a qué negocio pertenece el número.
- Dado que el código tiene más de 15 minutos, cuando lo envío, entonces el sistema lo rechaza y el dashboard permite generar uno nuevo.

**US-A3. Rechazar números desconocidos (Must, S).**
Como sistema, quiero responder a un número no vinculado con una instrucción breve, para no filtrar información ni gastar LLM.
- Dado que llega un mensaje de un número que no está en ningún tenant, cuando lo proceso, entonces respondo un texto fijo (sin LLM) con el enlace de registro y no guardo el contenido del mensaje.
- Dado que ese número escribe más de 5 veces en una hora, cuando llega el sexto mensaje, entonces no respondo (rate limit silencioso).

**US-A4. Agregar un empleado (Must, S).**
Como dueño, quiero agregar el número de un empleado con rol Empleado, para que registre gastos sin ver mis totales.
- Dado que agrego un número con rol Empleado, cuando ese número escribe por primera vez, entonces recibe el saludo y puede registrar gastos e ingresos.
- Dado que un Empleado pide el cierre del día o el resultado del mes, cuando lo proceso, entonces respondo que esa consulta es solo para el dueño.
- Dado que desactivo un número, cuando escribe, entonces recibe el mismo trato que un número desconocido.

### Épica B. Registrar gastos

**US-B1. Gasto por texto (Must, L).** *Historia núcleo del walking skeleton.*
Como dueño, quiero escribir "gasté 15$ en champú" y que quede registrado, para no depender de nadie.
- Dado que envío un texto con monto, moneda y concepto, cuando el sistema lo interpreta, entonces me muestra un resumen (monto, moneda, equivalente en la otra moneda a la tasa vigente, categoría sugerida, fecha) con botones **Guardar** / **Corregir** / **Cancelar**.
- Dado que toco Guardar, cuando el backend persiste, entonces el gasto queda con monto original, moneda original, tasa BCV de esa fecha, equivalente calculado por el backend, categoría, descripción, autor (número) y canal (texto), y recibo "Listo, guardado" con el total de gastos del día.
- Dado que toco Corregir, cuando respondo con el cambio ("eran 25", "es mantenimiento"), entonces el sistema actualiza el borrador y vuelve a pedir confirmación.
- Dado que toco Cancelar o pasan 10 minutos sin respuesta, cuando expira, entonces el borrador se descarta y no se guarda nada.
- Dado que el monto tiene decimales en formato venezolano ("15,50"), cuando lo interpreto, entonces se guarda 15.50 sin ambigüedad.

**US-B2. Moneda ambigua (Must, S).**
Como dueño, quiero que si escribo "gasté 500 en hielo" me pregunte la moneda, para que no adivine.
- Dado que el texto no indica moneda ni símbolo, cuando lo interpreto, entonces pregunto con dos botones: **USD** / **Bs**. No infiero por magnitud.
- Dado que el tenant configuró una moneda por defecto para gastos, cuando el texto no indica moneda, entonces uso esa moneda y la muestro claramente en el resumen antes de confirmar.

**US-B3. Gasto en bolívares (Must, S).**
- Dado que registro "pagué 1.200 bs de hielo", cuando confirmo, entonces se guarda 1200.00 VES, la tasa BCV vigente de la fecha y el equivalente en USD calculado por el backend con redondeo a 2 decimales (bankers no; redondeo half-up comercial).
- Dado que no hay tasa BCV para esa fecha (fin de semana, feriado), cuando calculo, entonces uso la última tasa vigente anterior y lo indico en el resumen: "a tasa del viernes 26/09".

**US-B4. Gasto con fecha pasada (Must, S).**
- Dado que escribo "ayer gasté 20$ en gasolina", cuando lo interpreto, entonces la fecha es la de ayer en America/Caracas y la tasa es la vigente ese día.
- Dado que la fecha es de hace más de 30 días o futura, cuando lo interpreto, entonces pido confirmación explícita de la fecha antes de mostrar el resumen.

**US-B5. Gasto por nota de voz (Must, M).**
- Dado que envío una nota de voz, cuando el sistema la transcribe, entonces me muestra la transcripción entre comillas y luego el mismo resumen con botones de US-B1.
- Dado que la transcripción no contiene un monto reconocible, cuando la proceso, entonces respondo "Entendí: '…'. No encontré el monto, ¿cuánto fue?" y espero.
- Dado que el audio dura más de 2 minutos, cuando lo recibo, entonces respondo que solo proceso audios cortos y pido que lo repita.
- Dado que se completó la transcripción, cuando termina el flujo, entonces el archivo de audio se elimina; solo se conserva la transcripción.

**US-B6. Gasto por foto de factura (Must, M).**
- Dado que envío una foto, cuando el sistema la analiza, entonces extrae total, moneda, fecha y proveedor si son legibles, y muestra el resumen con botones de US-B1. Los campos que no pudo leer los pide.
- Dado que la foto no parece una factura o recibo, cuando la analizo, entonces respondo que solo proceso fotos de facturas y recibos.
- Dado que confirmo el gasto, cuando se guarda, entonces la imagen se conserva asociada al movimiento como respaldo, en almacenamiento privado, visible en el dashboard.
- Dado que la factura tiene IVA desglosado, cuando extraigo, entonces el monto del gasto es el total pagado; el IVA no se modela por separado en el MVP.

**US-B7. Categorías (Must, S).**
- Dado que el tenant tiene una lista de categorías, cuando interpreto un gasto, entonces sugiero una de esa lista o "Otros"; nunca invento categorías nuevas desde el chat.
- Dado que el dueño escribe "eso va en insumos" al corregir, cuando "insumos" existe, entonces la asigno; si no existe, ofrezco la más parecida o "Otros" y le indico que puede crearla en el dashboard.

**US-B8. Corregir o borrar el último movimiento por chat (Must, M).**
- Dado que guardé un gasto hace menos de 30 minutos, cuando escribo "no, eran 25" o "bórralo", entonces el sistema identifica el último movimiento del autor, muestra el cambio y pide confirmación.
- Dado que confirmo un borrado, cuando se ejecuta, entonces es un borrado lógico (soft delete) que queda en el log de auditoría.
- Dado que el movimiento tiene más de 30 minutos, cuando pido corregirlo, entonces el sistema me remite al dashboard con el enlace directo al movimiento.

### Épica C. Registrar ingresos

**US-C1. Total del día por método de pago (Must, M).**
Como dueño, quiero escribir "hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto", para cerrar el día en un mensaje.
- Dado que el texto tiene un total y un desglose, cuando lo interpreto, entonces valido en backend que el desglose suma el total; si no cuadra, muestro la diferencia y pido corrección.
- Dado que el desglose cuadra, cuando confirmo, entonces se crea un movimiento de ingreso por cada método, todos con la misma fecha y la tasa vigente.
- Dado que solo escribo un total sin desglose, cuando lo interpreto, entonces guardo un único ingreso con método "Sin especificar" y lo indico.
- Dado que un método está en Bs ("400 mil bs de pago móvil") y otro en USD, cuando confirmo, entonces cada movimiento guarda su moneda original y el total del día se muestra en ambas monedas.

**US-C2. Ingreso suelto (Must, S).**
- Dado que escribo "me pagaron 20$ por zelle del carro rojo", cuando confirmo, entonces se guarda un ingreso individual con método Zelle y descripción.

**US-C3. Día ya cerrado (Must, S).**
- Dado que ya registré el total de hoy, cuando envío otro total para hoy, entonces el sistema pregunta con botones: **Reemplazar** el total anterior / **Agregar** a lo ya registrado / **Cancelar**.
- Dado que elijo Reemplazar, cuando se ejecuta, entonces los ingresos anteriores de ese día con origen "total del día" quedan con borrado lógico y auditados.

### Épica D. Cierre y consultas

**US-D1. Cierre del día (Must, M).**
Como dueño, quiero escribir "cierre" o "cómo fue hoy", para ver en un mensaje ingresos, gastos y resultado.
- Dado que pido el cierre, cuando el backend lo calcula, entonces recibo: ingresos por método, gastos por categoría, resultado (ingresos menos gastos), todo en USD y en Bs a la tasa vigente del día, y el conteo de movimientos.
- Dado que no hay movimientos ese día, cuando pido el cierre, entonces respondo "No tengo movimientos registrados hoy" y no muestro ceros que parezcan un cierre real.
- Dado que soy Empleado, cuando pido el cierre, entonces recibo el rechazo de US-A4.

**US-D2. Resultado del período (Must, M).**
- Dado que pido "cómo va el mes", "esta semana" o "del 1 al 15", cuando el backend lo calcula, entonces recibo el mismo formato de US-D1 agregado por el período, más los 5 gastos más grandes.
- Dado que el período supera 12 meses, cuando lo pido, entonces respondo que por chat solo consulto hasta 12 meses y remito al dashboard.

**US-D3. Consulta por categoría (Must, S).**
- Dado que pregunto "cuánto gasté en champú este mes", cuando el backend consulta, entonces respondo el total en ambas monedas y la cantidad de movimientos; si la categoría no existe, ofrezco las más parecidas.

**US-D4. Tasa BCV (Must, S).**
- Dado que pregunto la tasa, cuando la consulto, entonces respondo la tasa **vigente hoy** con su fecha; si el BCV ya publicó la del siguiente día hábil, la agrego como "próxima" con su fecha de vigencia.
- Dado que la tasa vigente tiene más de 3 días hábiles de antigüedad, cuando la respondo, entonces agrego una advertencia de que puede estar desactualizada.

### Épica E. Dashboard

**US-E1. Acceso (Must, S).** Magic link por correo (ver US-A1). Sesión de 30 días en el dispositivo. Cierre de sesión.

**US-E2. Movimientos (Must, M).**
- Dado que entro a Movimientos, cuando cargo la vista, entonces veo la lista del mes actual, más reciente primero, con tipo, fecha, descripción, categoría, monto original, equivalente, autor y canal; filtros por tipo, categoría, rango de fechas y autor.
- Dado que edito un movimiento, cuando guardo, entonces se registra en auditoría quién, cuándo y qué cambió; si cambio la fecha, la tasa se recalcula a la de la nueva fecha y se me advierte.
- Dado que elimino un movimiento, cuando confirmo, entonces es borrado lógico y puedo verlo con el filtro "Eliminados".

**US-E3. Exportar (Must, S).**
- Dado que elijo un rango, cuando exporto, entonces descargo un archivo .xlsx con una fila por movimiento y columnas: fecha, tipo, categoría, descripción, monto, moneda, tasa, equivalente USD, equivalente Bs, método, autor, canal.

**US-E4. Resumen del mes (Must, S).** Ingresos, gastos, resultado, por categoría y por método, en ambas monedas. Sin gráficos complejos en el MVP: tablas y un par de totales grandes.

**US-E5. Categorías (Must, S).** Crear, renombrar, desactivar. No se borran si tienen movimientos.

**US-E6. Números y roles (Must, S).** Agregar, desactivar, cambiar rol. Ver estado de verificación.

**US-E7. Configuración (Must, S).** Moneda por defecto para gastos, nombre del negocio, tipo.

### Épica F. Plataforma

**US-F1. Tasa BCV diaria (Must, M).**
- Dado el cron diario, cuando corre, entonces consulta la fuente principal, y si falla, la de respaldo; guarda tasa, fecha de vigencia, fecha de publicación y fuente.
- Dado que ambas fuentes fallan, cuando corre, entonces reintenta cada hora y registra una alerta; las conversiones usan la última tasa vigente conocida y lo indican.
- Dado que el BCV publicó por adelantado la tasa del próximo día hábil, cuando la guardo, entonces queda con su fecha de vigencia futura y no se usa antes de esa fecha.

**US-F2. Fuera de alcance (Must, S).**
- Dado que el mensaje no corresponde a ninguna función (chiste, pregunta general, redactar algo), cuando lo proceso, entonces respondo un texto fijo: qué sí puedo hacer, con un menú de 3 botones (Registrar gasto, Registrar venta, Ver cierre). Sin conversación libre.

**US-F3. Idempotencia y reintentos (Must, M).**
- Dado que Meta reenvía un webhook ya procesado, cuando lo recibo, entonces lo reconozco por el id del mensaje y no lo proceso dos veces ni respondo dos veces.
- Dado que el webhook llega, cuando lo recibo, entonces respondo 200 en menos de 1 segundo y proceso en segundo plano.

**US-F4. Auditoría (Must, S).**
- Toda escritura (crear, editar, borrar, cambiar rol, vincular número) registra: tenant, actor, acción, entidad, valores antes y después, canal, timestamp.

**US-F5. Fallo del LLM o del proveedor de voz/visión (Must, S).**
- Dado que el proveedor no responde en 20 segundos o devuelve error, cuando falla, entonces respondo "Ahora mismo no puedo procesar esto, inténtalo en unos minutos" y **no** reintento la escritura en silencio. El mensaje queda marcado como fallido para métricas.

### Should (iteración 2)

| ID | Historia | Tamaño |
|---|---|---|
| S-1 | Recordatorio de cierre a hora configurable (plantilla de utilidad pagada) | M |
| S-2 | Resumen del día automático a las 7 pm (plantilla) | S |
| S-3 | Pago Móvil desde captura: registro como "pendiente de conciliar" con referencia, y lista de pendientes en el cierre | L |
| S-4 | Login al dashboard con código por WhatsApp (el usuario pide el código, respuesta en ventana de servicio) | M |
| S-5 | Importar movimientos desde Excel (onboarding de quien ya tiene su hoja) | M |
| S-6 | Presupuesto mensual por categoría y alerta al 80% | M |
| S-7 | Gráficos en el resumen del mes | S |

### Could

| ID | Historia |
|---|---|
| C-1 | Inventario básico: producto, stock, costo, precio, consulta por chat |
| C-2 | Integración Odoo (lectura de ventas del POS para el cierre; escritura de gastos) como premium |
| C-3 | Exportación contable (formato para el contador) |
| C-4 | Múltiples negocios por dueño con selector |

### Won't (MVP y siguiente iteración)

CRM, pedidos, clientes. Bot de atención a clientes finales. Verificación bancaria de pagos. Más de un número de WhatsApp por tenant. Facturación fiscal. Nómina. Multi-idioma.

### Requerimientos no funcionales

| Área | Requerimiento | Nota |
|---|---|---|
| Latencia, texto | p50 menor a 5 s, p95 menor a 12 s desde que Meta entrega el webhook hasta que enviamos la respuesta | Incluye una llamada al LLM con tool-calling. Si supera 4 s, enviar indicador de "escribiendo" (verificar soporte vigente en la Cloud API) |
| Latencia, voz y foto | p95 menor a 25 s | Transcripción u OCR más LLM. Enviar acuse inmediato: "Recibí tu nota de voz, dame un momento" |
| Webhook | Responder 200 en menos de 1 s, siempre, incluso si la base de datos está caída | Encolar antes de procesar. Meta reintenta si no recibe 200 y termina desactivando el webhook |
| Disponibilidad | 99% mensual en el MVP (unas 7 h de caída al mes) | Un solo servidor es aceptable. El dashboard puede caer sin afectar al bot y viceversa |
| Costo por tenant | Menor a 5 USD al mes con 300 mensajes al mes (60% texto, 25% voz, 15% foto) | Reparto objetivo: LLM 2, voz y visión 1, Meta 0.5, infra prorrateada 1.5. Todos los precios a verificar en Fase 6 |
| Conversaciones Meta | Todas iniciadas por el usuario (ventana de servicio). Cero plantillas en el MVP | Verificar precio vigente de conversaciones de servicio; ha cambiado varias veces |
| Precisión monetaria | Decimales exactos (NUMERIC), nunca float. Montos con 2 decimales, tasa con 4 | Redondeo half-up comercial en conversiones |
| Zona horaria | Todo en America/Caracas para fechas de negocio; almacenamiento en UTC con fecha de negocio explícita | "Hoy" se decide en hora de Caracas, no del servidor |
| Seguridad | Firma X-Hub-Signature-256 en cada webhook; secretos cifrados en reposo; aislamiento por tenant en cada consulta; rate limit por número; sesiones con expiración | Detalle en Fase 7 |
| Auditoría | Toda escritura auditada, con retención de 12 meses mínimo | |
| Conectividad inestable | Mensajes cortos; respuestas que no dependen de imágenes ni enlaces; el bot funciona sin el dashboard | WhatsApp ya reintenta del lado del cliente |
| Idempotencia | Por id de mensaje de Meta; retención de ids 7 días | |
| Medios | Audio se borra tras transcribir; fotos de facturas se conservan en almacenamiento privado con enlaces firmados | Retención de fotos: 12 meses, luego a decidir |
| Observabilidad | Por cada mensaje: tenant, tipo, herramienta invocada, tokens, latencia por etapa, costo estimado, resultado | Es lo que alimenta la métrica de costo por tenant |
| LLM | Proveedor principal más uno de respaldo detrás de una interfaz común. Timeout 20 s. Sin reintento de escrituras | El respaldo puede ser de menor calidad; solo importa que responda |
| Guardrails | Lista cerrada de herramientas; rechazo fijo fuera de alcance; el LLM nunca produce cifras que no vengan de una herramienta | Requisito de la política de Meta y de la regla 4 |
| Backups | Base de datos con respaldo diario y prueba de restauración mensual | |

### Backlog priorizado del MVP (orden de construcción)

| Orden | Historias | Justificación |
|---|---|---|
| 1 | US-F3, US-A3, US-B1 (texto), US-F1, US-E1, US-E2 (solo lista) | Walking skeleton: un gasto por texto llega a la base de datos y se ve en el dashboard |
| 2 | US-A1, US-A2, US-A4, US-B2, US-B3, US-B4, US-B7, US-F2, US-F4, US-F5 | Onboarding real y robustez del flujo de gasto |
| 3 | US-C1, US-C2, US-C3, US-D1, US-D4 | Ingresos y cierre: el producto ya "cierra el día" |
| 4 | US-B5 (voz), US-B6 (foto), US-B8 | Canales de entrada que hacen al producto amigable |
| 5 | US-D2, US-D3, US-E2 (edición), US-E3, US-E4, US-E5, US-E6, US-E7 | Consultas y dashboard completo |

### Decisiones tomadas en la Fase 1

- Confirmación de escrituras con botones interactivos de WhatsApp (Guardar / Corregir / Cancelar), no con texto libre "sí".
- Moneda ambigua se pregunta, nunca se infiere por magnitud. Moneda por defecto configurable por tenant.
- Borrador de escritura expira a los 10 minutos. Corrección por chat solo dentro de 30 minutos; después, dashboard.
- Borrados siempre lógicos y auditados.
- Ingresos como movimientos: un total del día genera un movimiento por método.
- Login al dashboard por magic link de correo. Login por WhatsApp es Should.
- Audio se descarta tras transcribir. Fotos de facturas se conservan como respaldo.
- Ante fallo del LLM, se informa y no se reintenta la escritura en silencio.
- IVA no se modela en el MVP; el gasto es el total pagado.
- Sin plantillas pagadas en el MVP.

### Preguntas abiertas (resueltas al aprobar la fase)

1. Categorías por defecto por tipo de negocio: se definen en Fase 4 con los guiones.
2. El Empleado registra gastos e ingresos; solo el dueño ve totales. Aprobado.
3. Retención de fotos de facturas: 12 meses. Aprobado, y se comunica como valor agregado.
4. Límites de botones (3) y listas (10 filas) interactivas: se asumen esos valores y se validan en pruebas con el número de prueba durante la semana 1.

### Riesgos detectados

- La latencia de voz y foto (hasta 25 s) puede sentirse como "no funciona". Mitigación: acuse inmediato antes de procesar.
- El presupuesto de 5 USD por tenant depende de precios de LLM, voz y Meta que cambian. Mitigación: medir costo por mensaje desde el walking skeleton.
- Desglose de ingresos que no cuadra con el total es el error humano más probable. Mitigación: validación aritmética en backend con mensaje claro, nunca guardar sin cuadrar.
- Fuera de alcance mal calibrado: si el rechazo es demasiado agresivo, el dueño se frustra ("gasté en algo raro" rechazado). Mitigación: evals de conversación en Fase 8 con casos límite.

---

## Fase 2. Modelo de dominio y datos

### Principios

1. **El dinero nunca es float.** `NUMERIC` en Postgres, `Decimal` o enteros escalados en código. Montos con 2 decimales; tasa con 8 decimales porque el BCV publica hasta 8.
2. **Cada movimiento congela su contexto monetario.** Guarda monto y moneda originales, la tasa usada (valor copiado, no solo la referencia) y los equivalentes en USD y Bs calculados en el momento de escribir. Si mañana se corrige una tasa en la tabla, la historia no cambia sola.
3. **Fecha de negocio explícita.** `business_date` es un `DATE` en hora de Caracas y es la fecha que el dueño entiende. `created_at` es `timestamptz` en UTC y sirve para auditoría. Nunca se deriva una de la otra en consultas.
4. **Borrado lógico en todo lo que tenga valor económico.** `deleted_at` más auditoría. El borrado físico solo existe para medios (audio) y tokens.
5. **Todo tiene `tenant_id`.** Incluso donde parece redundante. Es lo que permite que la política de aislamiento sea uniforme.
6. **La moneda de referencia del MVP es USD.** Los totales y reportes se agregan en USD. Bs se muestra convertido a la tasa de la fecha del reporte, y por separado se muestra el "efectivo en Bs" real para cuadrar caja. Ver "Manejo bimonetario".

### Estrategia multi-tenant: row-level con `tenant_id` y RLS

**Opciones evaluadas**

| Criterio | A) Row-level: `tenant_id` en cada tabla + Row Level Security de Postgres | B) Schema por tenant | C) Base de datos por tenant |
|---|---|---|---|
| Migraciones | Una vez | Una por schema (200 tenants = 200 migraciones por cambio) | Una por base |
| Pool de conexiones | Compartido, simple | Compartido, pero con `search_path` por request; los ORM lo manejan mal | Un pool por base; inviable con 200 |
| Aislamiento | Lógico, reforzado por RLS en la base | Lógico por schema | Físico |
| Consultas cruzadas (métricas del negocio, costo por tenant) | Triviales | Dolorosas | Muy dolorosas |
| Exportar o borrar un tenant | `WHERE tenant_id = ?` | `DROP SCHEMA` | `DROP DATABASE` |
| Riesgo de fuga | Una consulta sin filtro. RLS lo bloquea aunque el código falle | Un `search_path` mal puesto | Bajo |
| Complejidad para un solo dev | Baja | Media-alta | Alta |
| Escala razonable | Miles de tenants | Cientos | Decenas |

**Decisión: A.** Row-level con `tenant_id NOT NULL` en todas las tablas de negocio, índices compuestos que empiezan por `tenant_id`, y **RLS activado** con una política por tabla que compara contra `current_setting('app.tenant_id')`. La aplicación abre cada transacción con `SET LOCAL app.tenant_id = '<uuid>'`. El rol de base de datos de la aplicación no tiene `BYPASSRLS`; solo el rol de migraciones y el de cron lo tienen.

Por qué no B: schema por tenant se justifica cuando los tenants tienen esquemas distintos o exigencias contractuales de aislamiento. Aquí tienen el mismo esquema, pagan 20 USD y hay un dev. Las 200 migraciones por cambio son el costo que lo mata. Por qué no C: obvio a esta escala.

Consecuencia: RLS es una **red de seguridad**, no el filtro principal. El código sigue filtrando por `tenant_id` explícitamente. Si el código olvida el filtro, RLS devuelve cero filas en lugar de filas ajenas. Se prueba con un test de integración que intenta leer un tenant desde otro.

### Manejo bimonetario y precisión

**Al escribir un movimiento**

1. Se recibe `amount` y `currency` (USD o VES) desde el flujo de confirmación.
2. Se resuelve la tasa vigente para `business_date`: la fila de `bcv_rate` con mayor `effective_date <= business_date`. Si no existe ninguna, la escritura falla con un error claro (no se inventa una tasa).
3. Se calculan `amount_usd` y `amount_ves` con redondeo half-up a 2 decimales. Si `currency = USD`, `amount_usd = amount`; si `currency = VES`, `amount_ves = amount`. El otro se calcula.
4. Se guarda `rate_value` copiado y `rate_id` como referencia.

**Al editar** monto, moneda o fecha desde el dashboard, se recalcula todo con la tasa de la nueva fecha, y el dashboard advierte antes de guardar.

**Al reportar**

- Los totales se suman en USD (`SUM(amount_usd)`), que es la unidad de cuenta.
- El equivalente en Bs del total se calcula como `total_usd × tasa de la fecha del reporte`, no como `SUM(amount_ves)`. Sumar Bs de fechas distintas a tasas distintas produce un número que no significa nada.
- Aparte, para cuadrar caja, se muestra el efectivo real por moneda: suma de `amount` original agrupada por `payment_method` y `currency`. "Efectivo Bs: 1.850.000, Efectivo USD: 120, Pago Móvil: 3.400.000 Bs".

**Tipos**

| Campo | Tipo | Razón |
|---|---|---|
| `amount` (original) | `NUMERIC(18,2)` | Bs puede tener muchas cifras; 18 aguanta cualquier reconversión |
| `amount_usd` | `NUMERIC(14,2)` | |
| `amount_ves` | `NUMERIC(18,2)` | |
| `rate_value` | `NUMERIC(18,8)` | El BCV publica con hasta 8 decimales |
| `currency` | `CHAR(3)` con CHECK en (`USD`, `VES`) | ISO 4217. Se usa VES, no "Bs", en la base |

Redondeo: half-up comercial (`ROUND_HALF_UP`), nunca el redondeo bancario por defecto de algunos lenguajes. Se fija en una sola función de dominio (`convert(amount, currency, rate)`) y se prueba con casos de borde (0.005, montos grandes en Bs).

### Diagrama ER

```mermaid
erDiagram
    TENANT ||--o{ PHONE_NUMBER : tiene
    TENANT ||--o{ TENANT_MEMBER : tiene
    USER_ACCOUNT ||--o{ TENANT_MEMBER : pertenece
    USER_ACCOUNT ||--o{ MAGIC_LINK_TOKEN : recibe
    PHONE_NUMBER ||--o{ PHONE_VERIFICATION : verifica
    TENANT ||--o{ CATEGORY : define
    TENANT ||--o{ MOVEMENT : registra
    CATEGORY o|--o{ MOVEMENT : clasifica
    BCV_RATE ||--o{ MOVEMENT : "tasa usada (referencia)"
    PHONE_NUMBER o|--o{ MOVEMENT : "creado por (chat)"
    USER_ACCOUNT o|--o{ MOVEMENT : "creado por (dashboard)"
    MOVEMENT o|--o| ATTACHMENT : respalda
    TENANT ||--o{ ATTACHMENT : posee
    PHONE_NUMBER ||--o{ MESSAGE : intercambia
    TENANT ||--o{ MESSAGE : posee
    MESSAGE o|--o| WEBHOOK_EVENT : "origen crudo"
    PHONE_NUMBER ||--o| PENDING_ACTION : "tiene a lo sumo una"
    PENDING_ACTION o|--o| MOVEMENT : "produce al confirmar"
    TENANT ||--o{ AUDIT_LOG : audita
    TENANT ||--o{ INTEGRATION : "conecta (post-MVP)"

    TENANT {
        uuid id PK
        text name
        text business_type
        char3 default_expense_currency
        text timezone
        text status
        timestamptz created_at
    }
    USER_ACCOUNT {
        uuid id PK
        citext email UK
        text name
        timestamptz created_at
    }
    TENANT_MEMBER {
        uuid tenant_id FK
        uuid user_id FK
        text role
    }
    PHONE_NUMBER {
        uuid id PK
        uuid tenant_id FK
        text e164 UK
        text role
        text status
        text display_name
        timestamptz verified_at
    }
    PHONE_VERIFICATION {
        uuid id PK
        uuid tenant_id FK
        uuid phone_id FK
        text code_hash
        int attempts
        timestamptz expires_at
        timestamptz used_at
    }
    CATEGORY {
        uuid id PK
        uuid tenant_id FK
        text name
        text kind
        bool is_active
        int sort_order
    }
    BCV_RATE {
        uuid id PK
        date effective_date UK
        numeric rate
        timestamptz published_at
        text source
        timestamptz fetched_at
    }
    MOVEMENT {
        uuid id PK
        uuid tenant_id FK
        text type
        date business_date
        numeric amount
        char3 currency
        uuid rate_id FK
        numeric rate_value
        numeric amount_usd
        numeric amount_ves
        uuid category_id FK
        text payment_method
        text description
        text origin
        text source_channel
        uuid created_by_phone_id FK
        uuid created_by_user_id FK
        uuid source_message_id FK
        uuid attachment_id FK
        timestamptz created_at
        timestamptz updated_at
        timestamptz deleted_at
    }
    ATTACHMENT {
        uuid id PK
        uuid tenant_id FK
        text kind
        text storage_key
        text mime_type
        int size_bytes
        text sha256
        timestamptz created_at
        timestamptz deleted_at
    }
    WEBHOOK_EVENT {
        uuid id PK
        text event_key UK
        jsonb payload
        timestamptz received_at
        timestamptz processed_at
        text status
        text error
    }
    MESSAGE {
        uuid id PK
        uuid tenant_id FK
        uuid phone_id FK
        text direction
        text wa_message_id UK
        text kind
        text body
        text media_id
        jsonb tool_calls
        int tokens_in
        int tokens_out
        int latency_ms
        numeric cost_usd
        text status
        timestamptz created_at
    }
    PENDING_ACTION {
        uuid id PK
        uuid tenant_id FK
        uuid phone_id FK
        text kind
        jsonb payload
        text status
        uuid prompt_message_id FK
        timestamptz expires_at
        timestamptz resolved_at
    }
    AUDIT_LOG {
        bigint id PK
        uuid tenant_id FK
        text actor_type
        uuid actor_id
        text action
        text entity
        uuid entity_id
        jsonb before
        jsonb after
        text channel
        timestamptz created_at
    }
    INTEGRATION {
        uuid id PK
        uuid tenant_id FK
        text provider
        bytea config_encrypted
        text status
        timestamptz last_sync_at
    }
    MAGIC_LINK_TOKEN {
        uuid id PK
        uuid user_id FK
        text token_hash
        timestamptz expires_at
        timestamptz used_at
    }
```

### Entidades, una línea cada una

| Entidad | Qué es | Notas |
|---|---|---|
| `tenant` | El negocio | `business_type` alimenta categorías por defecto. `status`: `active`, `suspended`, `trial` |
| `user_account` | Persona que entra al dashboard | Identidad por correo. Separada de `phone_number` a propósito |
| `tenant_member` | Relación persona-negocio con rol de dashboard | MVP: solo `owner`. Deja lista la opción "varios negocios por dueño" |
| `phone_number` | Identidad de WhatsApp dentro de un tenant | `e164` único global: un número pertenece a un solo tenant (decisión 1). `role`: `owner`, `employee`. `status`: `pending`, `active`, `disabled` |
| `phone_verification` | Código de vinculación | Hash del código, 3 intentos, 15 minutos |
| `category` | Categoría de gasto (y de ingreso, reservado) | `kind`: `expense`, `income`. Desactivar, no borrar |
| `bcv_rate` | Una tasa por fecha de vigencia | Global, no por tenant. "Vigente hoy" = mayor `effective_date <= hoy`. "Última publicada" = mayor `effective_date` |
| `movement` | El corazón: un gasto o un ingreso | Ver campos abajo |
| `attachment` | Foto de factura (y audio transitorio) | `storage_key` apunta a almacenamiento privado. Audio se borra al terminar el flujo |
| `webhook_event` | Payload crudo de Meta | `event_key` único = idempotencia en la puerta. Permite reprocesar. Retención 7 días |
| `message` | Mensaje normalizado, entrante o saliente | Memoria de conversación (últimos N por teléfono) y observabilidad (tokens, latencia, costo) |
| `pending_action` | El borrador esperando Guardar / Corregir / Cancelar | A lo sumo una activa por teléfono. `kind`: `create_expense`, `create_income`, `edit_last`, `delete_last`, `replace_day_total`. Expira a 10 min |
| `audit_log` | Quién hizo qué | Escritura en la misma transacción que el cambio |
| `integration` | Conexión externa (Odoo, post-MVP) | Config cifrada. Es la tabla que respalda el adapter cuando exista un segundo proveedor |
| `magic_link_token` | Token de acceso al dashboard | Hash, un uso, 15 min |

**Campos de `movement` que merecen explicación**

- `type`: `expense` o `income`.
- `origin`: `single` (un gasto o un ingreso suelto) o `day_total` (generado por "hoy vendí…"). Permite "Reemplazar el total del día" sin tocar los ingresos sueltos.
- `payment_method`: `cash_usd`, `cash_ves`, `pago_movil`, `punto`, `zelle`, `transfer_usd`, `transfer_ves`, `other`, `unspecified`. Enum en el MVP; tabla por tenant cuando alguien lo pida. Obligatorio en ingresos, opcional en gastos.
- `source_channel`: `text`, `voice`, `image`, `dashboard`. Alimenta la métrica de error por canal.
- `created_by_phone_id` o `created_by_user_id`: exactamente uno no nulo (CHECK).
- `source_message_id`: el mensaje de WhatsApp que lo originó. Trazabilidad completa desde el chat hasta la fila.
- `attachment_id`: la foto de la factura, si la hubo.

### Esquema inicial (DDL, Postgres 16+)

Solo las tablas centrales; el resto sigue el mismo patrón. Los nombres están en inglés porque el código lo estará; el producto habla español.

```sql
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenant (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  business_type             text NOT NULL,                 -- car_wash, food, retail, services, other
  default_expense_currency  char(3) CHECK (default_expense_currency IN ('USD','VES')),
  timezone                  text NOT NULL DEFAULT 'America/Caracas',
  status                    text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','suspended')),
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE phone_number (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  e164          text NOT NULL UNIQUE,                       -- un número, un tenant
  role          text NOT NULL CHECK (role IN ('owner','employee')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  display_name  text,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON phone_number (tenant_id);

CREATE TABLE bcv_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_date  date NOT NULL UNIQUE,
  rate            numeric(18,8) NOT NULL CHECK (rate > 0),  -- VES por 1 USD
  published_at    timestamptz,
  source          text NOT NULL,                            -- 'bcv', 'backup_x'
  fetched_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE category (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income')),
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, kind, name)
);

CREATE TABLE movement (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  type                 text NOT NULL CHECK (type IN ('expense','income')),
  business_date        date NOT NULL,
  amount               numeric(18,2) NOT NULL CHECK (amount > 0),
  currency             char(3) NOT NULL CHECK (currency IN ('USD','VES')),
  rate_id              uuid NOT NULL REFERENCES bcv_rate(id),
  rate_value           numeric(18,8) NOT NULL,              -- copia congelada
  amount_usd           numeric(14,2) NOT NULL,
  amount_ves           numeric(18,2) NOT NULL,
  category_id          uuid REFERENCES category(id),
  payment_method       text NOT NULL DEFAULT 'unspecified'
                       CHECK (payment_method IN ('cash_usd','cash_ves','pago_movil','punto','zelle',
                                                 'transfer_usd','transfer_ves','other','unspecified')),
  description          text,
  origin               text NOT NULL DEFAULT 'single' CHECK (origin IN ('single','day_total')),
  source_channel       text NOT NULL CHECK (source_channel IN ('text','voice','image','dashboard')),
  created_by_phone_id  uuid REFERENCES phone_number(id),
  created_by_user_id   uuid REFERENCES user_account(id),
  source_message_id    uuid REFERENCES message(id),
  attachment_id        uuid REFERENCES attachment(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CHECK ((created_by_phone_id IS NULL) <> (created_by_user_id IS NULL)),
  CHECK (type = 'expense' OR payment_method <> 'unspecified' OR origin = 'day_total')
);
-- La consulta más frecuente: movimientos vivos de un tenant en un rango de fechas
CREATE INDEX movement_tenant_date_idx ON movement (tenant_id, business_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX movement_tenant_category_idx ON movement (tenant_id, category_id) WHERE deleted_at IS NULL;

CREATE TABLE pending_action (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  phone_id           uuid NOT NULL REFERENCES phone_number(id),
  kind               text NOT NULL,
  payload            jsonb NOT NULL,                          -- el borrador validado
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','expired')),
  prompt_message_id  uuid,
  expires_at         timestamptz NOT NULL,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- Solo una acción pendiente por teléfono
CREATE UNIQUE INDEX pending_action_one_active ON pending_action (phone_id) WHERE status = 'pending';

CREATE TABLE webhook_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key     text NOT NULL UNIQUE,                        -- wa message id, o hash del payload para statuses
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','done','failed','ignored')),
  error         text
);

CREATE TABLE message (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenant(id),                  -- nulo si el número es desconocido
  phone_id       uuid REFERENCES phone_number(id),
  direction      text NOT NULL CHECK (direction IN ('in','out')),
  wa_message_id  text UNIQUE,
  kind           text NOT NULL,                              -- text, audio, image, interactive, system
  body           text,
  media_id       text,
  tool_calls     jsonb,
  tokens_in      int,
  tokens_out     int,
  latency_ms     int,
  cost_usd       numeric(10,6),
  status         text NOT NULL DEFAULT 'ok',                 -- ok, failed, rejected_out_of_scope, rate_limited
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_phone_recent_idx ON message (phone_id, created_at DESC);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  actor_type  text NOT NULL CHECK (actor_type IN ('phone','user','system')),
  actor_id    uuid,
  action      text NOT NULL,                                  -- create, update, soft_delete, restore, role_change, link_phone
  entity      text NOT NULL,
  entity_id   uuid NOT NULL,
  before      jsonb,
  after       jsonb,
  channel     text NOT NULL,                                  -- whatsapp, dashboard, cron
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_entity_idx ON audit_log (tenant_id, entity, entity_id);

-- RLS: red de seguridad por tenant
ALTER TABLE movement ENABLE ROW LEVEL SECURITY;
CREATE POLICY movement_tenant_isolation ON movement
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- Misma política en category, phone_number, pending_action, message, attachment, audit_log, integration.
-- bcv_rate y webhook_event son globales: sin RLS.
```

### Reglas de dominio que viven en el código, no en la base

- **Resolver tasa vigente**: `rate_for(business_date)` devuelve la fila con mayor `effective_date <= business_date`. Si `business_date` es fin de semana o feriado, devuelve la del último día hábil y el mensaje lo dice.
- **Convertir**: `convert(amount, currency, rate)` es la única función que multiplica o divide dinero. Devuelve ambos equivalentes ya redondeados.
- **Total del día**: al confirmar "hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto", el backend primero verifica `200 + 100 + 50 = 350` en `Decimal`, y solo entonces crea tres movimientos `origin = day_total` en una sola transacción.
- **Reemplazar total del día**: marca `deleted_at` en los movimientos `origin = day_total` de esa fecha y crea los nuevos, en una transacción, con una fila de auditoría por movimiento.
- **Cierre del día**: `SUM(amount_usd)` por tipo, por categoría y por método, más `SUM(amount)` agrupado por `(payment_method, currency)` para el efectivo real. Todo en SQL, cero aritmética en el LLM.

### Memoria de conversación

No hay memoria vectorial ni resúmenes. El contexto del agente por turno es:

1. Los últimos 10 mensajes de ese `phone_id` (tabla `message`), o los últimos 30 minutos, lo que sea menor.
2. La `pending_action` activa, si existe.
3. Datos del tenant: nombre, moneda por defecto, lista de categorías activas, rol del teléfono.

Es suficiente para "no, eran 25" y para "¿cuál de estas categorías?". Es barato en tokens y no arrastra conversaciones viejas.

### Retención

| Dato | Retención | Razón |
|---|---|---|
| `movement`, `audit_log`, `category` | Indefinida mientras el tenant exista | Es el libro de caja |
| Fotos de facturas | 12 meses | Aprobado en Fase 1; se comunica como valor agregado |
| Audio | Se borra al cerrar el flujo | Costo y privacidad |
| `message.body` | 90 días; después se conserva la fila sin cuerpo | Métricas sin acumular conversaciones |
| `webhook_event.payload` | 7 días | Solo para reprocesar |
| Tokens (magic link, verificación) | Se borran al usarse o expirar | |

### Decisiones tomadas en la Fase 2

- Multi-tenant row-level con `tenant_id` en todo y RLS como red de seguridad; el código filtra explícitamente.
- Unidad de cuenta USD. Bs en reportes = total USD × tasa del día del reporte. Efectivo real por moneda aparte.
- Cada movimiento congela `rate_value` y ambos equivalentes.
- `NUMERIC` en base, `Decimal` en código, half-up, una sola función de conversión.
- Tasa BCV global por fecha de vigencia; "vigente" y "última publicada" se derivan por consulta, no por bandera.
- Identidad de WhatsApp (`phone_number`) separada de identidad de dashboard (`user_account`).
- `pending_action` con índice único parcial: una sola acción pendiente por teléfono.
- Idempotencia en dos capas: `webhook_event.event_key` único y `message.wa_message_id` único.
- Métodos de pago como enum en el MVP.
- `integration` reservada para Odoo; no se implementa nada más en el MVP.

### Preguntas abiertas (cerradas con valores por defecto al aprobar la fase)

1. Moneda por defecto de gastos: USD preseleccionado en el onboarding, configurable por tenant. Aprobado.
2. `business_type` inicial: `car_wash`, `food`, `retail`, `services`, `other`. Todos comercio fijo. Aprobado.
3. Retención de `message.body`: 90 días. Aprobado.

### Riesgos detectados

- Olvidar `SET LOCAL app.tenant_id` en algún camino (cron, jobs) hace que RLS devuelva cero filas y parezca "no hay datos". Mitigación: un helper único para abrir transacciones de tenant, y el cron usa un rol distinto con `BYPASSRLS` explícito.
- Sumar `amount_ves` de fechas distintas por error en algún reporte. Mitigación: no exponer `SUM(amount_ves)` en la capa de reportes; solo `amount_usd` y efectivo real por moneda.
- `e164` único global impide que un mismo dueño tenga dos negocios con un solo número. Es la decisión 1 y se acepta. Mitigación futura: selector de negocio por chat (Could-4).
- Reconversión monetaria en Venezuela: `NUMERIC(18,2)` aguanta; el código que formatea montos para WhatsApp debe abreviar ("1,85 M Bs") para no mandar cifras ilegibles.

---

## Fase 3. Arquitectura

La Fase 6 elige lenguajes y proveedores. Esta fase define piezas, responsabilidades y flujos de forma que cualquier stack razonable los pueda implementar. Donde una decisión de arquitectura implica un tipo de tecnología (por ejemplo, "cola sobre Postgres"), queda registrada como ADR y la Fase 6 la confirma o la reabre.

### C4 nivel 1. Contexto

```mermaid
flowchart LR
    owner["Dueño<br/>(WhatsApp y navegador)"]
    employee["Empleado<br/>(WhatsApp)"]
    sys["Asistente de caja por WhatsApp<br/>Registra gastos e ingresos, calcula cierres,<br/>expone dashboard"]
    meta["Meta WhatsApp Cloud API<br/>Webhooks entrantes, envío de mensajes, descarga de medios"]
    llm["Proveedor LLM<br/>Tool-calling y visión"]
    stt["Proveedor de voz a texto"]
    bcv["Fuente de tasa BCV<br/>principal y respaldo"]
    mail["Proveedor de correo<br/>Magic links"]
    store["Almacenamiento de objetos<br/>Fotos de facturas"]

    owner -- "mensajes, notas de voz, fotos" --> meta
    employee -- "mensajes, notas de voz, fotos" --> meta
    meta -- "webhook firmado" --> sys
    sys -- "respuestas, botones, listas" --> meta
    owner -- "HTTPS" --> sys
    sys -- "tools + contexto" --> llm
    sys -- "audio" --> stt
    sys -- "cron diario" --> bcv
    sys -- "enlace de acceso" --> mail
    sys -- "guarda y sirve con URL firmada" --> store
```

### C4 nivel 2. Contenedores

```mermaid
flowchart TB
    subgraph ext["Externos"]
        meta["Meta Cloud API"]
        llm["LLM"]
        stt["Voz a texto"]
        bcv["Fuente BCV"]
        mail["Correo"]
    end

    subgraph sys["Asistente de caja (monolito modular, un repositorio)"]
        web["Proceso Web<br/>• Webhook de Meta (verificación de firma, idempotencia, encolar)<br/>• API del dashboard<br/>• Dashboard (mobile-first)<br/>• Auth por magic link"]
        worker["Proceso Worker<br/>• Procesador de mensajes (por teléfono, en serie)<br/>• Agente y herramientas<br/>• Cron: tasa BCV, expiraciones, limpieza<br/>• Envío a Meta con reintentos"]
        db[("Postgres<br/>Datos de negocio + cola de trabajos<br/>RLS por tenant")]
        obj[("Almacenamiento de objetos<br/>Fotos de facturas, audio transitorio")]
    end

    meta -- "POST webhook" --> web
    web -- "INSERT webhook_event + job" --> db
    worker -- "toma jobs (SKIP LOCKED)" --> db
    worker -- "descarga medios" --> meta
    worker -- "envía mensajes" --> meta
    worker --> llm
    worker --> stt
    worker -- "diario" --> bcv
    worker --> obj
    web -- "consultas dashboard" --> db
    web -- "URLs firmadas" --> obj
    web -- "magic link" --> mail
```

**Por qué un monolito modular y no servicios.** Un dev, un piloto, un costo objetivo de 5 USD por tenant. Dos procesos del mismo código (web y worker) es lo mínimo para que el webhook responda en menos de 1 s sin importar lo que tarde el LLM. Los módulos internos (`whatsapp`, `agent`, `ledger`, `rates`, `dashboard`) tienen fronteras claras para poder separarlos si algún día hace falta. Hoy no hace falta.

**Por qué la cola vive en Postgres.** Una dependencia menos que operar. Con `SELECT … FOR UPDATE SKIP LOCKED` y una tabla `job`, Postgres maneja sin esfuerzo los cientos de mensajes por minuto que 200 tenants generan en su peor hora. Se migra a Redis o similar cuando la tabla `job` sea un cuello de botella medible, no antes. Detalle y alternativas en el ADR-003.

### Módulos internos y sus fronteras

| Módulo | Responsabilidad | Depende de |
|---|---|---|
| `whatsapp` | Verificar firma, normalizar payloads de Meta, descargar medios, enviar texto/botones/listas, marcar leído | Nada del dominio |
| `inbox` | Idempotencia, encolar, serializar por teléfono, enrutar a handler determinista o al agente | `whatsapp`, `identity` |
| `identity` | Resolver teléfono a tenant y rol, verificación de números, rate limit de desconocidos | `db` |
| `agent` | Construir contexto, loop de tool-calling, guardrails, registrar tokens y costo | `tools`, `llm` |
| `tools` | Implementación de cada herramienta; validaciones; crea `pending_action` | `ledger`, `rates` |
| `ledger` | Provider de datos (`LocalProvider` en el MVP): crear/editar/borrar movimientos, cierres, consultas. Toda la aritmética | `db`, `rates` |
| `rates` | Tasa BCV: cron, fuentes, "vigente" vs "última publicada", conversión | `db` |
| `media` | Voz a texto, extracción de factura por visión, almacenamiento de objetos | Proveedores externos |
| `render` | Plantillas de respuesta en español con las cifras que devuelven las herramientas | Nada |
| `dashboard` | API y UI web, auth por magic link, exportación | `ledger`, `identity` |
| `audit` | Escribir `audit_log` dentro de la transacción del cambio | `db` |

Regla de dependencias: `agent` no toca `db`; solo llama herramientas. `tools` no llama al LLM. `render` no hace cuentas. Si alguien viola esto, el test de arquitectura lo detecta.

### Flujo end-to-end de un mensaje

```mermaid
sequenceDiagram
    autonumber
    participant M as Meta Cloud API
    participant W as Proceso Web
    participant DB as Postgres
    participant K as Worker
    participant L as LLM
    participant T as Herramientas / Ledger

    M->>W: POST /webhook (X-Hub-Signature-256, body)
    W->>W: Verificar HMAC sobre el body crudo
    alt firma inválida
        W-->>M: 401 (no se procesa)
    end
    W->>DB: INSERT webhook_event (event_key único) ON CONFLICT DO NOTHING
    alt ya existía
        W-->>M: 200 (duplicado ignorado)
    else nuevo
        W->>DB: INSERT job(process_message, phone_key)
        W-->>M: 200 en < 1 s
    end

    K->>DB: Tomar job FOR UPDATE SKIP LOCKED, con advisory lock por teléfono
    K->>DB: Resolver e164 -> phone_number, tenant, rol
    alt número desconocido
        K->>M: Texto fijo con enlace de registro (sin LLM)
        K->>DB: message(status=rejected), job done
    else número conocido
        K->>M: Marcar leído (y "escribiendo", si está disponible)
        K->>DB: INSERT message(in)
        K->>K: Enrutar
        alt respuesta a botón (Guardar/Corregir/Cancelar) o código de verificación
            K->>T: Handler determinista (sin LLM)
        else texto, voz o foto
            opt voz o foto
                K->>M: Descargar medio
                K->>K: Transcribir / extraer factura (JSON estructurado)
                K->>M: Acuse: "Recibí tu nota de voz, dame un momento"
            end
            K->>K: Construir contexto (tenant, rol, categorías, últimos 10 msgs, pending_action)
            K->>L: Mensajes + definición de herramientas (timeout 20 s)
            L-->>K: tool_call(nombre, args)
            K->>T: Ejecutar herramienta (valida, calcula, crea pending_action si escribe)
            T-->>K: Resultado estructurado
            Note over K,L: Máximo 3 iteraciones. Las herramientas de escritura y de reporte terminan el loop.
        end
        K->>K: render: plantilla en español con cifras del resultado
        K->>M: Enviar respuesta (texto / botones / lista), reintento 3x con backoff
        K->>DB: INSERT message(out) con tokens, latencia, costo; job done
    end
```

**Puntos que no se ven en el diagrama y son los que duelen en producción**

1. **Serialización por teléfono.** Dos mensajes seguidos del mismo número ("gasté 20$" y luego "en champú") deben procesarse en orden. El worker toma un advisory lock por `phone_id` mientras procesa; otro worker con un job del mismo teléfono espera. Mensajes de teléfonos distintos van en paralelo.
2. **Evitar responder dos veces.** Si el worker muere después de enviar a Meta pero antes de marcar el job como hecho, el reintento del job volvería a responder. Antes de enviar, el worker registra `message(out, status=sending)`; al reintentar, si existe un `out` para ese `webhook_event`, no vuelve a enviar y solo cierra el job.
3. **Eventos que no son mensajes.** Meta manda `statuses` (entregado, leído) por el mismo webhook. Se registran con `status=ignored` y no generan job.
4. **El webhook nunca depende del LLM ni del worker.** Si Postgres está caído, el webhook responde 500 y Meta reintenta con backoff. Es el único caso aceptable de no responder 200.
5. **Timeout de Meta para mensajes viejos.** Si un job se procesa más de 24 h después (por caída larga), Meta puede rechazar la respuesta por ventana cerrada. El worker descarta jobs con más de 12 h y los marca `expired`; el dueño verá el mensaje sin respuesta y volverá a escribir.

### Qué pasa cuando algo falla

| Falla | Comportamiento | Quién se entera |
|---|---|---|
| Firma inválida | 401, no se procesa, se cuenta en métricas | Alerta si supera 10 por minuto (posible ataque o secreto rotado) |
| Postgres caído | Webhook responde 500; Meta reintenta. Dashboard muestra error | Alerta inmediata |
| LLM no responde en 20 s o error 5xx | Se intenta una vez con el proveedor de respaldo. Si también falla: "Ahora mismo no puedo procesar esto, inténtalo en unos minutos". No se reintenta la escritura. `message.status=failed` | Alerta si supera 5% en 10 minutos |
| LLM responde sin tool_call en un flujo de escritura | Se trata como fuera de alcance: menú de 3 botones | Métrica |
| Voz a texto falla | "No pude escuchar la nota de voz, ¿me lo escribes?" | Métrica |
| Extracción de factura falla o devuelve baja confianza | "No pude leer bien la factura. ¿Cuánto fue y en qué moneda?" y sigue por texto | Métrica |
| Envío a Meta falla (5xx, red) | 3 reintentos con backoff 2/4/8 s. Después, job `failed`, se registra | Alerta si supera 2% en 10 minutos |
| Envío a Meta falla por 4xx (número bloqueó, ventana cerrada) | No se reintenta. Se registra | Métrica |
| Fuente BCV principal falla | Fuente de respaldo. Si ambas fallan, reintento cada hora; conversiones usan la última vigente y el mensaje lo indica | Alerta a las 24 h sin tasa nueva en día hábil |
| Worker muere a mitad de job | Job con `locked_until` vencido vuelve a la cola una vez. Segunda muerte: `failed` | Alerta |
| `pending_action` de otra cosa cuando llega un botón | El botón lleva el id de la acción; si no coincide con la pendiente, "esa confirmación ya venció" | Nada |
| Odoo (futuro) no responde | `OdooProvider` con circuit breaker: lecturas devuelven "no pude consultar Odoo"; escrituras se rechazan, nunca se encolan a ciegas | Alerta por tenant |

### Diseño del agente

**Principio: el LLM es un enrutador con manos atadas.** Recibe el mensaje, el contexto y una lista cerrada de herramientas. Su única salida válida es una llamada a herramienta. El texto que ve el dueño lo produce `render` a partir de resultados estructurados, salvo en las preguntas de aclaración, donde el LLM redacta pero con una validación: cualquier número en su texto debe existir en el mensaje del usuario o en un resultado de herramienta, o el texto se descarta y se usa una aclaración genérica.

**Loop de tool-calling**

```
contexto = construir(tenant, rol, categorías, últimos 10 mensajes o 30 min, pending_action)
mensajes = [system(tenant, rol, reglas), historial, usuario(texto o transcripción o JSON de factura)]
for i in 1..3:
    respuesta = llm.call(mensajes, herramientas_permitidas(rol), timeout=20s)
    if respuesta no tiene tool_call:
        return render.fuera_de_alcance()
    resultado = tools.ejecutar(tool_call, contexto)     # valida, calcula, persiste borrador
    if resultado.termina:                                # escrituras, reportes, rechazos, aclaraciones
        return render(resultado)
    mensajes.append(tool_result(resultado))              # solo para herramientas de consulta encadenables
return render.fuera_de_alcance()
```

Casi todo termina en la primera iteración. Las iteraciones 2 y 3 existen para casos como "¿cuánto gasté en champú?" cuando la categoría no existe y la herramienta devuelve candidatas: el LLM puede elegir la más probable y volver a consultar, o pedir aclaración.

**Enrutamiento previo al LLM (determinista, gratis)**

| Entrada | Handler |
|---|---|
| Respuesta interactiva con id `confirm:<pending_id>` | Ejecuta la acción pendiente, escribe, audita, responde |
| `cancel:<pending_id>` | Cancela, responde |
| `fix:<pending_id>` | Marca la pendiente como "en corrección" y espera el siguiente texto, que sí va al LLM con el borrador en contexto |
| Texto de exactamente 6 dígitos desde un número `pending` | Verificación de número |
| "menu", "hola", "buenas" desde número activo | Menú fijo: tasa del día en el texto más 3 botones |
| "tasa", "dolar", "bcv" como mensaje completo | Tasa del día sin LLM |
| "ayuda" | Texto de ayuda con ejemplos y enlace al dashboard |
| Número desconocido | Texto fijo con enlace |
| Número `disabled` | Igual que desconocido |

**Herramientas del MVP**

Todas reciben implícitamente `tenant_id`, `phone_id`, `rol` y `ahora` desde el contexto; el LLM no puede pasarlos. Las de escritura no escriben en `movement`: crean una `pending_action` y devuelven el borrador para confirmar.

| Herramienta | Parámetros (del LLM) | Validaciones en backend | Devuelve | Rol |
|---|---|---|---|---|
| `draft_expense` | `amount` (string decimal), `currency` (`USD`, `VES` o `null`), `description`, `category_name` (de la lista o `null`), `business_date` (ISO o `null` = hoy) | `amount > 0`, máximo 2 decimales; `currency` nulo y sin default del tenant → resultado `needs_currency`; fecha futura o > 30 días → `needs_date_confirmation`; categoría fuera de la lista → sugiere la más parecida u "Otros"; resuelve tasa; calcula equivalentes; crea `pending_action(create_expense)` | Borrador: monto, moneda, equivalente, tasa y su fecha, categoría, fecha, `pending_id` | owner, employee |
| `draft_income_day_total` | `business_date`, `total_amount`, `total_currency`, `breakdown[]` de `{method, amount, currency}` | Suma del desglose = total en `Decimal` (si no, `mismatch` con la diferencia); métodos válidos; si ya existe `day_total` para esa fecha → `day_already_closed`; crea `pending_action(create_income_day_total)` o `replace_day_total` | Borrador con líneas y totales | owner, employee |
| `draft_income_single` | `amount`, `currency`, `method`, `description`, `business_date` | Como `draft_expense`, método obligatorio | Borrador | owner, employee |
| `amend_last_movement` | `changes`: subconjunto de `{amount, currency, category_name, description, business_date}` | Último movimiento vivo del mismo teléfono, < 30 min; si no, `too_old` con enlace al dashboard; recalcula tasa si cambia fecha; crea `pending_action(edit_last)` | Antes / después | owner, employee |
| `delete_last_movement` | ninguno | Igual que arriba; crea `pending_action(delete_last)` | El movimiento a borrar | owner, employee |
| `get_daily_close` | `business_date` (`null` = hoy) | Solo owner; sin movimientos → `empty` | Ingresos por método, gastos por categoría, resultado, todo en USD y Bs a tasa del día, efectivo real por moneda, conteo | owner |
| `get_period_summary` | `period` (`today`, `week`, `month`) o `from`/`to` | Solo owner; máximo 12 meses | Igual que el cierre, agregado, más top 5 gastos | owner |
| `query_by_category` | `category_name`, `type`, `period` o `from`/`to` | Categoría inexistente → `candidates[]` (encadenable) | Total USD y Bs, conteo | owner |
| `get_bcv_rate` | ninguno | | Vigente hoy con fecha; próxima si ya se publicó; advertencia si tiene > 3 días hábiles | owner, employee |
| `ask_clarification` | `question`, `options[]` (0 a 3) | Texto validado (regla de números); opciones → botones | Termina el loop | todos |
| `reject_out_of_scope` | `reason` (`general_chat`, `other_business_task`, `unclear`) | | Menú fijo. Termina el loop | todos |

Las herramientas que un rol no puede usar **no se envían al LLM** para ese rol. Un empleado que pide el cierre recibe `reject_out_of_scope` porque el LLM no tiene `get_daily_close` disponible, y `render` muestra el mensaje "esa consulta es solo para el dueño" cuando el texto lo sugiere. Doble barrera: la herramienta además valida el rol.

**Prompt de sistema (estructura, no texto final)**

1. Identidad: "Eres el asistente de caja de {negocio}. Solo registras gastos e ingresos, consultas cierres y la tasa BCV."
2. Reglas duras: nunca respondas con texto libre si una herramienta aplica; nunca calcules; si el mensaje no encaja, `reject_out_of_scope`; si falta un dato, `ask_clarification`, no lo inventes.
3. Contexto: fecha y hora de Caracas, moneda por defecto del tenant, lista de categorías con sus nombres exactos, rol del usuario.
4. Pistas de interpretación venezolana: "bs", "bolos", "bolívares" = VES; "$", "dólares", "verdes" = USD; "pago móvil", "punto", "zelle" son métodos; "500 mil" = 500000; coma decimal; "ayer", "antier", "el lunes".
5. Borrador pendiente, si existe, con instrucción de que el próximo mensaje probablemente lo corrige.

El texto final se escribe en la Fase 4 junto con los guiones, y se versiona en el repositorio con sus evals.

**Guardrails, en orden de ejecución**

1. Rol → subconjunto de herramientas.
2. Salida del LLM sin tool_call → fuera de alcance.
3. Herramienta con args inválidos (schema) → una reintento pidiendo corregir args; segundo fallo → fuera de alcance.
4. Validaciones de negocio dentro de cada herramienta (montos, fechas, sumas).
5. Toda escritura pasa por `pending_action` y confirmación con botón.
6. Texto libre del LLM (solo `ask_clarification`) → validación de números.
7. Límite de 3 iteraciones y 20 s por llamada.
8. Presupuesto de tokens por tenant y día, **desactivado en el MVP** hasta tener costos reales (ver preguntas resueltas). Cuando se active, al superarlo el bot responde que llegó al límite y sugiere el dashboard.

**Fuera de alcance.** No se argumenta ni se conversa. Respuesta fija: "Solo puedo ayudarte con tu caja: registrar gastos, registrar ventas y ver el cierre. ¿Qué quieres hacer?" con tres botones. Se registra `reason` para saber qué piden los dueños y decidir qué construir después.

**Audio.** Descargar medio → validar duración (máximo 2 min) y formato → voz a texto con hint de idioma `es` y vocabulario del dominio (categorías, "pago móvil", "bolívares") si el proveedor lo permite → el texto entra al loop como si fuera escrito, marcado `source_channel=voice` → `render` antepone la transcripción entre comillas en el borrador para que el dueño vea qué se entendió → el audio se borra al cerrar el flujo. Antes de transcribir se envía el acuse.

**Imágenes.** Descargar → guardar en objetos como `attachment` provisional → modelo de visión con salida estructurada obligatoria: `{total, currency, date, vendor, line_items_count, confidence, is_receipt}` → si `is_receipt=false` o `confidence < 0.6` → "No pude leer bien la factura, ¿cuánto fue?" → si es válido, el JSON se pasa al loop como mensaje del usuario ("Foto de factura: total X, moneda Y, fecha Z, proveedor W") y el LLM llama `draft_expense` con esos datos; el `attachment` se vincula al movimiento al confirmar y se borra si se cancela o expira. Se usa el modelo de visión del LLM y no un OCR aparte (ADR-007).

### ADRs

**ADR-001. Un solo número de WhatsApp para todos los tenants**
- Contexto: cada número requiere verificación y aprobación de nombre en Meta; los dueños venezolanos no quieren gestionar eso.
- Opciones: (A) un número de la plataforma, tenant por remitente; (B) un número por tenant, con onboarding de Meta por cliente; (C) híbrido.
- Decisión: A.
- Consecuencias: onboarding en minutos; un solo punto de falla ante Meta (si bloquean el número, caen todos); el nombre visible es el de la plataforma, no el del negocio; un teléfono solo puede pertenecer a un negocio. Mitigación: cumplimiento estricto de políticas, plan de número de respaldo pre-verificado (Fase 7).

**ADR-002. Monolito modular con dos procesos (web y worker)**
- Contexto: un dev, costo mínimo, webhook que debe responder rápido.
- Opciones: (A) monolito de un proceso; (B) monolito modular, web + worker; (C) servicios separados.
- Decisión: B.
- Consecuencias: un repositorio, un despliegue, dos procesos. Fronteras de módulos vigiladas por tests. Escalar el worker es agregar réplicas.

**ADR-003. Cola de trabajos sobre Postgres**
- Contexto: se necesita procesamiento asíncrono con orden por teléfono y reintentos.
- Opciones: (A) tabla `job` con `SKIP LOCKED` y advisory locks; (B) Redis con una librería de colas; (C) cola gestionada del proveedor de nube.
- Decisión: A para el MVP.
- Consecuencias: cero dependencias nuevas; transacciones atómicas entre "recibí el evento" y "encolé el job"; throughput de sobra para 200 tenants. Límite: si la tabla `job` supera decenas de miles de filas activas o se necesitan colas con prioridades complejas, migrar a B. A verificar en Fase 6: que la librería elegida soporte este patrón sin reinventarlo.

**ADR-004. Webhook responde 200 de inmediato; procesamiento asíncrono y serializado por teléfono**
- Contexto: Meta desactiva webhooks que fallan o tardan; los mensajes de un mismo usuario dependen del orden.
- Decisión: verificar firma, deduplicar por `event_key`, encolar, responder. El worker toma un advisory lock por teléfono.
- Consecuencias: latencia percibida depende del worker, no del webhook; un teléfono nunca se procesa en paralelo consigo mismo; hay que manejar "responder dos veces" tras un crash (ver flujo).

**ADR-005. El LLM solo selecciona herramientas; las cifras las produce el backend**
- Contexto: decisión 4 del brief y política de Meta.
- Opciones: (A) LLM redacta la respuesta final con los números de las herramientas; (B) plantillas en backend con los resultados estructurados; LLM redacta solo aclaraciones.
- Decisión: B.
- Consecuencias: respuestas consistentes y verificables; menos tokens de salida; menos "naturalidad" en el texto, que se compensa con buenas plantillas en la Fase 4. Validación de números en las aclaraciones.

**ADR-006. Toda escritura pasa por `pending_action` y confirmación con botón, procesada sin LLM**
- Contexto: decisión 9 del brief; los botones son inequívocos.
- Decisión: las herramientas de escritura crean un borrador; la confirmación es un handler determinista.
- Consecuencias: cero escrituras accidentales; una escritura cuesta un mensaje extra; un solo borrador activo por teléfono, lo que simplifica el estado.

**ADR-007. Visión multimodal del LLM para facturas, no OCR dedicado**
- Contexto: las facturas venezolanas son heterogéneas (térmicas, manuscritas, fotos torcidas). Un OCR clásico devuelve texto que igual habría que interpretar.
- Opciones: (A) OCR gestionado más LLM; (B) modelo de visión del LLM con salida estructurada.
- Decisión: B.
- Consecuencias: un solo proveedor y un solo paso; costo por imagen a verificar en Fase 6; si la precisión en el piloto es insuficiente, se reabre con A.

**ADR-008. Proveedores de LLM y voz detrás de interfaces, con respaldo, sin reintento de escrituras**
- Decisión: interfaz `LlmClient` y `SpeechClient`; principal y respaldo configurables por variable de entorno; un intento en el respaldo ante timeout o 5xx; nunca se reintenta silenciosamente un flujo que podría escribir.
- Consecuencias: cambio de proveedor sin tocar el agente; evals deben correr contra ambos.

**ADR-009. Patrón adapter para proveedores de datos; solo `LocalProvider` en el MVP**
- Contexto: Odoo como premium posterior.
- Decisión: interfaz `LedgerProvider` (crear, editar, borrar, cierre, consultas); implementación única. `OdooProvider` no se escribe hasta que un cliente lo pague.
- Consecuencias: la interfaz se diseña con lo que Odoo necesitaría (ids externos, fechas contables), sin implementarlo. Riesgo de "abstracción prematura" aceptado porque la interfaz es pequeña.

**ADR-010. Multi-tenant row-level con RLS**
- Ver Fase 2. Registrado aquí por completitud.

**ADR-011. Tasa BCV por cron con fuente principal y respaldo; "vigente" vs "última publicada"**
- Contexto: el BCV publica en la tarde la tasa del siguiente día hábil.
- Decisión: cron a las 17:30 y 20:00 hora Caracas más reintento horario; cada fila tiene `effective_date`; "vigente hoy" es la mayor `effective_date <= hoy`. Las fuentes concretas y su fiabilidad se eligen en Fase 6 y se marcan como "verificar".
- Consecuencias: nunca se aplica una tasa antes de su vigencia; fines de semana usan la del viernes; si nadie publica, el sistema lo dice en vez de callar.

**ADR-012. Sin mensajes proactivos ni plantillas en el MVP**
- Contexto: decisión 2 del brief; costo y aprobación de plantillas.
- Decisión: todo lo inicia el usuario. El recordatorio de cierre y el resumen automático van a iteración 2 con plantillas de utilidad.
- Consecuencias: costo de Meta cercano a cero en el MVP (verificar precio vigente de conversaciones de servicio); el riesgo de "el dueño no escribe el cierre" queda sin mitigar hasta la iteración 2.

### Decisiones tomadas en la Fase 3

- Monolito modular, procesos web y worker, cola en Postgres, serialización por teléfono.
- LLM como enrutador de herramientas; plantillas de backend para toda cifra; validación de números en aclaraciones.
- Botones y verificación se procesan sin LLM.
- Herramientas filtradas por rol antes de llegar al LLM, y validadas de nuevo dentro.
- Visión multimodal para facturas; audio con acuse previo y borrado posterior.
- Presupuesto de tokens por tenant y día.
- Sin mensajes proactivos.

### Preguntas abiertas (resueltas al aprobar la fase)

1. Fuera de alcance: tres botones (Registrar gasto, Registrar venta, Ver cierre). El enlace al dashboard va en "ayuda". Aprobado.
2. El dueño pidió un cuarto botón de tasa. WhatsApp permite 3 botones por mensaje, así que la tasa del día se muestra en el texto del menú y "tasa" como palabra se resuelve sin LLM. Aprobado.
3. Tope diario por tenant: **sin tope duro en el MVP**. Se mide el costo real por mensaje desde el walking skeleton; el tope se define en Fase 6 como múltiplo del consumo promedio con precios verificados. Alerta interna si un tenant supera 3 veces el promedio. El mecanismo queda implementado y apagado por configuración.
4. Indicador de "escribiendo": se verifica en la semana 1 con el número de prueba; si no está disponible, el acuse por texto lo reemplaza. Aprobado.

### Riesgos detectados

- Advisory lock por teléfono más un LLM lento puede acumular jobs de un mismo dueño que manda cinco mensajes seguidos. Mitigación: el worker procesa en orden y el dueño ve respuestas en orden; el timeout de 20 s acota el peor caso.
- Plantillas de backend demasiado rígidas pueden sonar a máquina. Mitigación: la Fase 4 invierte en redacción y variantes.
- Extracción de facturas con baja precisión en fotos malas. Mitigación: umbral de confianza y caída a texto; medir en el piloto antes de prometerlo.
- El presupuesto por tenant y día puede cortar a un dueño legítimo en un día pesado. Mitigación: tope generoso, mensaje claro, y el dashboard siempre disponible.

---

## Fase 4. UX conversacional (WhatsApp)

### Principios de tono

1. **Español venezolano, tuteo, profesional sin ser acartonado.** Como le hablaría un contador joven de confianza al dueño: claro, corto, sin "estimado usuario" y sin "épale mi pana".
2. **Una cosa por mensaje.** Nunca dos preguntas. Nunca un párrafo donde cabe una línea.
3. **Siempre mostrar lo que se entendió antes de guardar.** El dueño confirma un resumen, no una interpretación oculta.
4. **Cifras siempre con moneda y formato local.** `$15,00` y `Bs 1.850,00`. Coma decimal, punto de miles. Bs por encima de 999.999.999 se abrevia (`Bs 1,85 MM`).
5. **Emojis con función, no decoración.** Como máximo uno por mensaje y solo como marcador visual: ✅ guardado, ⚠️ atención, 📊 cierre, 💵 tasa. Nunca en preguntas ni errores.
6. **Nunca culpar al usuario.** "No encontré el monto" en vez de "no escribiste el monto".
7. **El bot no conversa.** No saluda de vuelta con párrafos, no pregunta cómo estás, no opina. Cumple y se calla.

### Cuándo usar texto, botones o listas

| Situación | Formato | Razón |
|---|---|---|
| Entrada de datos (gasto, venta, consulta) | Texto libre, voz o foto | Es la propuesta de valor: escribir como a la cajera |
| Confirmar una escritura | 3 botones: Guardar / Corregir / Cancelar | Inequívoco, un toque, se procesa sin LLM |
| Decisión binaria (USD o Bs, Reemplazar o Agregar) | 2 o 3 botones | Un toque |
| Menú principal | Texto con tasa del día + 3 botones | Los 3 casos de uso más frecuentes |
| Elegir entre 4 o más opciones (categoría ambigua, método de pago, período) | Lista (hasta 10 filas) | Los botones no alcanzan; la lista no ensucia el chat |
| Cierre, resúmenes, consultas | Texto formateado con negritas | Se lee de un vistazo, se puede reenviar al socio |
| Errores | Texto, una línea, con el siguiente paso | Sin botones: el siguiente paso es escribir |

Límites que el código debe respetar (a verificar en la documentación vigente de Meta durante la semana 1): 3 botones por mensaje, 20 caracteres por título de botón; 10 filas por lista, 24 caracteres por título de fila, 72 por descripción; cuerpo de mensaje interactivo hasta 1.024 caracteres.

Regla de identificadores: todo botón y fila lleva un id con prefijo y objetivo (`confirm:<pending_id>`, `cancel:<pending_id>`, `fix:<pending_id>`, `currency:USD`, `cat:<category_id>`, `menu:expense`), para que el handler determinista sepa qué hacer sin leer el texto.

### Mapa de flujos

```mermaid
flowchart TD
    in([Mensaje entrante]) --> id{Número conocido?}
    id -- no --> unk[Texto fijo: enlace de registro]
    id -- pendiente de verificar --> code{6 dígitos?}
    code -- sí, correcto --> welcome[Bienvenida + menú]
    code -- no --> askcode[Pide el código del dashboard]
    id -- activo --> route{Tipo}

    route -- botón confirm/cancel/fix --> pend[Handler de borrador]
    route -- hola / menú --> menu[Tasa del día + 3 botones]
    route -- tasa --> rate[Tasa vigente y próxima]
    route -- ayuda --> help[Ejemplos + enlace dashboard]
    route -- texto / voz / foto --> agent[Agente]

    agent --> tool{Herramienta}
    tool -- draft_expense --> dexp[Borrador de gasto]
    tool -- draft_income_* --> dinc[Borrador de venta]
    tool -- amend / delete --> dfix[Borrador de corrección]
    tool -- get_daily_close / period / category --> report[Reporte formateado]
    tool -- get_bcv_rate --> rate
    tool -- ask_clarification --> clar[Pregunta con botones o lista]
    tool -- reject_out_of_scope --> oos[Fuera de alcance + menú]

    dexp --> confirm{Guardar / Corregir / Cancelar}
    dinc --> confirm
    dfix --> confirm
    confirm -- Guardar --> saved[✅ Guardado + total del día]
    confirm -- Corregir --> agent
    confirm -- Cancelar --> canc[Descartado]
    confirm -- 10 min sin respuesta --> exp[Borrador vencido]
    clar --> agent
```

### Onboarding

**Paso 1, dashboard.** El dueño entra a la web, pone su correo, recibe el magic link, y completa: nombre del negocio, tipo (lista de 5), moneda por defecto de gastos (USD preseleccionado), su número de WhatsApp. El dashboard muestra:

> Tu código de vinculación es **482913**. Envíalo por WhatsApp al asistente para activar tu número.
> [Abrir WhatsApp] (enlace `wa.me` con el código ya escrito)

**Paso 2, WhatsApp.**

> **Dueño:** 482913
>
> **Bot:** ✅ Listo, tu número quedó vinculado a *Autolavado El Rápido*.
>
> Soy tu asistente de caja. Me escribes como le escribirías a tu cajera:
> • _gasté 15$ en champú_
> • _hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto_
> • _cómo va el mes_
>
> También me puedes mandar una nota de voz o la foto de una factura.
>
> Tasa BCV hoy: *Bs 36,45*
> [Registrar gasto] [Registrar venta] [Ver cierre]

**Empleado.** El dueño agrega el número desde el dashboard con rol Empleado. No hay código: el empleado escribe cualquier cosa y recibe:

> **Bot:** Hola, Carlos. Quedaste registrado como empleado de *Autolavado El Rápido*. Puedes registrar gastos y ventas; los cierres los ve el dueño.
> Ejemplo: _gasté 5$ en hielo_

Por qué sin código para el empleado: el dueño ya lo autorizó desde su cuenta, y el número es el identificador. Si el dueño se equivoca de número, lo desactiva y listo. Menos fricción, riesgo bajo.

### Menú, tasa y ayuda (sin LLM)

> **Dueño:** hola
>
> **Bot:** Tasa BCV hoy: *Bs 36,45* (vigente 29/09)
> ¿Qué quieres hacer?
> [Registrar gasto] [Registrar venta] [Ver cierre]

Al tocar un botón del menú, el bot pide el dato con un ejemplo, y el siguiente mensaje va al agente:

> **Dueño:** [Registrar gasto]
>
> **Bot:** Dime el gasto. Ejemplo: _gasté 15$ en champú_ o mándame la foto de la factura.

> **Dueño:** tasa
>
> **Bot:** 💵 Tasa BCV
> Vigente hoy (lun 29/09): *Bs 36,45*
> Próxima (mar 30/09): *Bs 36,52*

Si no hay próxima publicada, la segunda línea no aparece. Si la vigente tiene más de 3 días hábiles:

> ⚠️ Esta tasa es del jueves 25/09; no he podido actualizarla. Verifica en bcv.org.ve antes de usarla.

> **Dueño:** ayuda
>
> **Bot:** Esto es lo que puedo hacer:
> • Registrar gastos: _gasté 15$ en champú_, o nota de voz, o foto de la factura
> • Registrar ventas: _hoy vendí 350$: 200 efectivo, 150 pago móvil_
> • Cierre: _cierre de hoy_, _cómo va el mes_, _cuánto gasté en insumos esta semana_
> • Tasa: _tasa_
> Para ver, corregir o exportar todo: {enlace al dashboard}

### Skill: registrar gasto

**Caso simple.**

> **Dueño:** gasté 15$ en champú
>
> **Bot:** Gasto por confirmar:
> *$15,00* (Bs 546,75 a tasa 36,45)
> Champú · Insumos de lavado
> Hoy, lun 29/09
> [Guardar] [Corregir] [Cancelar]
>
> **Dueño:** [Guardar]
>
> **Bot:** ✅ Guardado. Gastos de hoy: *$47,00* (3 registros).

Diseño: la línea de total del día es el refuerzo que hace que el dueño sienta que "algo se acumula". No se agrega nada más.

**Moneda ambigua** (sin moneda por defecto configurada, o texto explícitamente ambiguo):

> **Dueño:** pagué 500 de hielo
>
> **Bot:** ¿500 en qué moneda?
> [Dólares] [Bolívares]
>
> **Dueño:** [Bolívares]
>
> **Bot:** Gasto por confirmar:
> *Bs 500,00* ($13,72 a tasa 36,45)
> Hielo · Insumos de lavado
> Hoy, lun 29/09
> [Guardar] [Corregir] [Cancelar]

Con USD por defecto configurado, "pagué 500 de hielo" se interpreta como $500 y el resumen lo muestra en grande; el dueño lo ve y corrige si no era. Es una decisión de diseño consciente: mejor un resumen visible que una pregunta cada vez.

**Gasto en bolívares con "mil".**

> **Dueño:** 450 mil bs de gasolina ayer
>
> **Bot:** Gasto por confirmar:
> *Bs 450.000,00* ($12.345,68 a tasa 36,45)
> Gasolina · Transporte y gasolina
> Ayer, dom 28/09 (tasa del viernes 26/09)
> [Guardar] [Corregir] [Cancelar]

Nota: el ejemplo usa una tasa ficticia. La conversión la hace el backend. Se muestra "tasa del viernes" porque el domingo no hay tasa propia.

**Corregir el borrador.**

> **Dueño:** [Corregir]
>
> **Bot:** Dime qué cambio. Ejemplo: _eran 25_, _es mantenimiento_, _fue el sábado_.
>
> **Dueño:** eran 25 y es mantenimiento
>
> **Bot:** Gasto por confirmar:
> *$25,00* (Bs 911,25 a tasa 36,45)
> Champú · Mantenimiento de equipos
> Hoy, lun 29/09
> [Guardar] [Corregir] [Cancelar]

**Corregir después de guardar** (menos de 30 minutos):

> **Dueño:** no, eran 20
>
> **Bot:** Cambio el último gasto:
> Champú · $15,00 → *$20,00*
> [Guardar] [Cancelar]

Después de 30 minutos:

> **Bot:** Ese gasto ya tiene más de 30 minutos. Lo puedes corregir aquí: {enlace directo al movimiento}

**Borrar.**

> **Dueño:** bórralo
>
> **Bot:** Elimino el último gasto: Champú · $15,00 · hoy.
> [Eliminar] [Cancelar]
>
> **Dueño:** [Eliminar]
>
> **Bot:** ✅ Eliminado. Gastos de hoy: *$32,00* (2 registros).

**Categoría ambigua o desconocida** (lista, porque suele haber más de 3 candidatas):

> **Dueño:** gasté 40$ en el técnico
>
> **Bot:** ¿En qué categoría va "el técnico"?
> [Ver categorías]
> → Mantenimiento de equipos / Nómina y pagos a personal / Otros / … (lista de hasta 10)
>
> **Dueño:** (elige Mantenimiento de equipos)
>
> **Bot:** Gasto por confirmar: … [Guardar] [Corregir] [Cancelar]

Regla: el agente solo pregunta la categoría cuando no tiene una sugerencia con confianza razonable. En la mayoría de los casos sugiere y el dueño corrige si quiere. Preguntar siempre sería insoportable.

**Nota de voz.**

> **Dueño:** 🎤 (nota de voz: "anota ahí veinte dólares de la comida de los muchachos")
>
> **Bot:** Recibí tu nota de voz, dame un momento.
>
> **Bot:** Entendí: _"anota ahí veinte dólares de la comida de los muchachos"_
> Gasto por confirmar:
> *$20,00* (Bs 729,00 a tasa 36,45)
> Comida de los muchachos · Comida del personal
> Hoy, lun 29/09
> [Guardar] [Corregir] [Cancelar]

Si no hay monto:

> **Bot:** Entendí: _"compré los productos del lavado"_
> No encontré el monto. ¿Cuánto fue?

Si la transcripción falla:

> **Bot:** No pude escuchar bien la nota de voz. ¿Me lo escribes?

**Foto de factura.**

> **Dueño:** 📷 (foto de factura de Ferretería El Tornillo)
>
> **Bot:** Recibí la foto, dame un momento.
>
> **Bot:** Leí la factura:
> Ferretería El Tornillo · 27/09
> Total *Bs 1.240,00* ($34,02 a tasa 36,45)
> Categoría: Mantenimiento de equipos
> [Guardar] [Corregir] [Cancelar]

Si la fecha de la factura no es hoy, se usa la de la factura y se muestra; el dueño corrige si la pagó otro día. Si no se pudo leer:

> **Bot:** No pude leer bien la factura. ¿Cuánto fue y en qué moneda?

Y el siguiente texto crea el borrador con la foto adjunta igual.

### Skill: registrar venta

**Total del día con desglose.**

> **Dueño:** hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto
>
> **Bot:** Venta del día por confirmar (lun 29/09):
> Efectivo USD · *$200,00*
> Pago Móvil · *$100,00* (Bs 3.645,00)
> Punto · *$50,00* (Bs 1.822,50)
> Total *$350,00*
> [Guardar] [Corregir] [Cancelar]
>
> **Dueño:** [Guardar]
>
> **Bot:** ✅ Venta guardada. Hoy: vendiste *$350,00*, gastaste *$47,00*.

Nota de diseño: "pago móvil 100" en un mensaje en dólares se interpreta como el equivalente en dólares de un pago recibido en Bs. El resumen muestra ambos para que el dueño vea si era eso. Si el dueño escribe "3.645 bs de pago móvil", se guarda en Bs como original.

**Desglose que no cuadra.**

> **Dueño:** hoy vendí 350$: 200 efectivo, 100 pago móvil
>
> **Bot:** El desglose suma *$300,00* y el total es *$350,00*. Faltan *$50,00*.
> ¿Cómo lo dejo?
> [Total $350] [Total $300] [Corregir]

"Total $350" guarda los $50 restantes como "Sin especificar". "Total $300" ajusta el total al desglose. Ambas son decisiones del dueño, no del bot.

**Solo total.**

> **Dueño:** hoy vendimos 280$
>
> **Bot:** Venta del día por confirmar (lun 29/09):
> Sin especificar · *$280,00*
> Si quieres, dime el desglose: _200 efectivo, 80 pago móvil_
> [Guardar] [Corregir] [Cancelar]

**Día ya cerrado.**

> **Dueño:** hoy vendí 400$
>
> **Bot:** Ya tienes una venta del día registrada hoy por *$350,00*.
> [Reemplazar] [Agregar] [Cancelar]

**Ingreso suelto.**

> **Dueño:** me pagaron 30$ por zelle del carro del abogado
>
> **Bot:** Ingreso por confirmar:
> *$30,00* · Zelle
> "del carro del abogado"
> Hoy, lun 29/09
> [Guardar] [Corregir] [Cancelar]

### Skill: cierre y consultas

**Cierre del día.**

> **Dueño:** cierre
>
> **Bot:** 📊 Cierre del lun 29/09
>
> *Ventas: $350,00*
> Efectivo USD $200,00
> Pago Móvil $100,00 (Bs 3.645,00)
> Punto $50,00 (Bs 1.822,50)
>
> *Gastos: $47,00*
> Insumos de lavado $27,00
> Comida del personal $20,00
>
> *Resultado: $303,00* (Bs 11.044,35 a tasa 36,45)
>
> Efectivo en caja: $200,00 · Bs 0,00
> 5 movimientos · Dashboard: {enlace}

Reglas de formato: primero ventas, luego gastos, luego resultado en negrita, luego el efectivo real para cuadrar la gaveta, luego conteo y enlace. Categorías y métodos ordenados de mayor a menor. Máximo 6 líneas por bloque; si hay más categorías, se agrupan en "Otros N".

**Sin movimientos.**

> **Bot:** No tengo movimientos registrados hoy. Si vendiste o gastaste algo, dímelo y lo anoto.

**Resumen del mes.**

> **Dueño:** cómo va el mes
>
> **Bot:** 📊 Septiembre (1 al 29)
>
> *Ventas: $6.420,00*
> *Gastos: $2.115,00*
> *Resultado: $4.305,00*
>
> Gastos más grandes:
> Nómina y pagos a personal $900,00
> Insumos de lavado $610,00
> Agua y electricidad $240,00
>
> 18 días con movimientos · Dashboard: {enlace}

**Consulta por categoría.**

> **Dueño:** cuánto gasté en insumos este mes
>
> **Bot:** Insumos de lavado, septiembre: *$610,00* en 14 gastos.

Si la categoría no existe:

> **Bot:** No tengo una categoría "productos". ¿Te refieres a alguna de estas?
> [Insumos de lavado] [Mantenimiento] [Otros]

**Empleado pide el cierre.**

> **Empleado:** cierre
>
> **Bot:** El cierre lo ve el dueño. Tú puedes registrar gastos y ventas.

### Fuera de alcance

> **Dueño:** redáctame un mensaje para un cliente que no ha pagado
>
> **Bot:** Solo te ayudo con tu caja: registrar gastos, registrar ventas y ver el cierre.
> [Registrar gasto] [Registrar venta] [Ver cierre]

Sin disculpas largas, sin explicar la política de Meta, sin ofrecer alternativas. El botón es la alternativa.

### Errores y bordes

| Situación | Mensaje |
|---|---|
| LLM caído | "Ahora mismo no puedo procesar esto. Inténtalo en unos minutos." |
| Borrador vencido y el dueño toca Guardar | "Esa confirmación ya venció. Mándame el gasto de nuevo." |
| Dos borradores (manda otro gasto sin confirmar el anterior) | El nuevo reemplaza al anterior: "Descarté el gasto anterior sin guardar. Nuevo gasto por confirmar: …" |
| Número desconocido | "Este número no está registrado. Crea tu cuenta aquí: {enlace}" (sin más) |
| Número desactivado | Igual que desconocido |
| Audio de más de 2 minutos | "Solo proceso notas de voz cortas (hasta 2 minutos). ¿Me lo resumes?" |
| Foto que no es factura | "Solo puedo leer facturas o recibos. Si es un gasto, escríbemelo." |
| Fecha rara (futura, o hace más de 30 días) | "¿El gasto fue el 15/08? Es de hace más de un mes." [Sí, esa fecha] [Es de hoy] [Cancelar] |
| Monto cero o negativo | "Necesito un monto mayor a cero." |
| Sin tasa BCV para la fecha (nunca cargada) | "No tengo la tasa BCV para esa fecha, así que no puedo convertir. Inténtalo más tarde." |
| Mensaje con varias cosas ("gasté 20 en hielo y 30 en gasolina") | Se registra uno por uno: "Vamos por partes. Primero: Gasto por confirmar: *$20,00* Hielo …" y al guardar: "Ahora el segundo: …". Máximo 3 por mensaje |
| Texto muy largo (más de 500 caracteres) | "Ese mensaje es muy largo. Mándame un gasto o una venta a la vez." |

### Categorías por defecto por tipo de negocio

Máximo 10 por tipo para que quepan en una lista de WhatsApp. "Otros" siempre existe y no se puede desactivar. El dueño puede renombrar, desactivar y crear desde el dashboard.

| Autolavado (`car_wash`) | Comida (`food`) | Comercio (`retail`) | Servicios (`services`) | Otro (`other`) |
|---|---|---|---|---|
| Insumos de lavado | Ingredientes | Mercancía | Materiales y herramientas | Insumos |
| Agua y electricidad | Empaques | Alquiler | Transporte | Alquiler |
| Mantenimiento de equipos | Gas y electricidad | Servicios (luz, agua, internet) | Nómina y contratistas | Servicios (luz, agua, internet) |
| Nómina y pagos a personal | Equipos y utensilios | Nómina | Alquiler | Nómina |
| Alquiler | Delivery y transporte | Transporte y fletes | Servicios (luz, agua, internet) | Transporte |
| Transporte y gasolina | Publicidad y redes | Mantenimiento | Publicidad | Mantenimiento |
| Comida del personal | Nómina y ayudantes | Publicidad | Equipos | Publicidad |
| Publicidad | Alquiler | Impuestos y trámites | Impuestos y trámites | Impuestos y trámites |
| Impuestos y trámites | Impuestos y trámites | Otros | Otros | Otros |
| Otros | Otros | | | |

Métodos de pago (fijos, para ventas): Efectivo USD, Efectivo Bs, Pago Móvil, Punto, Zelle, Transferencia USD, Transferencia Bs, Otro.

### Vocabulario que el agente debe entender (para el prompt y las evals)

- Monedas: `$`, `dólares`, `dolares`, `verdes`, `usd` → USD. `bs`, `bolos`, `bolívares`, `bolivares`, `bsf` → VES.
- Cantidades: `500 mil` = 500.000; `1 palo` = 1.000.000 (Bs); `medio millón`; coma decimal `15,50`; punto de miles `1.200`.
- Fechas: `hoy`, `ayer`, `antier`, `el lunes` (el más reciente), `el 15`, `la semana pasada` (rango).
- Métodos: `pago móvil`, `pagomóvil`, `pm`, `punto`, `punto de venta`, `pdv`, `zelle`, `efectivo`, `cash`, `transferencia`, `transfe`.
- Verbos de gasto: `gasté`, `pagué`, `compré`, `se fue`, `salieron`, `anota`.
- Verbos de venta: `vendí`, `vendimos`, `entró`, `cobré`, `me pagaron`, `facturamos`.
- Cierre: `cierre`, `cómo fue hoy`, `cómo va el mes`, `resumen`, `cuánto llevo`.

### Decisiones tomadas en la Fase 4

- Tono: venezolano, tuteo, corto, un emoji funcional como máximo.
- Menú = tasa del día en texto + 3 botones. "tasa" y "ayuda" se resuelven sin LLM.
- Empleado no necesita código: el dueño lo autoriza desde el dashboard.
- Con moneda por defecto configurada, no se pregunta la moneda; se muestra en grande en el resumen.
- El agente sugiere categoría; solo pregunta (con lista) cuando no tiene confianza.
- Desglose que no cuadra: el dueño decide entre dos totales o corregir. El bot no rellena solo.
- Un mensaje con varios gastos se procesa uno por uno, máximo 3.
- Un nuevo borrador reemplaza al anterior sin guardar, con aviso.
- El cierre siempre termina con "Efectivo en caja" por moneda y el enlace al dashboard.
- Categorías por defecto definidas para los 5 tipos, máximo 10 por tipo.

### Preguntas abiertas

1. **Nombre del asistente.** Meta exige un nombre visible para el número, y los guiones lo necesitan ("Soy tu asistente de caja"). ¿Tienes marca? Si no, propongo algo corto, en español, que diga lo que hace. Se decide antes de solicitar el número.
2. El botón "Registrar gasto": confirmo que va "gasto" y no "pagos". Si querías "pagos" a propósito, dime por qué.
3. En el cierre, ¿"Resultado" te sirve como etiqueta, o prefieres "Ganancia del día" aunque no incluya todo? Mi recomendación sigue siendo "Resultado" para no prometer lo que no es.

### Riesgos detectados

- Los guiones asumen que el agente extrae bien montos en formato venezolano ("450 mil bs", "15,50"). Es el caso de prueba número uno de las evals de la Fase 8.
- La interpretación de "pago móvil 100" dentro de un mensaje en dólares puede confundir a algún dueño que piensa en Bs. Mitigación: el resumen muestra ambos montos; medir correcciones en el piloto.
- Un menú con la tasa del día cuesta una consulta a la base por cada "hola"; trivial, pero la tasa debe estar cacheada en memoria del worker para no depender de la base en cada saludo.
- Los límites de caracteres de botones y listas pueden cortar nombres de categorías largos ("Servicios (luz, agua, internet)" tiene 31). Mitigación: título corto en la fila y descripción con el detalle; validar en la semana 1.
