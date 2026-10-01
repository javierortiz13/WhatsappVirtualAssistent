# Documento de Diseño del MVP

Asistente de caja por WhatsApp para pymes venezolanas.

Documento acumulativo. Cada fase agrega una sección al cerrarse.

| Fase | Estado |
|---|---|
| 0. Descubrimiento (Product Brief) | Aprobado |
| 1. Requerimientos | Aprobado |
| 2. Modelo de dominio y datos | Aprobado |
| 3. Arquitectura | Aprobado |
| 4. UX conversacional | Aprobado |
| 5. UX/UI dashboard | Aprobado |
| 6. Stack tecnológico | Aprobado |
| 7. Seguridad, cumplimiento y riesgos | Aprobado |
| 8. Plan de ejecución | Aprobado. Diseño cerrado el 29/09/2026; comienza la construcción |

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

**US-B2. Moneda ambigua (Must, S).** *(Reescrita al aprobar la Fase 4.)*
Como dueño, quiero que si escribo "gasté 2.000 de hielo" el sistema entienda que son bolívares, para no tener que aclararlo cada vez.
- Dado que el texto indica moneda o símbolo, cuando lo interpreto, entonces esa moneda manda.
- Dado que el texto no indica moneda y el monto es mayor o igual al umbral del tenant (1.000 por defecto), cuando lo interpreto, entonces la moneda es VES y el resumen la marca como inferida.
- Dado que el texto no indica moneda y el monto es menor al umbral, cuando lo interpreto, entonces uso la moneda por defecto del tenant y el resumen la marca como inferida.
- Dado que el tenant no tiene moneda por defecto y el monto es menor al umbral, cuando lo interpreto, entonces pregunto con dos botones: **Dólares** / **Bolívares**.
- La inferencia es una regla determinista del backend, nunca del LLM. El umbral es configurable por tenant y por entorno (una reconversión lo cambiaría).

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
| Conversaciones Meta | Todas iniciadas por el usuario (ventana de servicio). Cero plantillas en el MVP | **Actualizado en Fase 6:** desde el 01/10/2026 los mensajes de servicio se cobran por mensaje entregado, con 1.000 gratis por número y mes. Ver Fase 6 y ADR-001 revisado |
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
- Moneda sin indicar: regla determinista por umbral (1.000 o más = Bs; menos = moneda por defecto del tenant). Solo se pregunta si no hay moneda por defecto. *(Actualizado en Fase 4.)*
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
  wa_phone_number_id        text,                          -- número de WhatsApp que atiende a este tenant; ver ADR-001 revisado
  close_reminder_time       time NOT NULL DEFAULT '18:00',
  status                    text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','suspended')),
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE phone_number (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  e164          text NOT NULL UNIQUE,                       -- un número, un tenant
  wa_user_id    text UNIQUE,                                -- id de usuario con ámbito de negocio (BSUID); ver Fase 6
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
| `draft_expense` | `amount` (string decimal), `currency` (`USD`, `VES` o `null`), `description`, `category_name` (de la lista o `null`), `business_date` (ISO o `null` = hoy) | `amount > 0`, máximo 2 decimales; `currency` nulo → regla de umbral (≥ 1.000 = VES, si no, default del tenant); sin default y bajo el umbral → `needs_currency`; fecha futura o > 30 días → `needs_date_confirmation`; categoría fuera de la lista → sugiere la más parecida u "Otros"; resuelve tasa; calcula equivalentes; crea `pending_action(create_expense)` | Borrador: monto, moneda, equivalente, tasa y su fecha, categoría, fecha, `pending_id` | owner, employee |
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
- **Revisión 29/09/2026 (Fase 6):** Meta cobra por mensaje de servicio entregado desde el 01/10/2026, con una franja gratuita de 1.000 mensajes **por número y mes**. Un número compartido reparte esa franja entre todos los tenants y cuesta unos 4 USD por tenant al mes a escala; un número por tenant cuesta cero dentro de la franja. **Decisión revisada:** la plataforma soporta N números desde el día uno (`tenant.wa_phone_number_id`); el piloto corre con un número compartido; cada cliente de pago recibe su propio número registrado en el WABA de la plataforma. Detalle y cifras en la Fase 6.

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

**ADR-013. Sin historia de tasas, se usa la primera conocida; la tasa manual es corrección, no requisito** (29/09/2026, tras la prueba real del día 6)
- Contexto: "ayer pagué 450 mil de hielo" falló el primer día en producción porque la base solo tenía la tasa de hoy. Se evaluó pedirle la tasa al dueño en ese momento.
- Opciones: (A) pedir la tasa al dueño cuando no exista; (B) usar la primera tasa conocida posterior y mostrar su fecha en el borrador; (C) B más carga de 60 días de historia al arrancar y una corrección opcional "tasa X" en el borrador.
- Decisión: C. A se descarta porque introduce fricción en el registro, mete cifras humanas donde la regla es "la tasa la pone el sistema" (Fase 3) y rompe la comparabilidad entre negocios.
- Consecuencias: el borrador siempre muestra la fecha de la tasa aplicada; `rates:import` (día 7) carga historia desde el Excel del BCV; "a tasa 850" en un borrador o en una corrección guarda `rate_source = manual` con auditoría (hecho en S2 día 2, migración 0003). El caso queda acotado a fechas anteriores a toda la historia cargada.

**ADR-014. Cada mensaje de servicio cuesta desde el 1 de octubre de 2026: una respuesta es un mensaje, los acuses son reacciones** (30/09/2026)
- Contexto: desde el 1/10/2026 Meta cobra por mensaje las respuestas libres dentro de la ventana de 24 h, a la tarifa de utilidad del país del cliente (Venezuela cae en "Rest of Latin America", unos 0,013 USD por mensaje según terceros; la tabla oficial manda). Cada número de negocio tiene 1.000 mensajes de servicio gratis al mes, no acumulables. Lo que escribe el cliente y las reacciones son gratis y no gastan cupo. Sin método de pago en la cuenta, los mensajes de servicio no se entregan. Con ADR-002 (un número de la plataforma para todos los negocios) el cupo gratis es uno solo para toda la plataforma.
- Números: un movimiento por chat son hoy 2 mensajes (borrador y confirmación). A 0,013 USD, 200 movimientos al mes por negocio serían 5,2 USD si la plataforma ya agotó el cupo, más que todo el presupuesto de 5 USD por tenant. El reparto de la Fase 6 asignaba 0,5 USD a Meta.
- Decisión, en tres capas:
  1. **Una respuesta = un mensaje.** El backend ya compone la respuesta completa (ADR-006); el LLM nunca envía texto. Los únicos dos envíos seguidos (bienvenida del empleado y respuesta) se fusionan en uno. Regla para todo flujo nuevo: nada de "ok", "un momento" ni saludos previos.
  2. **Acuses como reacción.** Cancelar un borrador responde con 🗑️ sobre el toque del botón, sin mensaje de texto. Guardar sigue siendo texto porque lleva el total del día, que es la retroalimentación del producto; queda como candidato a reacción si la medición lo exige.
  3. **Medir antes de decidir sobre el número.** `pnpm metrics` reporta el cupo del mes (enviados, reacciones, sobre cupo, costo estimado, proyección) y el reparto por negocio. Si la proyección supera el cupo con pocos negocios, se revisa ADR-002: un número por negocio devuelve 1.000 gratis a cada uno y para un negocio pequeño (menos de 500 movimientos al mes) el costo de Meta vuelve a cero; el precio es el alta de números (registro, verificación por SMS, nombre visible) que ya está en el plan de la Fase 7.
- Consecuencias: el número de prueba sigue con mensajes gratis a sus 5 destinatarios, así que el piloto no paga; al pasar al número real hay que tener tarjeta en el Billing Hub del portafolio o el bot "queda mudo" sin factura. El indicador de "escribiendo" y el acuse de lectura van por el mismo endpoint pero no son mensajes. El tope diario por tenant (Fase 6) se define contando mensajes de Meta además de tokens.

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
> Soy *Asistente de Caja* (nombre provisional). Me escribes como le escribirías a tu cajera:
> • _gasté 15$ en champú_
> • _hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto_
> • _cómo va el mes_
>
> También me puedes mandar una nota de voz o la foto de una factura.
>
> Tasa BCV hoy: *Bs 858,00*
> [Registrar gasto] [Registrar venta] [Ver cierre]

**Empleado.** El dueño agrega el número desde el dashboard con rol Empleado. No hay código: el empleado escribe cualquier cosa y recibe:

> **Bot:** Hola, Carlos. Quedaste registrado como empleado de *Autolavado El Rápido*. Puedes registrar gastos y ventas; los cierres los ve el dueño.
> Ejemplo: _gasté 5$ en hielo_

Por qué sin código para el empleado: el dueño ya lo autorizó desde su cuenta, y el número es el identificador. Si el dueño se equivoca de número, lo desactiva y listo. Menos fricción, riesgo bajo.

### Menú, tasa y ayuda (sin LLM)

> **Dueño:** hola
>
> **Bot:** Tasa BCV hoy: *Bs 858,00* (vigente 29/09)
> ¿Qué quieres hacer?
> [Registrar gasto] [Registrar venta] [Ver cierre]

Al tocar un botón del menú, el bot pide el dato con un ejemplo, y el siguiente mensaje va al agente:

> **Dueño:** [Registrar gasto]
>
> **Bot:** Dime el gasto. Ejemplo: _gasté 15$ en champú_ o mándame la foto de la factura.

> **Dueño:** tasa
>
> **Bot:** 💵 Tasa BCV
> Vigente hoy (lun 29/09): *Bs 858,00*
> Próxima (mar 30/09): *Bs 859,30*

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
> *$15,00* (Bs 12.870,00 a tasa 858,00)
> Champú · Insumos de lavado
> Hoy, lun 29/09
> [Guardar] [Corregir] [Cancelar]
>
> **Dueño:** [Guardar]
>
> **Bot:** ✅ Guardado. Gastos de hoy: *$47,00* (3 registros).

Diseño: la línea de total del día es el refuerzo que hace que el dueño sienta que "algo se acumula". No se agrega nada más.

**Moneda sin indicar.** Regla determinista del backend: 1.000 o más sin moneda es Bs; menos de 1.000 es la moneda por defecto del tenant. El resumen marca la moneda inferida.

> **Dueño:** pagué 2.000 de hielo
>
> **Bot:** Gasto por confirmar:
> *Bs 2.000,00* ($2,33 a tasa 858,00) · entendí bolívares
> Hielo · Insumos de lavado
> Hoy, lun 29/09
> [Guardar] [Corregir] [Cancelar]

> **Dueño:** pagué 40 de hielo
>
> **Bot:** Gasto por confirmar:
> *$40,00* (Bs 34.320,00 a tasa 858,00) · entendí dólares
> Hielo · Insumos de lavado
> Hoy, lun 29/09
> [Guardar] [Corregir] [Cancelar]

Solo si el tenant no tiene moneda por defecto y el monto está bajo el umbral:

> **Bot:** ¿40 en qué moneda?
> [Dólares] [Bolívares]

Por qué así: con la tasa en cientos de bolívares por dólar, la magnitud es una señal casi infalible. Nadie escribe "2.000" pensando en dólares para el hielo, y nadie escribe "40" pensando en bolívares. El caso raro (una nevera de $1.500 sin símbolo) se ve en el resumen y se corrige con "eran dólares". El umbral vive en configuración porque una reconversión lo invalidaría.

**Gasto en bolívares con "mil".**

> **Dueño:** 450 mil bs de gasolina ayer
>
> **Bot:** Gasto por confirmar:
> *Bs 450.000,00* ($524,48 a tasa 858,00)
> Gasolina · Transporte y gasolina
> Ayer, dom 28/09 (tasa del viernes 26/09)
> [Guardar] [Corregir] [Cancelar]

Nota: las tasas de los ejemplos son ilustrativas. La conversión la hace el backend. Se muestra "tasa del viernes" porque el domingo no hay tasa propia.

**Corregir el borrador.**

> **Dueño:** [Corregir]
>
> **Bot:** Dime qué cambio. Ejemplo: _eran 25_, _es mantenimiento_, _fue el sábado_.
>
> **Dueño:** eran 25 y es mantenimiento
>
> **Bot:** Gasto por confirmar:
> *$25,00* (Bs 21.450,00 a tasa 858,00)
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
> *$20,00* (Bs 17.160,00 a tasa 858,00)
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
> Total *Bs 1.240,00* ($1,45 a tasa 858,00)
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
> Pago Móvil · *$100,00* (Bs 85.800,00)
> Punto · *$50,00* (Bs 42.900,00)
> Total *$350,00*
> [Guardar] [Corregir] [Cancelar]
>
> **Dueño:** [Guardar]
>
> **Bot:** ✅ Venta guardada. Hoy: vendiste *$350,00*, gastaste *$47,00*.

Nota de diseño: "pago móvil 100" en un mensaje en dólares se interpreta como el equivalente en dólares de un pago recibido en Bs. El resumen muestra ambos para que el dueño vea si era eso. Si el dueño escribe "85.800 bs de pago móvil", se guarda en Bs como original.

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
> **Bot:** 📊 Cierre diario · lun 29/09
>
> *Ventas: $350,00*
> Efectivo USD $200,00
> Pago Móvil $100,00 (Bs 85.800,00)
> Punto $50,00 (Bs 42.900,00)
>
> *Gastos: $47,00*
> Insumos de lavado $27,00
> Comida del personal $20,00
>
> *Ventas menos gastos: $303,00* (Bs 259.974,00 a tasa 858,00)
>
> Efectivo en caja: $200,00 · Bs 0,00
> 5 movimientos · Dashboard: {enlace}

Reglas de formato: primero ventas, luego gastos, luego "Ventas menos gastos" en negrita (si es negativo se muestra "−$40,00", sin eufemismos), luego el efectivo real para cuadrar la gaveta, luego conteo y enlace. Categorías y métodos ordenados de mayor a menor. Máximo 6 líneas por bloque; si hay más categorías, se agrupan en "Otros N".

**Sin movimientos.**

> **Bot:** No tengo movimientos registrados hoy. Si vendiste o gastaste algo, dímelo y lo anoto.

**Resumen del mes.**

> **Dueño:** cómo va el mes
>
> **Bot:** 📊 Cierre del mes · Septiembre (1 al 29)
>
> *Ventas: $6.420,00*
> *Gastos: $2.115,00*
> *Ventas menos gastos: $4.305,00*
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
- Moneda sin indicar: regla de umbral en backend (1.000 o más = Bs; menos = moneda por defecto). Solo se pregunta sin moneda por defecto. El resumen marca "entendí dólares / bolívares".
- El agente sugiere categoría; solo pregunta (con lista) cuando no tiene confianza.
- Desglose que no cuadra: el dueño decide entre dos totales o corregir. El bot no rellena solo.
- Un mensaje con varios gastos se procesa uno por uno, máximo 3.
- Un nuevo borrador reemplaza al anterior sin guardar, con aviso.
- El cierre siempre termina con "Efectivo en caja" por moneda y el enlace al dashboard.
- Categorías por defecto definidas para los 5 tipos, máximo 10 por tipo.

### Preguntas abiertas (resueltas al aprobar la fase)

1. **Nombre del asistente.** No hay marca todavía; el fundador la definirá con una campaña en redes. Placeholder configurable: "Asistente de Caja". Se usa con el número de prueba; el nombre definitivo se decide antes de solicitar el número de producción, porque el nombre visible pasa revisión de Meta y cambiarlo después puede requerir otra revisión (verificar proceso vigente).
2. Botón "Registrar gasto" confirmado ("pagos" fue un error de dictado).
3. Etiqueta del neto: el título del mensaje es "Cierre diario" y la línea del neto es "Ventas menos gastos", que se explica sola y no miente cuando es negativo.
4. Moneda sin indicar: el fundador pidió inferir por magnitud. Se adopta como regla determinista de backend con umbral configurable (ver US-B2).

### Riesgos detectados

- Los guiones asumen que el agente extrae bien montos en formato venezolano ("450 mil bs", "15,50"). Es el caso de prueba número uno de las evals de la Fase 8.
- La interpretación de "pago móvil 100" dentro de un mensaje en dólares puede confundir a algún dueño que piensa en Bs. Mitigación: el resumen muestra ambos montos; medir correcciones en el piloto.
- Un menú con la tasa del día cuesta una consulta a la base por cada "hola"; trivial, pero la tasa debe estar cacheada en memoria del worker para no depender de la base en cada saludo.
- Los límites de caracteres de botones y listas pueden cortar nombres de categorías largos ("Servicios (luz, agua, internet)" tiene 31). Mitigación: título corto en la fila y descripción con el detalle; validar en la semana 1.

---

## Fase 5. UX/UI del dashboard

### Rol del dashboard en el producto

WhatsApp es la puerta de entrada y el uso diario. El dashboard es **la trastienda**: donde se ve todo junto, se corrige lo que el bot entendió mal, se exporta para el contador y se configura el negocio. Un dueño puede pasar semanas sin abrirlo y el producto sigue funcionando. Consecuencias de diseño:

1. Mobile-first de verdad: se diseña a 360 px de ancho y se adapta hacia arriba. La mayoría lo abrirá desde el enlace que el bot manda por WhatsApp, en el mismo teléfono.
2. Cero gráficos en el MVP. Números grandes y tablas. Un gráfico mal hecho en un teléfono es peor que una tabla bien hecha.
3. Toda cifra del dashboard sale de las mismas consultas que alimentan al bot. Si el bot dice $303,00, el dashboard dice $303,00.
4. Registrar desde el dashboard existe como respaldo (cuando el bot no entendió, o para cargar cosas viejas), no como camino principal.

### Arquitectura de información

```
Público
├── /login                      Correo → magic link
├── /auth/verify?token=…        Valida el enlace, crea sesión
└── /registro                   Onboarding en 2 pasos (solo primera vez)
    ├── Paso 1: negocio         Nombre, tipo, moneda por defecto
    └── Paso 2: WhatsApp        Número, código, "Abrir WhatsApp", espera de verificación

Privado (barra inferior en móvil, barra lateral en escritorio)
├── /inicio                     Tasa, hoy, mes, últimos movimientos, avisos
├── /movimientos                Lista filtrable de gastos y ventas
│   ├── /movimientos/nuevo      Alta manual (respaldo)
│   └── /movimientos/:id        Detalle, edición, foto, auditoría, eliminar
├── /cierres                    Día / semana / mes / rango, mismo formato que WhatsApp, exportar
└── /ajustes
    ├── /ajustes/negocio        Nombre, tipo, moneda por defecto, umbral Bs, hora de cierre
    ├── /ajustes/categorias     Crear, renombrar, activar/desactivar, ordenar
    ├── /ajustes/numeros        Números y roles, estado de verificación
    ├── /ajustes/exportar       Rango → .xlsx
    └── /ajustes/cuenta         Correo, cerrar sesión
```

Reservado, sin UI en el MVP: `/ajustes/integraciones` (Odoo, premium).

Navegación (revisada en S2, bloque de diseño): un menú lateral que en el teléfono abre el botón ☰ de la cabecera y en escritorio queda fijo a la izquierda, con Inicio, Movimientos, Cierres y la sección Negocio (Categorías, Números de WhatsApp, Exportar a Excel, Ajustes), más "Abrir el asistente" y cerrar sesión abajo. Sustituye a las 4 pestañas inferiores del borrador. El "+" de alta manual sigue fuera del MVP: el alta es por WhatsApp.

### Wireframes (móvil, 360 px)

**Login**

```
┌──────────────────────────────┐
│                              │
│      [logo]  Asistente       │
│              de Caja         │
│                              │
│  Tu caja, por WhatsApp.      │
│                              │
│  Correo                      │
│  ┌──────────────────────┐    │
│  │ javier@ejemplo.com   │    │
│  └──────────────────────┘    │
│  ┌──────────────────────┐    │
│  │  Enviarme el enlace  │    │
│  └──────────────────────┘    │
│                              │
│  Te llega un enlace al       │
│  correo. Sin contraseñas.    │
│                              │
└──────────────────────────────┘

Tras enviar:
│  ✉ Revisa tu correo.         │
│  El enlace vence en 15 min.  │
│  ¿No llegó? [Reenviar] (60s) │
```

**Onboarding, paso 1: negocio**

```
┌──────────────────────────────┐
│ ● ○   Tu negocio             │
│                              │
│  Nombre del negocio          │
│  ┌──────────────────────┐    │
│  │ Autolavado El Rápido │    │
│  └──────────────────────┘    │
│  Tipo                        │
│  ┌──────────────────────┐    │
│  │ Autolavado         ▾ │    │
│  └──────────────────────┘    │
│  Moneda en la que sueles     │
│  hablar de gastos            │
│  (●) Dólares  ( ) Bolívares  │
│                              │
│  Te crearemos categorías de  │
│  gasto típicas de un         │
│  autolavado. Luego las       │
│  puedes cambiar.             │
│                              │
│  ┌──────────────────────┐    │
│  │      Continuar       │    │
│  └──────────────────────┘    │
└──────────────────────────────┘
```

**Onboarding, paso 2: WhatsApp**

```
┌──────────────────────────────┐
│ ○ ●   Tu WhatsApp            │
│                              │
│  Número del dueño            │
│  ┌────┐ ┌─────────────────┐  │
│  │+58▾│ │ 412 1234567     │  │
│  └────┘ └─────────────────┘  │
│                              │
│  Tu código de vinculación    │
│  ┌──────────────────────┐    │
│  │       482913         │    │
│  └──────────────────────┘    │
│  Envíalo desde ese número    │
│  al asistente.               │
│                              │
│  ┌──────────────────────┐    │
│  │   Abrir WhatsApp  ↗  │    │  ← wa.me con el código prellenado
│  └──────────────────────┘    │
│                              │
│  ◌ Esperando tu mensaje…     │  ← se actualiza solo (polling 3 s)
│  Vence en 14:32              │
│  [Generar otro código]       │
└──────────────────────────────┘

Al verificar:
│  ✅ Número vinculado.        │
│  Ya puedes escribirle al     │
│  asistente.  [Ir a Inicio]   │
```

**Inicio**

```
┌──────────────────────────────┐
│ Autolavado El Rápido      ⚙  │
│                              │
│ Tasa BCV hoy   Bs 858,00     │
│ vigente lun 29/09 · próx 859,30│
│                              │
│ ┌─ HOY ───────────────────┐  │
│ │ Ventas          $350,00 │  │
│ │ Gastos           $47,00 │  │
│ │ ───────────────────────  │  │
│ │ Ventas − gastos $303,00 │  │
│ │ Efectivo: $200 · Bs 0   │  │
│ └─────────────────────────┘  │
│                              │
│ ┌─ SEPTIEMBRE ────────────┐  │
│ │ Ventas        $6.420,00 │  │
│ │ Gastos        $2.115,00 │  │
│ │ Ventas − gastos $4.305  │  │
│ │ 18 días con movimientos │  │
│ └─────────────────────────┘  │
│                              │
│ ⚠ Hoy no has registrado la   │
│   venta del día.             │  ← solo si son > 18:00 y no hay day_total
│                              │
│ Últimos movimientos          │
│ ▸ Champú          −$15,00    │
│   Insumos · 🎤 · 10:32       │
│ ▸ Venta del día  +$350,00    │
│   3 métodos · ✍ · ayer 19:05 │
│ ▸ Gasolina  −Bs 450.000,00   │
│   Transporte · ✍ · ayer      │
│   [Ver todos]                │
│                              │
│                          (+) │
├──────────────────────────────┤
│  Inicio  Movim.  Cierres  Aj.│
└──────────────────────────────┘
```

Iconos de canal: ✍ texto, 🎤 voz, 📷 foto, 🖥 dashboard. Se muestran porque sirven para detectar de dónde vienen los errores.

**Movimientos**

```
┌──────────────────────────────┐
│ Movimientos              🔍  │
│ [Todos] [Gastos] [Ventas]    │
│ [Septiembre ▾] [Categoría ▾] │
│                              │
│ LUN 29/09         −$47 +$350 │
│ ▸ Champú            −$15,00  │
│   Insumos de lavado · 🎤     │
│ ▸ Comida muchachos  −$20,00  │
│   Comida del personal · ✍    │
│ ▸ Hielo          −Bs 2.000   │
│   Insumos · ✍ · ($2,33)      │
│ ▸ Venta del día    +$350,00  │
│   Efec. $200 · PM $100 · …   │
│                              │
│ DOM 28/09         −$524 +$0  │
│ ▸ Gasolina      −Bs 450.000  │
│   Transporte · ✍ · ($524,48) │
│                              │
│ SÁB 27/09        −$34 +$410  │
│ ▸ Ferretería El T. −Bs 1.240 │
│   Mantenimiento · 📷         │
│ …                            │
│                          (+) │
├──────────────────────────────┤
│  Inicio  Movim.  Cierres  Aj.│
└──────────────────────────────┘
```

Reglas: agrupado por día con subtotal del día en la cabecera; monto original en grande y equivalente en pequeño; filtro "Eliminados" escondido en el buscador para no ensuciar; scroll infinito por mes.

**Detalle y edición de un movimiento**

```
┌──────────────────────────────┐
│ ←  Gasto                  ⋮  │
│                              │
│  Monto        Moneda         │
│  ┌──────────┐ ┌──────┐       │
│  │ 15,00    │ │ USD ▾│       │
│  └──────────┘ └──────┘       │
│  = Bs 12.870,00 a tasa 858,00│
│                              │
│  Fecha                       │
│  ┌──────────────────────┐    │
│  │ lun 29/09/2026     ▾ │    │
│  └──────────────────────┘    │
│  ⚠ Si cambias la fecha, se   │
│    recalcula con la tasa de  │
│    ese día.                  │  ← solo aparece al tocar la fecha
│                              │
│  Categoría                   │
│  ┌──────────────────────┐    │
│  │ Insumos de lavado  ▾ │    │
│  └──────────────────────┘    │
│  Descripción                 │
│  ┌──────────────────────┐    │
│  │ Champú               │    │
│  └──────────────────────┘    │
│                              │
│  Factura                     │
│  ┌────────┐                  │
│  │ [foto] │  Ver · Quitar    │
│  └────────┘                  │
│                              │
│  Registrado por WhatsApp 🎤  │
│  Javier · lun 29/09 10:32    │
│  "anota ahí veinte dólares…" │  ← transcripción, si vino de voz
│  Editado: nunca              │
│                              │
│  ┌──────────────────────┐    │
│  │       Guardar        │    │
│  └──────────────────────┘    │
│        Eliminar gasto        │  ← texto rojo, pide confirmación
└──────────────────────────────┘
```

Para una venta del día, el detalle muestra las líneas por método y permite editar cada una; el total se recalcula y se muestra, no se edita.

**Alta manual (respaldo)**

Mismo formulario que el detalle, vacío, con un selector arriba: (●) Gasto ( ) Venta. Fecha por defecto hoy. Moneda por defecto la del tenant. Se guarda con `source_channel = dashboard`.

**Cierres**

```
┌──────────────────────────────┐
│ Cierres                      │
│ [Día] [Semana] [Mes] [Rango] │
│ ‹  lun 29/09/2026  ›         │
│                              │
│ Ventas             $350,00   │
│  Efectivo USD      $200,00   │
│  Pago Móvil        $100,00   │
│                 Bs 85.800,00 │
│  Punto              $50,00   │
│                 Bs 42.900,00 │
│                              │
│ Gastos              $47,00   │
│  Insumos de lavado  $27,00   │
│  Comida del personal $20,00  │
│                              │
│ ══════════════════════════   │
│ Ventas − gastos    $303,00   │
│              Bs 259.974,00   │
│ a tasa 858,00 del 29/09      │
│                              │
│ Efectivo en caja             │
│  Dólares           $200,00   │
│  Bolívares          Bs 0,00  │
│                              │
│ 5 movimientos  [Ver lista]   │
│ [Exportar este período .xlsx]│
├──────────────────────────────┤
│  Inicio  Movim.  Cierres  Aj.│
└──────────────────────────────┘
```

En "Mes" se agrega la tabla "Gastos por categoría" completa (no solo top 5) y "Ventas por método". Sin gráficos.

**Ajustes**

```
┌──────────────────────────────┐
│ Ajustes                      │
│                              │
│ ▸ Negocio                    │
│   Autolavado El Rápido       │
│ ▸ Categorías                 │
│   10 activas                 │
│ ▸ Números y roles            │
│   2 números · 1 pendiente    │
│ ▸ Exportar                   │
│   Excel por rango de fechas  │
│ ▸ Cuenta                     │
│   javier@ejemplo.com         │
│                              │
│ Asistente de Caja v0.1       │
│ Ayuda por WhatsApp: [abrir]  │
├──────────────────────────────┤
│  Inicio  Movim.  Cierres  Aj.│
└──────────────────────────────┘
```

**Números y roles**

```
┌──────────────────────────────┐
│ ←  Números y roles           │
│                              │
│ +58 412 1234567    Dueño     │
│ Javier · ✅ verificado       │
│                              │
│ +58 414 7654321    Empleado  │
│ Carlos · ✅ activo   [⋮]     │  ← ⋮: cambiar rol, desactivar
│                              │
│ +58 416 1112233    Empleado  │
│ María · ◌ aún no ha escrito  │
│                              │
│ ┌──────────────────────┐     │
│ │  + Agregar número    │     │
│ └──────────────────────┘     │
│                              │
│ Los empleados registran      │
│ gastos y ventas. Solo el     │
│ dueño ve los cierres.        │
└──────────────────────────────┘

Agregar número (hoja inferior):
│  Nombre      [Carlos      ]  │
│  Número      [+58▾][414…  ]  │
│  Rol         (●) Empleado    │
│              ( ) Dueño       │
│  [Agregar]                   │
```

**Categorías**

```
┌──────────────────────────────┐
│ ←  Categorías de gasto       │
│                              │
│ ≡ Insumos de lavado      ✎   │
│ ≡ Agua y electricidad    ✎   │
│ ≡ Mantenimiento de equipos ✎ │
│ ≡ Nómina y pagos a personal✎ │
│ ≡ Alquiler               ✎   │
│ ≡ Transporte y gasolina  ✎   │
│ ≡ Comida del personal    ✎   │
│ ≡ Publicidad             ✎   │
│ ≡ Impuestos y trámites   ✎   │
│ ≡ Otros                  🔒  │
│                              │
│ Desactivadas (1)  [ver]      │
│                              │
│ ┌──────────────────────┐     │
│ │  + Nueva categoría   │     │
│ └──────────────────────┘     │
│ Máximo 10 activas para que   │
│ quepan en la lista de        │
│ WhatsApp.                    │
└──────────────────────────────┘
```

Regla: si el dueño intenta activar la undécima, el dashboard pide desactivar otra. Renombrar no toca los movimientos históricos (referencian el id).

**Exportar**

```
┌──────────────────────────────┐
│ ←  Exportar                  │
│                              │
│  Desde   [01/09/2026]        │
│  Hasta   [30/09/2026]        │
│  Incluir ( ) Gastos          │
│          ( ) Ventas          │
│          (●) Todo            │
│  ☐ Incluir eliminados        │
│                              │
│  ┌──────────────────────┐    │
│  │  Descargar Excel     │    │
│  └──────────────────────┘    │
│                              │
│  Columnas: fecha, tipo,      │
│  categoría, descripción,     │
│  monto, moneda, tasa, USD,   │
│  Bs, método, quién, canal.   │
└──────────────────────────────┘
```

### Escritorio

Mismo contenido, barra lateral izquierda con las 4 entradas, contenido a máximo 1.100 px. Movimientos pasa a tabla con columnas (fecha, descripción, categoría/método, monto, equivalente, quién, canal) y el detalle se abre en un panel lateral en vez de una página. Nada más cambia. No se diseña una experiencia distinta para escritorio: se ensancha la de móvil.

### Flujos de usuario principales

**F1. Primer día (onboarding).** Login por correo → paso 1 negocio → paso 2 número y código → abre WhatsApp con el código prellenado → envía → la pantalla se actualiza sola a "vinculado" → Inicio vacío con un solo mensaje: "Escríbele al asistente tu primer gasto" y el enlace a WhatsApp.

**F2. Corregir algo que el bot entendió mal (después de 30 min).** El bot manda el enlace directo `/movimientos/:id` → se abre el detalle en el teléfono → cambia monto o categoría → Guardar → vuelve a WhatsApp. Tres toques.

**F3. Fin de mes para el contador.** Cierres → Mes → "Exportar este período" → se descarga el .xlsx → lo reenvía por WhatsApp al contador. O Ajustes → Exportar con rango libre.

**F4. Agregar a la cajera.** Ajustes → Números y roles → Agregar → nombre, número, Empleado → listo. Ella escribe cualquier cosa al asistente y queda activa.

**F5. "Hoy no registré la venta".** Aviso en Inicio después de las 18:00 → toca el aviso → se abre WhatsApp con el texto "hoy vendí " prellenado. El dashboard no pide la venta: la manda al canal donde el hábito vive.

### Estados vacíos y de error

| Pantalla | Vacío | Error |
|---|---|---|
| Inicio, sin movimientos | "Todavía no hay nada. Escríbele al asistente: _gasté 15$ en champú_" + botón a WhatsApp | "No pude cargar tus datos. [Reintentar]" |
| Movimientos, filtro sin resultados | "Nada con esos filtros. [Quitar filtros]" | Igual |
| Cierres, día sin datos | "Sin movimientos el 29/09." | Igual |
| Sin conexión | Banner superior "Sin conexión" y la última vista cargada sigue visible en solo lectura | |
| Sesión vencida | Vuelve a login con el mensaje "Tu sesión venció, pídete otro enlace" | |

### Decisiones tomadas en la Fase 5

- Dashboard como trastienda: ver, corregir, exportar, configurar. Registrar manualmente es respaldo.
- Cuatro pestañas fijas: Inicio, Movimientos, Cierres, Ajustes. Botón "+" para alta manual.
- Cero gráficos en el MVP; números grandes y tablas.
- Cierres en el dashboard con exactamente el mismo formato y las mismas consultas que el mensaje de WhatsApp.
- Iconos de canal (texto, voz, foto, dashboard) visibles en cada movimiento.
- Máximo 10 categorías activas, forzado desde el dashboard.
- El aviso "no registraste la venta" lleva a WhatsApp con texto prellenado, no a un formulario.
- Escritorio = móvil ensanchado con barra lateral y tabla; sin diseño aparte.
- PWA instalable (Must). Tokens de diseño con tema claro y oscuro según el sistema (Must); interruptor manual (Should).
- Hora del aviso de venta configurable por tenant, 18:00 por defecto.
- Odoo no tiene UI en el MVP; la ruta queda reservada.

### Preguntas abiertas (resueltas al aprobar la fase)

1. PWA instalable con icono en el teléfono: **Must**. Condiciona la elección de frontend en la Fase 6.
2. Tema claro y oscuro desde el día uno, construidos sobre tokens de diseño (colores, espaciados, tipografía como variables). El tema sigue la preferencia del sistema; el interruptor manual es Should.
3. Hora del aviso "no registraste la venta": configurable por tenant desde el MVP en Ajustes → Negocio, con 18:00 hora Caracas por defecto. La mayoría de los comercios cierra entre 17:00 y 18:00.

### Riesgos detectados

- El dueño puede intentar usar el dashboard como sistema principal y pedir funciones de POS. Mitigación: el alta manual es deliberadamente básica y la copy empuja a WhatsApp.
- Edición de fecha con recálculo de tasa puede sorprender ("cambié la fecha y me cambió el monto en Bs"). Mitigación: advertencia visible antes de guardar y auditoría del cambio.
- Nombres de categoría largos rompen la lista móvil. Mitigación: límite de 24 caracteres en el formulario, alineado con el límite de filas de WhatsApp.

---

## Fase 6. Stack tecnológico

### Cómo leer los precios

Todos los precios de esta sección fueron consultados el **29/09/2026**. Cada uno lleva una etiqueta:

- **[verificado]**: leído directamente en la página oficial.
- **[secundario]**: obtenido de resúmenes de búsqueda o agregadores que citan la página oficial, porque el entorno de investigación no pudo abrir la página. Hay que confirmarlo en la URL indicada antes de contratar.

Regla general: ningún precio de esta sección es un compromiso. Meta puede cambiar tarifas el primer día de cada trimestre; los proveedores de LLM cambian precios y retiran modelos cada pocos meses. La tabla de costos se recalcula con el consumo real medido desde la semana 1.

### Restricciones que gobiernan la elección

1. Un solo dev, con TypeScript y Next.js en los dedos. Nada de Python.
2. Cuentas existentes: Vercel y Supabase. Sin créditos de API en ningún LLM.
3. Tarjeta internacional propia y una empresa en Estados Unidos para facturación.
4. Costo total por tenant por debajo de 5 USD al mes con 20 USD de precio.
5. Hallazgos de la investigación que cambian el tablero: Meta cobra los mensajes de servicio desde el 01/10/2026; Vercel no ejecuta procesos persistentes; Haiku 4.5 tiene retiro tentativo en octubre de 2026.

### Opciones por capa

**Backend y frontend**

| Opción | Pros | Contras | Costo | Curva |
|---|---|---|---|---|
| **A) Next.js (App Router) para dashboard y webhook + worker Node aparte, mismo monorepo** | Un lenguaje, un repo, tipos compartidos entre web, worker y dominio. El webhook es una route handler que solo valida, inserta y responde 200 | Dos procesos que desplegar en dos sitios (Vercel no corre workers) | El de hosting | Cero: es lo que ya usas |
| B) Next.js + procesamiento en funciones serverless con `waitUntil` | Un solo despliegue en Vercel | Sin serialización por teléfono garantizada; límites de duración; el agente con LLM y voz dentro de una función es frágil; no hay cron fino en Hobby | Vercel Pro | Baja |
| C) NestJS o Fastify para API + Next.js solo como frontend | Backend "clásico" | Duplicas capa HTTP y despliegues sin ganar nada a esta escala | Igual que A | Media |

**Decisión: A.** Monorepo con pnpm workspaces: `apps/web` (Next.js: dashboard, API interna, webhook), `apps/worker` (Node: pg-boss, agente, cron), `packages/core` (dominio, herramientas, ledger, render), `packages/db` (esquema, migraciones, cliente). El worker importa `core`; la web importa `core` y `db`. Nada de lógica de negocio en `apps/`.

**Base de datos, auth y archivos**

| Opción | Pros | Contras | Costo mensual | Curva |
|---|---|---|---|---|
| **A) Supabase Pro: Postgres + RLS + Storage + Auth (magic link)** | Ya lo usas. RLS nativo. Storage privado con URLs firmadas. Auth con magic link resuelto. pg_cron disponible. Backups diarios incluidos | Pro es obligatorio: el plan Free pausa proyectos tras una semana de inactividad. El pooler exige cuidado con `SET LOCAL` (usar modo sesión o transacción con la variable dentro de la misma transacción) | 25 USD [secundario], incluye 10 USD de crédito de cómputo (instancia Micro), 8 GB de disco, 100 GB de storage | Cero |
| B) Postgres gestionado en Railway, Neon o Render + R2 + Auth.js | Más barato en algún caso | Tres proveedores en vez de uno; auth y storage a mano | 13 a 20 USD + R2 (gratis hasta 10 GB) | Media |
| C) Postgres en VPS propio | Más barato | Backups, parches y madrugadas tuyas | 0 sobre el VPS | Alta en operación |

**Decisión: A.** Supabase Pro. Storage de Supabase para las fotos (100 GB incluidos: a 0,45 GB por mes por cada 1.500 fotos, alcanza años). Auth de Supabase con magic link y Resend como SMTP personalizado (el SMTP incluido de Supabase es para desarrollo).

**ORM y migraciones**

| Opción | Pros | Contras |
|---|---|---|
| **A) Drizzle ORM + drizzle-kit** | SQL explícito, migraciones como SQL (las políticas RLS y los índices parciales se escriben tal cual), adaptador oficial de pg-boss para encolar dentro de la transacción, `numeric` se lee como string (obliga a usar `Decimal`, que es lo que queremos) | Menos "mágico" que Prisma | 
| B) Prisma | Muy conocido | RLS y `SET LOCAL` requieren extensiones o `$executeRaw`; `Decimal` propio pero migraciones menos transparentes para políticas |
| C) Kysely + SQL a mano | Máximo control | Más código de plomería |

**Decisión: A.** Drizzle, con `decimal.js` para toda aritmética monetaria. `numeric` nunca se convierte a `number`.

**Cola de trabajos**

| Opción | Pros | Contras | Estado (29/09/2026) |
|---|---|---|---|
| **A) pg-boss 12.x sobre el Postgres de Supabase** | `SKIP LOCKED`, reintentos con backoff, cron con zona horaria, y **`key_strict_fifo` con `singletonKey` = teléfono**: un job a la vez por teléfono, en orden, sin bloquear otros teléfonos. Encolar dentro de la misma transacción que `webhook_event` con el adaptador de Drizzle | Requiere Node 22.12+ y su propio schema `pgboss` en la base | Activo: 12.35.0 publicado el 26/09/2026 [verificado en GitHub] |
| B) graphile-worker | Sólido, cron ACID | La serialización por clave es por "named queue" y su documentación desaconseja claves de alta cardinalidad (un teléfono por cola). Sigue en 0.x | 0.18.0 [verificado], fecha de la versión sin confirmar |
| C) Supabase Queues (pgmq) + Edge Functions | Sin proceso persistente | Edge Functions no son un worker de larga duración; sin serialización por clave nativa; el agente con LLM y voz no cabe cómodo | Disponible [secundario] |
| D) Redis + BullMQ | Estándar de la industria | Una dependencia más que pagar y operar; no aporta nada a este volumen | — |

**Decisión: A.** pg-boss con `key_strict_fifo`. Confirmar que la versión fijada incluye esa política (aparece en la documentación de master; verificar en las notas de la versión).

**Hosting del worker** (Vercel no puede: solo funciones con límite de duración, y el plan Hobby prohíbe uso comercial)

| Opción | Pros | Contras | Costo mensual |
|---|---|---|---|
| **A) Railway** | Despliegue desde el repo, logs, escala a réplicas con un clic, Node sin configurar nada | Facturación por uso; los precios por vCPU y GB tienen dos valores contradictorios en las fuentes [secundario] | Hobby 5 USD (incluye 5 USD de uso); un worker de 0,5 vCPU y 512 MB estimado en 5 a 10 USD netos |
| B) Render (background worker Starter) | Precio fijo, simple | Precio exacto sin confirmar (probablemente 7 USD) [secundario] | ~7 USD |
| C) Fly.io (shared-cpu-1x, 512 MB) | El más barato | Configuración algo más manual; su Postgres gestionado es caro (38 USD), así que igual necesitas Supabase | ~3,20 a 3,60 USD [secundario] |
| D) Hetzner CX23 (2 vCPU, 4 GB) con todo self-hosted | El más barato por potencia | Tú operas Postgres, backups, TLS, parches. Precio subió dos veces en 2026 | ~5,49 EUR + IPv4 + IVA [secundario] |

**Decisión: A.** Railway para el worker en el MVP; Fly como alternativa si el costo de Railway se dispara. Hetzner queda como plan de reducción de costos a 200 tenants si alguna vez hace falta, no antes.

**Hosting del dashboard y el webhook**

| Opción | Pros | Contras | Costo |
|---|---|---|---|
| **A) Vercel Pro** | Ya lo usas; despliegues por rama; Next.js de primera clase. El webhook responde 200 en una función | Hobby no permite uso comercial: Pro es obligatorio. Funciones limitadas a 300 s por defecto (sobra: el webhook tarda milisegundos) | 20 USD [secundario] |
| B) La web también en Railway | Un solo proveedor de cómputo, 20 USD menos | Sin la comodidad de Vercel para Next.js; tú configuras dominio y CDN | ~5 a 10 USD adicionales |

**Decisión: A** para el MVP. Si a los 3 meses el costo fijo pesa, mover la web a Railway es un día de trabajo.

**LLM del agente** (tool-calling con 11 herramientas, prompt en español, una llamada corta por mensaje)

| Modelo | Entrada / salida por millón de tokens | Caché de lectura | Notas | Estado |
|---|---|---|---|---|
| Claude Opus 5.5 | 4 / 20 USD | 0,20 | El más capaz; sobra para un enrutador de herramientas | [verificado, referencia de la API de Claude] |
| **Claude Sonnet 5.5** | **2 / 10 USD** | **0,20** | Tool-calling, salidas estructuradas, visión, caché de prompt, 1M de contexto. Español documentado por Anthropic con rendimiento cercano al inglés | [verificado] |
| Claude Haiku 4.5 | 1 / 5 USD | 0,10 | La mitad de precio, pero la página de modelos indica retiro tentativo "no antes del 15/10/2026" | [verificado el precio; verificar la fecha de retiro antes de decidir] |
| Gemini Flash-Lite (3.1) | 0,25 / 1,50 USD | 0,025 | El más barato con diferencia. Tarifa de Google Cloud (Vertex); la del Gemini Developer API no se pudo abrir. Soporte de tool-calling y JSON por confirmar en su documentación | [secundario] |
| Gemini Flash (3.x) | 0,75 / 3,75 USD promocional hasta 31/12/2026; después 1,50 / 7,50 | 0,075 | Precio promocional; presupuestar con el precio posterior | [secundario] |
| OpenAI GPT-5.4 nano / mini | 0,20 / 1,25 y 0,75 / 4,50 USD | — | Solo fuentes de terceros; nombres de modelo sin confirmar | [secundario, no confiable] |

**Decisión: Claude Sonnet 5.5 como principal, Gemini Flash-Lite como respaldo y candidato a principal si las evals lo aprueban.** Razones: precio verificado, calidad en español, caché de prompt que reduce el costo de entrada un 90% en la parte estable (sistema y herramientas), salidas estructuradas para la lectura de facturas, y un solo proveedor para texto y visión. Haiku 4.5 se descarta por el riesgo de retiro; si Anthropic publica un Haiku nuevo, se reevalúa. Parámetros: `effort: "low"` (el agente no necesita razonar largo), `strict: true` en las herramientas, sin `tool_choice` forzado (no lo soporta), `fallbacks: "default"` activado, caché de prompt sobre sistema y herramientas.

**Visión (lectura de facturas)**

Mismo modelo que el agente, con salida estructurada. Costo por foto dominado por la imagen: redimensionar a un máximo de 1.000 px por lado antes de enviar, lo que la deja en unos 1.300 tokens. No hay OCR aparte (ADR-007).

**Voz a texto** (notas de voz OGG/Opus, 5 a 120 s, español venezolano)

| Proveedor | Precio | Formato OGG | Español latino | Vocabulario | Costo para 25 min/mes | Estado |
|---|---|---|---|---|---|---|
| **Deepgram Nova-3** | 0,0043 USD/min, facturado por segundo. 200 USD de crédito inicial | Sí, con detección automática | Sí: `language=es-419` | `keyterm` (términos clave) | 0,11 USD | [secundario] |
| OpenAI gpt-transcribe | 0,0045 USD/min | No aparece en la lista del resumen; convertir con ffmpeg si hace falta | Sí (`es`) | `prompt` | 0,11 USD | [secundario] |
| Gemini (audio como tokens) | ~1 USD por millón de tokens de audio, 32 tokens por segundo | Sí | Sí, sin variante regional | Glosario en el prompt | ~0,07 USD | [secundario] |
| Groq Whisper large-v3-turbo | 0,04 USD/hora, mínimo 10 s por petición | Sí | Sí (`es`) | `prompt` | 0,02 USD | [secundario] |
| AssemblyAI Universal-3.5 | 0,21 USD/hora | Por confirmar | Sí | `keyterms_prompt` | 0,09 USD | [secundario] |

**Decisión: Deepgram Nova-3 como principal (variante regional y términos clave para "pago móvil", "bolívares", categorías), Gemini como respaldo.** A este volumen el precio es irrelevante; la decisión final la toma una prueba con 30 notas de voz reales tuyas y de tu novia en la semana 2. Si Gemini transcribe igual de bien, se elimina un proveedor.

**Correo (magic links)**

Resend: plan gratuito de 3.000 correos al mes con tope de 100 al día [secundario]. Con 200 tenants y logins ocasionales sobra; si el tope diario molesta, Pro cuesta 20 USD. Se configura como SMTP personalizado en Supabase Auth.

**Observabilidad**

| Necesidad | Herramienta | Costo |
|---|---|---|
| Errores con stack trace en web y worker | Sentry (plan gratuito) | 0 |
| Logs estructurados con búsqueda | Axiom o Better Stack (planes gratuitos) más los logs de Railway y Vercel | 0 |
| Métricas de negocio y costo por tenant | La tabla `message` (tokens, latencia, costo) y una vista en el dashboard interno de administración | 0 |
| Uptime del webhook | Better Stack o UptimeRobot, gratuito | 0 |
| Alertas | Correo o un WhatsApp al fundador desde el propio worker | 0 |

**Tasa BCV**

| Fuente | Rol | Notas |
|---|---|---|
| **bcv.org.ve** (scraper propio de la página de tipo de cambio oficial) | Principal | No hay API oficial. Publica en la tarde (16:00 a 18:00 hora Caracas) la tasa del siguiente día hábil, con su fecha valor visible en la página: se parsea esa fecha como `effective_date`. Reportes recurrentes de problemas de certificado TLS: probar `curl -v` desde Railway; si falta un intermedio, agregarlo con `NODE_EXTRA_CA_CERTS`. Nunca desactivar la verificación TLS globalmente |
| **ve.dolarapi.com/v1/dolares/oficial** (DolarAPI, código abierto, MIT) | Respaldo | Gratis. Devuelve `fechaActualizacion`, que es hora de actualización, no fecha valor: se infiere la vigencia por la hora de publicación (después de las 15:00 es la del próximo día hábil) y se marca la fila como `source=dolarapi` para auditarla |
| pydolarve.org | Tercera opción | Gratis; documentación no accesible en la investigación |

Cron: cada 30 minutos entre 15:00 y 20:00 hora Caracas los días hábiles, y una pasada a las 08:00 por si algo falló. Feriados bancarios venezolanos en una tabla editable.

**WhatsApp Cloud API**

Llamadas directas a la Graph API con `fetch`; el SDK oficial de Node está archivado desde 2023. Un cliente propio de 200 líneas: enviar texto, botones, listas, marcar leído con indicador de escritura, descargar medios (la URL de descarga vence en 5 minutos; los medios viven 30 días en Meta).

### Decisión 1 reabierta: uno o N números

Hallazgo [secundario, verificar en la página de precios de Meta y en su CSV de tarifas]: desde el **01/10/2026** Meta cobra por mensaje entregado también los mensajes de servicio (las respuestas dentro de la ventana de 24 h), con una franja gratuita de **1.000 mensajes de servicio entregados por número de teléfono al mes**, sin acumulación. Tarifa para "Resto de Latinoamérica" (incluye Venezuela): entre 0,008 y 0,012 USD por mensaje según la fuente. Además, un WABA sin método de pago registrado deja de entregar mensajes de servicio.

Consumo estimado por tenant: 14 mensajes salientes al día (borradores, confirmaciones, cierres, menús, acuses de voz y foto), unos **420 al mes**.

| Escenario | Meta por tenant al mes | Consecuencia |
|---|---|---|
| Un número compartido, 10 tenants | (4.200 − 1.000) × 0,01 / 10 ≈ **0,32 USD** | Tolerable en el piloto |
| Un número compartido, 200 tenants | (84.000 − 1.000) × 0,01 / 200 ≈ **4,15 USD** | Inviable: consume el presupuesto entero |
| Un número por tenant | 420 < 1.000 → **0 USD** | Viable. Costo del número aparte |

**Decisión revisada (ADR-001):** la plataforma soporta N números desde el día uno. `tenant.wa_phone_number_id` indica qué número atiende a cada negocio; el webhook enruta por el `phone_number_id` del payload más el remitente. El piloto corre con **un número compartido** (la franja gratuita cubre los dos pilotos). Cada cliente de pago recibe **su propio número**, registrado en el WABA de la plataforma, sin que el cliente toque Meta.

De dónde salen los números:
- **Números virtuales de Estados Unidos** desde tu empresa allá (proveedores de numeración con recepción de SMS para la verificación): entre 1 y 2 USD al mes cada uno [verificar proveedor y que Meta acepte ese rango de números; los números VoIP a veces fallan la verificación por SMS].
- **SIMs venezolanas** prepago: costo único bajo, pero hay que mantenerlas activas y guardarlas físicamente. Escala mal.
- **El número del propio cliente**: descartado. Sus clientes le escriben ahí y el asistente recibiría mensajes de terceros.

Límites a verificar antes de escalar: número máximo de teléfonos por WABA, si un negocio no verificado puede enviar con nombre visible pendiente, y cuántos números se pueden registrar por día.

**Identificación del usuario:** desde mediados de 2026 Meta introduce nombres de usuario y un identificador de usuario con ámbito de negocio (BSUID). Si el usuario adopta un nombre de usuario y no hubo mensajes en 30 días, el webhook puede llegar sin número de teléfono. `phone_number` guarda `e164` y `wa_user_id`; la resolución de tenant acepta cualquiera de los dos y completa el que falte. [secundario; verificar en la documentación de BSUID]

### Costo mensual estimado

**Supuestos por tenant y mes:** 390 mensajes entrantes, 420 salientes; 150 turnos de agente con LLM (el resto son botones, menú y tasa, sin LLM); 45 fotos de factura; 75 notas de voz de 20 s (25 minutos). Tokens por turno de agente con Sonnet 5.5: 1.900 de prefijo cacheado (sistema y herramientas), 700 sin caché (historial y mensaje), 250 de salida (llamada a herramienta con razonamiento mínimo).

**Variable por tenant**

| Concepto | Cálculo | USD/mes |
|---|---|---|
| LLM, turnos de agente (Sonnet 5.5) | 150 × (1.900 × 0,20/M + 700 × 2/M + 250 × 10/M) = 150 × 0,0043 | 0,65 |
| Visión, facturas (Sonnet 5.5) | 45 × (1.800 × 2/M + 150 × 10/M) = 45 × 0,0051 | 0,23 |
| Voz a texto (Deepgram) | 25 min × 0,0043 | 0,11 |
| Meta, con número propio | 420 < 1.000 gratis | 0,00 |
| Número virtual propio | estimado | 1,50 |
| **Total variable** | | **2,49** (0,99 sin costo de número) |
| Variante con Gemini Flash-Lite como agente y visión | LLM 0,15 + visión 0,05 | total 1,81 |

**Fijo de plataforma**

| Concepto | 10 tenants | 50 tenants | 200 tenants |
|---|---|---|---|
| Supabase Pro | 25 | 25 | 30 (cómputo Small) |
| Vercel Pro | 20 | 20 | 25 (uso) |
| Railway worker | 8 | 8 | 16 (2 réplicas) |
| Resend, Sentry, logs, uptime | 0 | 0 | 0 a 20 |
| Dominio | 1 | 1 | 1 |
| **Total fijo** | **54** | **54** | **72 a 92** |

**Totales**

| Tenants | Fijo | Variable (2,49 c/u) | Total | Por tenant | Ingreso a 20 USD | Margen bruto |
|---|---|---|---|---|---|---|
| 10 | 54 | 25 | **79** | 7,90 | 200 | 121 (61%) |
| 50 | 54 | 125 | **179** | 3,57 | 1.000 | 821 (82%) |
| 200 | 82 | 498 | **580** | 2,90 | 4.000 | 3.420 (86%) |

Con número compartido a 200 tenants, sumar 830 USD al mes de Meta: el total sube a 1.410 y el margen cae al 65%. Por eso la decisión 1 cambia.

Lectura: el costo por tenant baja de 5 USD a partir de unos 25 tenants; antes de eso lo domina el fijo de 54 USD, que es el precio de no operar servidores. El presupuesto del piloto (30 a 50 USD) queda ligeramente corto: el piloto real cuesta unos **60 USD al mes** (fijo 54 más dos tenants), o unos **35 USD** si la web también corre en Railway y se pospone Vercel Pro.

**Costos de arranque (una vez):** dominio (~12 USD/año), método de pago en el Business Manager de Meta antes del 30/09/2026 si ya existe un WABA, verificación del negocio en Meta (gratis, pero requiere documentos), primer número de producción.

### Stack final

| Capa | Elección |
|---|---|
| Lenguaje | TypeScript en todo, Node 22 |
| Monorepo | pnpm workspaces: `apps/web`, `apps/worker`, `packages/core`, `packages/db` |
| Web | Next.js (App Router) en Vercel Pro. PWA con manifest y service worker mínimo. Tokens de diseño con tema claro y oscuro |
| Worker | Node en Railway, una réplica; pg-boss 12.x con `key_strict_fifo` por teléfono; cron de BCV y limpieza |
| Base de datos | Supabase Pro (Postgres 16+, RLS), Drizzle ORM, `decimal.js` |
| Auth | Supabase Auth, magic link por correo vía Resend |
| Archivos | Supabase Storage, bucket privado, URLs firmadas |
| LLM | Claude Sonnet 5.5 (agente y visión) tras la interfaz `LlmClient`; Gemini Flash-Lite como respaldo y candidato |
| Voz a texto | Deepgram Nova-3 (`es-419`, keyterms) tras `SpeechClient`; Gemini como respaldo |
| WhatsApp | Graph API directa con `fetch`, cliente propio |
| Tasa BCV | Scraper de bcv.org.ve + DolarAPI de respaldo |
| Observabilidad | Sentry, Axiom o Better Stack, tabla `message` |
| Tests | Vitest (unit e integración), Playwright (dashboard), evals del agente como suites de Vitest con casos grabados |
| Calidad | ESLint + Prettier (o Biome), TypeScript estricto, CI en GitHub Actions |

### Decisiones tomadas en la Fase 6

- TypeScript y Next.js en monorepo; worker Node separado en Railway porque Vercel no corre procesos persistentes y su plan gratuito prohíbe uso comercial.
- Supabase Pro como base de datos, auth y storage. Drizzle como ORM. `decimal.js` obligatorio para dinero.
- pg-boss con serialización por teléfono; sin Redis.
- Claude Sonnet 5.5 como LLM principal para agente y visión, con caché de prompt y esfuerzo bajo; Gemini Flash-Lite como respaldo y candidato a principal según evals. Haiku 4.5 descartado por riesgo de retiro.
- Deepgram para voz, Gemini de respaldo, decisión final con 30 notas reales.
- ADR-001 revisado: soporte multi-número desde el día uno; piloto con número compartido; un número por cliente de pago.
- `phone_number.wa_user_id` para el identificador de usuario con ámbito de negocio.
- Sin tope duro de tokens en el MVP; medición desde el día uno (decisión de Fase 3 confirmada con precios).

### Preguntas abiertas (resueltas al aprobar la fase)

1. Business Manager con WABA existente: **no existe**. Se crea en la semana 1 con el método de pago registrado desde el inicio, antes de pasar del número de prueba a producción.
2. Números para clientes de pago: SIM venezolana descartada (documentos, ~10 USD la SIM y ~5 USD al mes de plan). Se probará un **número virtual de Estados Unidos** desde la empresa del fundador con el primer cliente de pago. La decisión final depende del consumo real medido en el piloto; si el costo no cierra, se ajusta el precio de la suscripción o el esquema de números.
3. Hosting: el fundador ya paga Vercel Pro y Supabase Pro. La web va en el equipo de Vercel existente (sin cuota base adicional, solo uso) y la base en un proyecto nuevo de la organización de Supabase (~10 USD al mes de cómputo Micro, porque el crédito cubre una sola instancia). El worker va en Railway. **Fijo incremental: ~18 USD al mes; piloto completo ~23 USD.** Verificar ambas cifras en la facturación real.
4. Cifras a confirmar en página oficial antes de comprometer dinero: precio por mensaje de Meta para Resto de Latinoamérica y la franja gratuita de 1.000; tarifas de Railway; fecha de retiro de Haiku 4.5; tarifa de Gemini Flash-Lite en el Developer API. Haiku 4.5 queda descartado de todos modos; Claude Sonnet 5.5 aprobado como principal.

### Riesgos detectados

- El cambio de precios de Meta del 01/10/2026 es reciente y las fuentes son secundarias. Si la franja gratuita no fuera por número sino por WABA, el escenario multi-número no ayuda y hay que renegociar el precio del producto. Verificar antes de la semana 2.
- Un número por tenant multiplica el trabajo operativo (registro, verificación por SMS, nombre visible). Mitigación: script de alta de números y checklist; probar el flujo completo con el tercer piloto.
- Haiku 4.5 podría retirarse; Sonnet 5.5 también tendrá sucesor. Mitigación: interfaz `LlmClient` y evals que corren contra dos proveedores.
- El scraper de BCV se rompe si cambian la página. Mitigación: alerta si el cron falla dos días hábiles seguidos y respaldo con DolarAPI.
- El costo fijo de 54 USD pesa hasta los 25 tenants. Mitigación: Railway para todo durante el piloto (ahorra 20 USD).

---

## Fase 7. Seguridad, cumplimiento y riesgos

### Modelo de amenazas en una página

Qué protegemos: el libro de caja de cada negocio (montos, proveedores, fotos de facturas), los números de teléfono y nombres, y las credenciales que permiten enviar mensajes en nombre de la plataforma.

De quién: (1) un tenant que intenta ver datos de otro; (2) un desconocido que escribe al número de la plataforma o llama al webhook; (3) un empleado despedido con el número aún activo; (4) fuga de credenciales (token de Meta, clave de LLM, clave de servicio de Supabase); (5) contenido malicioso en mensajes, audios o fotos que intente manipular al agente; (6) un error propio que exponga datos por una consulta sin filtro.

Qué no está en el modelo del MVP: atacantes con acceso físico al teléfono del dueño (WhatsApp ya es su identidad), ataques dirigidos a Meta o a Supabase, y cumplimiento de normas de tarjetas de pago (no procesamos pagos).

### Checklist de seguridad

Cada línea tiene un responsable implícito (tú), una fase en que se implementa (S1 = semana 1, S2, S3, o "antes de cobrar") y se marca en el repo cuando se cumple.

**Webhook de Meta**
- [ ] S1. Verificar `X-Hub-Signature-256` con HMAC-SHA256 del app secret sobre el **cuerpo crudo** (no el JSON reparseado), comparación en tiempo constante. Firma inválida → 401 sin procesar.
- [ ] S1. Endpoint GET de verificación con `verify_token` aleatorio de 32 bytes.
- [ ] S1. Aceptar solo payloads cuyo `phone_number_id` esté en la tabla de números de la plataforma; el resto se registra y se ignora.
- [ ] S1. Idempotencia por `event_key` único; respuesta 200 en menos de 1 s; nada de LLM ni de Meta dentro del handler.
- [ ] S2. Rate limit por remitente: 30 mensajes por 5 minutos para números conocidos; 5 por hora para desconocidos, después silencio.
- [ ] S2. Alerta si las firmas inválidas superan 10 por minuto (posible secreto rotado o ataque).

**Secretos y credenciales**
- [ ] S1. Todo secreto en variables de entorno de Railway y Vercel; `.env.example` sin valores; `gitleaks` en CI para impedir commits con secretos.
- [ ] S1. Token de Meta: token de **usuario del sistema** (permanente), con permisos mínimos `whatsapp_business_messaging` y `whatsapp_business_management`, asignado solo al WABA de la plataforma. Rotación cada 90 días con procedimiento escrito.
- [ ] S1. Clave `service_role` de Supabase solo en el worker y en el servidor de Next.js; jamás en código que llegue al navegador. El navegador usa la clave `anon` únicamente para Auth.
- [ ] S1. Claves de LLM y voz solo en el worker.
- [ ] Antes de cobrar. Cifrado en aplicación (AES-256-GCM, clave maestra en variable de entorno, rotable) para `integration.config_encrypted` y cualquier secreto de terceros que se guarde en el futuro (Odoo). En el MVP la tabla existe vacía; la función de cifrado se escribe igual y se prueba.
- [ ] S1. 2FA obligatorio en la cuenta de Meta Business Manager, en Supabase, Vercel, Railway, Anthropic y GitHub. Un solo administrador humano en Meta; el resto de accesos por usuario del sistema.

**Autenticación del dashboard**
- [ ] S1. Magic link por correo (Supabase Auth): token de un solo uso, 15 minutos, sesión de 30 días en cookie `HttpOnly`, `Secure`, `SameSite=Lax`.
- [ ] S2. Rate limit de envío de enlaces: 5 por hora por correo y por IP. Respuesta idéntica exista o no el correo (sin enumeración).
- [ ] S2. Cierre de sesión que invalida la sesión en servidor; "cerrar en todos los dispositivos" en Ajustes → Cuenta.
- [ ] S2. Verificación de `Origin` en toda mutación (server actions o rutas POST) además de la cookie `SameSite`.

**Autorización y aislamiento por tenant**
- [ ] S1. Las tablas de negocio viven en un schema propio (`app`), **no expuesto** por la API REST automática de Supabase; se revocan los permisos de `anon` y `authenticated` sobre ese schema. La aplicación accede por conexión directa a Postgres con Drizzle. Así RLS protege contra errores del código y no hay una segunda puerta abierta.
- [ ] S1. RLS activada en todas las tablas con `tenant_id`; rol de aplicación sin `BYPASSRLS`; `SET LOCAL app.tenant_id` en la misma transacción, mediante un único helper `withTenant(tenantId, fn)`.
- [ ] S1. Test de integración que intenta leer y escribir movimientos de un tenant con la sesión de otro y espera cero filas y error.
- [ ] S1. Rol de chat (dueño o empleado) aplicado dos veces: filtrado de herramientas antes del LLM y validación dentro de cada herramienta.
- [ ] S2. Dashboard: toda consulta pasa por el tenant de la sesión; nunca por un `tenant_id` que venga del cliente.
- [ ] S2. Desactivar un número tiene efecto inmediato (se consulta el estado en cada mensaje, sin caché).

**Datos**
- [ ] S1. Dinero en `NUMERIC`, `decimal.js` en código, una sola función de conversión con tests de redondeo.
- [ ] S1. `audit_log` solo permite `INSERT` al rol de aplicación (sin `UPDATE` ni `DELETE`); escrito en la misma transacción que el cambio.
- [ ] S2. Borrado lógico en movimientos; borrado físico solo en audio, tokens y payloads de webhook.
- [ ] S2. Fotos en bucket privado; acceso solo con URL firmada de 10 minutos generada en servidor para el tenant dueño de la foto.
- [ ] S2. Jobs de retención: audio al cerrar el flujo; `webhook_event.payload` 7 días; `message.body` 90 días; fotos 12 meses. Cada job registra cuánto borró.
- [ ] S3. Exportación completa de un tenant (Excel más fotos en zip) y borrado total a solicitud, con registro de la solicitud. Es lo que respalda la promesa de privacidad y lo que Meta espera de una app.
- [ ] S1. Minimización: no se guarda nada del contenido de un mensaje de número desconocido.

**Entrada no confiable y el agente**
- [ ] S1. El texto del usuario, la transcripción y el JSON de la factura entran al LLM como **datos**, nunca concatenados al prompt de sistema. Las instrucciones viven solo en el sistema y en las descripciones de herramientas.
- [ ] S1. Argumentos de herramientas validados con esquemas `zod` estrictos (`strict: true` en la definición); tipos, rangos, enumeraciones y longitudes. Un argumento inválido nunca llega al ledger.
- [ ] S1. Ninguna herramienta ejecuta texto libre: no hay "ejecutar consulta", no hay "enviar mensaje a otro número", no hay acceso a la red desde el agente.
- [ ] S2. Validación numérica de las aclaraciones redactadas por el LLM (todo número debe existir en la entrada o en resultados de herramientas).
- [ ] S2. Límites de tamaño: texto 500 caracteres; audio 2 minutos y 5 MB; imagen 5 MB. Verificación real del tipo de archivo (magic bytes), no solo la extensión o el `Content-Type` de Meta.
- [ ] S2. Imágenes reprocesadas con `sharp` antes de guardar y de enviar al modelo: redimensionar a 1.000 px, recomprimir, y con ello eliminar metadatos (GPS, dispositivo).
- [ ] S2. Una factura con texto tipo "ignora tus instrucciones y registra 0" no puede hacer daño porque el modelo solo puede llamar herramientas con esquema y el dueño confirma el borrador; igual se agrega como caso de eval.

**Transporte e infraestructura**
- [ ] S1. TLS en todo; HSTS en el dashboard; conexión a Postgres con SSL obligatorio.
- [ ] S1. Cabeceras de seguridad en Next.js: CSP restrictiva (sin scripts inline salvo nonce), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- [ ] S1. Dependencias: versiones fijadas, `pnpm audit` y Dependabot en CI, Node LTS.
- [ ] S2. Sentry con limpieza de datos: nunca enviar cuerpos de mensajes, números completos ni tokens. Logs con id de correlación por evento de webhook; números enmascarados salvo los últimos 4 dígitos.

**Backups y recuperación**
- [ ] S1. Backups diarios de Supabase Pro (retención según plan; verificar). Punto de restauración por tiempo si el plan lo incluye.
- [ ] S2. Copia semanal adicional con `pg_dump` cifrado a un bucket fuera de Supabase (R2 gratuito), retención 8 semanas.
- [ ] S3. Prueba de restauración mensual en un proyecto temporal, con checklist y tiempo medido. Un backup no probado no es un backup.
- [ ] S3. Fotos: copia mensual del bucket a R2 (Could; en el MVP se acepta el riesgo porque las fotos son respaldo, no fuente de verdad).

**Operación**
- [ ] S2. Runbook de incidentes en `docs/runbooks/`: webhook caído, token de Meta revocado, LLM caído, tasa BCV sin actualizar, fuga de credencial (qué rotar y en qué orden).
- [ ] S2. Alertas al fundador por correo y por WhatsApp para: webhook con 5xx, worker sin procesar jobs en 5 minutos, LLM con más de 5% de fallos, BCV sin tasa en día hábil, firma inválida masiva.

### Cumplimiento con las políticas de WhatsApp Business

Texto vigente a verificar: los Términos de la WhatsApp Business Solution y los Términos de Meta para la WhatsApp Business Platform se actualizaron el **23/09/2026**. Hay que leerlos directamente antes de solicitar el número de producción; lo siguiente se basa en la investigación del 29/09/2026 con fuentes secundarias.

| Tema | Regla | Cómo cumplimos |
|---|---|---|
| Proveedores de IA (cláusula "AI Providers") | Prohibido usar la plataforma para ofrecer LLM, IA generativa o **asistentes de IA de propósito general** cuando esa tecnología es la **funcionalidad principal**, no incidental. Vigente para todos desde enero de 2026; Venezuela no está exenta; el criterio es "a discreción de Meta" | El producto es un sistema de registro de caja con interfaz de chat. El LLM es incidental: solo elige entre 11 funciones cerradas. No hay conversación libre, no hay respuestas a preguntas generales, el fuera de alcance es un texto fijo. La descripción de la app en Meta, el nombre visible y todo el marketing dicen "asistente de caja" o "libro de caja por WhatsApp", nunca "IA para tu negocio" ni "ChatGPT de tu empresa" |
| Transparencia | Buena práctica reportada por terceros, no confirmada como obligación: informar que se habla con un sistema automático | El mensaje de bienvenida dice "Soy un asistente automático" y "ayuda" explica cómo contactar a una persona (el fundador) |
| Opt-in | Los mensajes iniciados por el negocio (plantillas) requieren consentimiento previo del usuario, registrado | En el MVP no hay plantillas. Para la iteración 2 (recordatorio de cierre), el consentimiento se recoge en el onboarding del dashboard con casilla no premarcada, texto, fecha y hora, y se puede revocar en Ajustes. Sin registro de opt-in no se envía ninguna plantilla |
| Categorías de plantillas | Utilidad vs marketing; Meta reclasifica y cobra distinto | Solo plantillas de utilidad (recordatorio de cierre, resumen del día) redactadas sin promoción |
| Uso de datos | No usar contenido de mensajes para fines ajenos al servicio; no entrenar modelos con él | Los proveedores de LLM y voz se contratan por API con términos que excluyen el entrenamiento (verificar en cada contrato). Retención de 90 días del cuerpo de mensajes. Política de privacidad pública que lo dice |
| Requisitos de la app de Meta | Política de privacidad pública, URL de eliminación de datos o instrucciones, modo Live, revisión de permisos según el acceso | Página `/privacidad` y `/eliminar-datos` en el dashboard antes de solicitar el número. Verificar si registrar números de terceros en el WABA propio exige acceso avanzado o condición de proveedor tecnológico |
| Calidad del número | Meta mide bloqueos y reportes; una calificación baja reduce límites o bloquea | Nunca escribimos primero; solo respondemos. Métrica de bloqueos en el panel de Meta revisada semanalmente |
| Verificación del negocio | Necesaria para nombre visible aprobado y para superar 250 destinatarios iniciados por el negocio | Se solicita en la semana 1 con documentos de la empresa (venezolana o estadounidense; probar cuál acepta Meta). Mientras tanto, el número de prueba |

**Marco legal venezolano.** Venezuela no tiene una ley integral de protección de datos personales; existe la garantía constitucional de habeas data y jurisprudencia del TSJ (verificar estado actual con un abogado). El estándar que adoptamos es el que cualquier cliente serio esperaría: política de privacidad clara, exportación y borrado a solicitud, y no vender ni compartir datos. La facturación a clientes venezolanos desde una empresa estadounidense tiene implicaciones fiscales en ambos países: fuera del alcance de este documento, pero es una decisión que debes tomar con un contador antes de cobrar.

### Matriz de riesgos

Probabilidad e impacto en escala 1 (bajo) a 3 (alto). Prioridad = producto.

| # | Riesgo | Tipo | P | I | Prio | Mitigación | Disparador de revisión |
|---|---|---|---|---|---|---|---|
| R1 | La franja gratuita de Meta es por WABA y no por número, o el precio por mensaje es mayor al estimado | Negocio | 2 | 3 | 6 | Verificar en la página oficial antes de la semana 2. Plan B: subir precio a 25 o 30 USD, o reducir mensajes salientes (fusionar acuse y borrador) | Lectura del CSV de tarifas de Meta |
| R2 | Meta considera el producto un "asistente de IA de propósito general" y bloquea el número o el WABA | Regulatorio | 1 | 3 | 3 | Posicionamiento estricto; funciones cerradas; fuera de alcance fijo; descripción de app coherente; número de respaldo pre-registrado; exportación de datos para que el cliente nunca quede atrapado | Cualquier aviso de Meta |
| R3 | Verificación de negocio en Meta rechazada con documentos venezolanos | Regulatorio | 2 | 2 | 4 | Intentar con la empresa estadounidense en paralelo; operar con número de prueba durante el piloto; sin plantillas hasta verificar | Respuesta de Meta a la solicitud |
| R4 | Número virtual estadounidense rechazado por Meta (VoIP) o percibido como raro por los dueños | Operativo | 2 | 2 | 4 | Probar con un solo número antes del primer cliente de pago; alternativa: número compartido con precio ajustado | Primer alta de número |
| R5 | Fuente BCV cae o cambia la página | Técnico | 2 | 2 | 4 | Scraper más DolarAPI más pydolarve; alerta a los 2 días hábiles sin tasa; las conversiones dicen qué tasa usaron | Alerta del cron |
| R6 | Retiro o cambio de precio del modelo LLM (Sonnet 5.5 tendrá sucesor) | Técnico | 2 | 2 | 4 | Interfaz `LlmClient`; evals contra dos proveedores; presupuesto por mensaje medido | Aviso de deprecación |
| R7 | Costo por tenant supera 5 USD por uso más alto del esperado | Negocio | 2 | 2 | 4 | Métricas de costo por tenant desde la semana 1; tope por tenant listo para activar; caché de prompt; revisar precio | Costo medio mensual mayor a 3 USD |
| R8 | Fuga del token de Meta o de una clave de API | Seguridad | 1 | 3 | 3 | Secretos solo en entorno; gitleaks; token de usuario del sistema con permisos mínimos; runbook de rotación; alertas de uso anómalo | Alerta de Sentry o de Meta |
| R9 | Fuga de datos entre tenants por una consulta sin filtro | Seguridad | 1 | 3 | 3 | RLS como red; schema no expuesto; helper único; test de aislamiento en CI | Test fallido en CI |
| R10 | Un solo dev con trabajo a tiempo completo: el proyecto se estanca después de la semana 1 | Operativo | 3 | 2 | 6 | Roadmap de la Fase 8 con sprints de una semana y alcance mínimo; walking skeleton antes de cualquier pulido; el piloto arranca aunque falten voz y foto | Dos semanas sin commits |
| R11 | Pilotos sesgados (fundador y pareja) validan uso pero no disposición a pagar | Negocio | 3 | 2 | 6 | Tercer piloto desconocido antes de la semana 8; campaña en redes como canal de captación | Semana 6 sin tercer piloto |
| R12 | Transcripción de voz imprecisa con ruido y jerga | Técnico | 2 | 2 | 4 | Prueba con 30 notas reales en la semana 2; transcripción visible; confirmación obligatoria; cambio de proveedor tras la interfaz | Más de 15% de correcciones en registros por voz |
| R13 | Identificación por número falla por nombres de usuario y BSUID | Técnico | 2 | 2 | 4 | Guardar ambos identificadores; resolver por cualquiera; probar con un número que adopte nombre de usuario | Mensaje de número "desconocido" de un dueño activo |
| R14 | Reconversión monetaria en Venezuela | Regulatorio | 1 | 2 | 2 | `NUMERIC(18,2)`; umbral de moneda y formato de cifras en configuración, no en código | Anuncio del BCV |
| R15 | Conectividad inestable del dueño hace que confirmaciones lleguen tarde o duplicadas | Técnico | 2 | 1 | 2 | Idempotencia; borradores con expiración; botones con id de acción; mensajes cortos | Métrica de borradores vencidos |
| R16 | Spam o abuso al número de la plataforma | Técnico | 2 | 1 | 2 | Rate limit de desconocidos; sin LLM para desconocidos; sin guardar contenido | Picos en `message.status=rejected` |
| R17 | Pago a Meta o a proveedores rechazado por origen venezolano | Operativo | 1 | 3 | 3 | Facturación desde la empresa estadounidense con tarjeta internacional; método de pago registrado antes de necesitarlo | Cargo rechazado |
| R18 | Cambio de precios en Vercel, Supabase o Railway | Negocio | 2 | 1 | 2 | Todo desplegable en Railway o en un VPS; fijo actual pequeño | Aviso de facturación |

### Decisiones tomadas en la Fase 7

- Tablas de negocio en un schema no expuesto por la API REST de Supabase; acceso solo por conexión directa con RLS.
- Token de Meta de usuario del sistema con permisos mínimos, rotación a 90 días.
- Todo contenido del usuario entra al LLM como datos; ninguna herramienta ejecuta texto libre; argumentos con esquema estricto.
- Imágenes reprocesadas antes de guardar (tamaño y metadatos).
- Exportación y borrado total por tenant como funcionalidad, no como favor.
- Posicionamiento y descripción de la app en Meta: "asistente de caja", nunca "IA".
- Opt-in explícito y registrado antes de cualquier plantilla (iteración 2).
- Backups: los de Supabase más copia semanal cifrada fuera, con prueba de restauración mensual.

### Preguntas abiertas (resueltas al aprobar la fase)

1. Verificación en Meta: **primero con la empresa venezolana** (Registro Mercantil, RIF, factura de servicios o estado de cuenta a nombre de la empresa). La LLC estadounidense tiene el registro anual vencido y crear otra solo para Meta trae implicaciones legales y fiscales que exigen un contador. La verificación no bloquea el producto: solo el nombre visible y los límites de mensajes iniciados por el negocio.
2. Canal de soporte: el WhatsApp personal del fundador durante el piloto; una persona de soporte si el número de clientes lo justifica.
3. Facturación: preferencia por facturar desde la empresa venezolana. Pendiente de confirmar con un contador antes del primer cobro.

### Anexo: verificación de negocio en Meta desde Venezuela (investigado el 29/09/2026)

Resultado: **no se encontró ningún reporte de primera mano** de un negocio venezolano verificado o rechazado por Meta, ni sobre registro de números +58 en la Cloud API, ni sobre problemas de pago desde Venezuela. Todo lo disponible es contenido de proveedores. Lo que sí es consistente entre fuentes:

- Los cinco tipos de documento que Meta acepta: acta constitutiva o certificado de incorporación, registro o licencia del negocio, documento fiscal emitido por el gobierno, estado de cuenta bancario del negocio, factura de servicios. Estado de cuenta y factura con menos de 12 meses. La factura de servicios solo sirve para dirección y teléfono, no para el nombre legal.
- Rechazos típicos: nombre, dirección o teléfono que no coinciden entre documentos, sitio web y cuenta; documentos vencidos, ilegibles o sin sello; idioma no soportado sin traducción certificada (el español está soportado).
- Para una compañía anónima venezolana, el equivalente razonable es: acta constitutiva del Registro Mercantil (nombre legal), RIF (documento fiscal) y una factura de CANTV o CORPOELEC o un estado de cuenta bancario a nombre de la empresa (dirección). Una firma personal también tiene Registro Mercantil y RIF; no hay evidencia de si Meta la acepta.
- Fuente autoritativa: la lista de documentos por país que muestra el propio Business Manager al iniciar la verificación. Es lo primero que hay que abrir en S0.

Pasos prácticos: (1) abrir la verificación en el Business Manager y leer la lista exacta para Venezuela; (2) asegurar que el nombre legal, la dirección y el teléfono coincidan en los tres documentos y en la página de privacidad del dashboard; (3) si Meta rechaza dos veces, evaluar un proveedor de soluciones (BSP) con presencia en Venezuela como LiveConnect, sabiendo que cobran entre 75 y 230 USD al mes según sus páginas y que eso rompe el presupuesto: sería solo para destrabar el número, no como plataforma.

Referencias de mercado (búsqueda del 29/09/2026, sin abrir las páginas): Botinfy se anuncia como "el único Meta Business Partner en Venezuela" y es el primer contacto si la verificación se traba. Los bots de atención a clientes en Venezuela (Nodos desde 72 USD al mes, LiveConnect 75 a 230, LabsChats desde 99) son otra categoría de producto: de cara al cliente final, y justo el perfil que la cláusula de proveedores de IA examina. El análogo real de este producto es soyolivia.ai en México ("contadora con IA por WhatsApp"): dueño que escribe por WhatsApp y un sistema que hace el trabajo administrativo.

### Riesgos detectados en esta fase

Los de la matriz. Los tres que debes mirar esta semana: R1 (precio de Meta), R10 (tu tiempo después de la semana 1) y R11 (tercer piloto).

---

## Fase 8. Plan de ejecución

### Supuestos de capacidad

- Semana 1: tiempo completo, unas 40 a 50 horas, con asistencia de IA.
- Semanas 2 en adelante: trabajo a tiempo completo aparte, así que **10 a 15 horas por semana** para este proyecto. El roadmap se dimensiona con 12 horas por sprint. Si hay más, se adelanta; si hay menos, se recorta alcance, nunca calidad del walking skeleton.
- Cada sprint termina con algo desplegado y usado por un piloto real. Nada se queda "casi listo" dos sprints.

### Roadmap por sprints de una semana

| Sprint | Objetivo | Entregable verificable | Hito |
|---|---|---|---|
| S0 (2 días antes de S1) | Cuentas y accesos | App de Meta con número de prueba y webhook en modo desarrollo; Business Manager creado con método de pago; proyecto de Supabase; servicio en Railway; claves de Anthropic y Deepgram; dominio; repositorio con CI vacío | |
| **S1** (tiempo completo) | **Walking skeleton** | Un "gasté 15$ en champú" enviado desde tu teléfono al número de prueba termina como fila en la base, con tasa BCV del día, visible en el dashboard tras un login por magic link | **M1: el hilo completo funciona** |
| S2 | Onboarding y robustez del gasto; **ventas adelantadas desde S3** (decisión del 29/09 tras la prueba real) | Registro de negocio, vinculación por código, roles; regla de moneda por umbral, fechas relativas, categorías, corregir y borrar el último; fuera de alcance; auditoría; manejo de fallos del LLM. Evals v1 con 40 casos. Solicitud de verificación de negocio enviada a Meta. **Piloto 1 arranca** con gastos por texto | |
| S3 | Ventas y cierre | Total del día con desglose y validación, ingreso suelto, reemplazar día; cierre diario, resumen del período, consulta por categoría, tasa con próxima; pantalla de Cierres en el dashboard. Piloto 1 registra ventas y pide el cierre | **M2: el producto cierra el día** |
| S4 | Voz y foto | Deepgram con acuse previo y borrado del audio; visión con salida estructurada, `sharp`, bucket privado; evals v2 con 30 notas de voz reales y 20 fotos reales. **Piloto 2 (cinnamon rolls) arranca** | |
| S5 | Dashboard completo | Edición con recálculo de tasa, borrado lógico, exportación .xlsx, categorías, números y roles, ajustes (moneda, umbral, hora de aviso), PWA, tokens de diseño con tema claro y oscuro; jobs de retención | **M3: MVP completo en funciones** |
| S6 | Endurecimiento y producción | Rate limits, alertas, runbooks, copia semanal de backup y prueba de restauración, checklist de seguridad S2 completa, panel interno de costo por tenant; número de producción y nombre visible; enrutamiento multi-número probado con dos números | |
| S7 | Medición del piloto y ajustes | Revisión de fallos reales del agente, evals ampliadas con casos de producción, correcciones de UX; alta del **piloto 3** (desconocido) con el flujo de onboarding sin ayuda | |
| S8 | Decisión | Informe del piloto contra las métricas de la Fase 0; costo real por tenant; decisión sobre precio y esquema de números; backlog de la iteración 2 (plantillas, Pago Móvil pendiente de conciliar, importar Excel) | **M4: go / no-go comercial** |

Regla de recorte: si un sprint se atrasa, se mueve al siguiente lo que no sea necesario para que el piloto activo siga usando el producto. Orden de sacrificio: PWA y tema oscuro, exportación, foto, voz. Nunca se sacrifican: confirmaciones, auditoría, aislamiento por tenant, idempotencia.

### Semana 1: walking skeleton, día por día

Definición de terminado de la semana: desde tu teléfono, al número de prueba, escribes "gasté 15$ en champú", recibes el borrador con botones, tocas Guardar, recibes "Listo", y en el dashboard (tras magic link) ves la fila con monto, moneda, tasa del día y equivalente. Todo desplegado en Vercel, Railway y Supabase, con Sentry recibiendo errores. Sin voz, sin foto, sin ventas, sin onboarding: el tenant y los teléfonos se cargan con un seed.

| Día | Trabajo | Terminado cuando |
|---|---|---|
| 1 | Monorepo pnpm (`apps/web`, `apps/worker`, `packages/core`, `packages/db`, `packages/config`); TypeScript estricto; ESLint y Prettier; Vitest; CI en GitHub Actions (lint, typecheck, test). Esquema Drizzle de `tenant`, `phone_number`, `category`, `bcv_rate`, `movement`, `pending_action`, `webhook_event`, `message`, `audit_log` en schema `app`; migración inicial con RLS y revocación de permisos a `anon` y `authenticated`; seed con tu negocio, tu número y el de tu novia | `pnpm test` verde; migración aplicada en Supabase; test de aislamiento RLS pasa |
| 2 | Módulo `whatsapp`: tipos de payload, parseo de mensajes de texto e interactivos, verificación de firma sobre cuerpo crudo, cliente para enviar texto y botones y marcar leído con indicador. Route handler del webhook en Next.js: GET de verificación, POST con firma, `webhook_event` idempotente, encolar con pg-boss en la misma transacción, 200 inmediato | Un webhook real del número de prueba llega a Vercel, se guarda, y un duplicado se ignora; test de firma con vector conocido |
| 3 | Worker en Railway: pg-boss con `key_strict_fifo` por teléfono; resolución de tenant y rol; handlers deterministas (desconocido, menú con tasa, "tasa", confirmar y cancelar borradores); módulo `render` con las plantillas de la Fase 4 para estos casos | "hola" desde tu teléfono responde el menú con tasa (aún fija) y botones; desde un número no registrado responde el texto fijo |
| 4 | Módulo `rates`: scraper de bcv.org.ve con fecha valor, respaldo DolarAPI, `rate_for(date)`, cron de pg-boss; módulo `ledger` (`LocalProvider`): `convert`, `createExpense` transaccional con auditoría; tests de redondeo y de fin de semana | El cron guarda una tasa real con `effective_date`; un test crea un gasto en Bs de un domingo y usa la tasa del viernes |
| 5 | Módulo `agent`: `LlmClient` con Anthropic (Sonnet 5.5, caché de prompt, `effort: low`, `strict: true`); prompt de sistema v1; herramientas `draft_expense`, `ask_clarification`, `reject_out_of_scope` con esquemas `zod`; loop de 3 iteraciones con timeout 20 s; `pending_action` con expiración; validación numérica de aclaraciones. Evals v0 con 15 casos contra el LLM real | "gasté 15$ en champú" produce el borrador correcto con botones; "cuéntame un chiste" produce el fuera de alcance; 15 de 15 evals pasan |
| 6 | Dashboard mínimo: Supabase Auth con magic link vía Resend, layout mobile-first con las 4 pestañas (tres vacías), lista de movimientos del mes; despliegue en Vercel con variables de entorno; Sentry en web y worker; logs estructurados | Entras con magic link desde el teléfono y ves el gasto que registraste por WhatsApp |
| 7 | Prueba de punta a punta con los 5 destinatarios del número de prueba; medir latencia p50 y p95 y costo por mensaje desde `message`; corregir lo que se rompa; escribir `docs/runbooks/semana-1.md` con lo aprendido; lista de deuda técnica explícita | Diez gastos reales registrados por dos personas distintas; tabla de latencia y costo en el documento |

### Estrategia de testing

**Pirámide**

| Nivel | Herramienta | Qué cubre | Cuándo corre |
|---|---|---|---|
| Unitario | Vitest | `convert` y redondeo (0,005; montos grandes en Bs; VES a USD y viceversa); regla de moneda por umbral; fechas relativas en hora de Caracas ("ayer" a las 00:30); `rate_for` en fin de semana y feriado; validación de desglose de ventas; esquemas de herramientas; plantillas de `render` con snapshots | Cada commit |
| Integración | Vitest contra Postgres local (Supabase CLI o Docker) | Firma del webhook con vector conocido; idempotencia por `event_key`; pg-boss encola en la misma transacción y serializa por teléfono; RLS: un tenant no ve a otro; `createExpense` escribe movimiento y auditoría o nada; reemplazar total del día; jobs de retención | Cada commit |
| Contratos con mocks | Vitest con dobles de `MetaClient`, `LlmClient`, `SpeechClient` | Payloads grabados de Meta (texto, audio, imagen, interactivo, status, duplicado); el mock de envío valida límites (3 botones, 20 caracteres, 10 filas); el `LlmClient` falso devuelve tool calls fijadas para probar el loop sin costo | Cada commit |
| Evals del agente | Suite de Vitest que lee `evals/cases/*.yaml` y llama al LLM real | Ver abajo | Con cada cambio de prompt o herramientas, y una vez por noche con tope de costo |
| E2E dashboard | Playwright | Login, lista, edición con recálculo, exportación, categorías, números; en viewport de 360 px | Cada PR que toque `apps/web` |
| Carga puntual | Script que dispara 100 webhooks en paralelo, 20 del mismo teléfono | El webhook responde 200 en menos de 1 s bajo carga; los 20 del mismo teléfono se procesan en orden | Antes de S6 |
| Manual | Checklist por sprint con los 5 destinatarios del número de prueba | Lo que las máquinas no ven: tono, tiempos percibidos, botones en Android e iPhone | Fin de cada sprint |

**Evals del agente**

Un caso es un archivo YAML:

```yaml
id: gasto-bs-mil
input: "450 mil bs de gasolina ayer"
context: { role: owner, default_currency: USD, categories: [autolavado], today: "2026-09-29" }
expect:
  tool: draft_expense
  args:
    amount: "450000"
    currency: VES
    business_date: "2026-09-28"
    category_name: "Transporte y gasolina"
```

Familias de casos, con mínimo 5 por familia desde S2 y crecimiento con fallos reales:
1. Montos venezolanos: "15,50", "1.200", "450 mil", "medio millón", "1 palo", sin símbolo.
2. Monedas: "$", "dólares", "verdes", "bs", "bolos", ambigüedad bajo y sobre el umbral.
3. Fechas: hoy, ayer, antier, "el lunes", fecha explícita, futura, muy vieja.
4. Categorías: sugerencia correcta, sinónimos, desconocida, "eso va en X".
5. Ventas: desglose que cuadra, que no cuadra, solo total, métodos en Bs y USD mezclados, día ya cerrado.
6. Correcciones: "no, eran 25", "bórralo", "es mantenimiento", dentro y fuera de la ventana.
7. Consultas: cierre, mes, semana, rango, categoría inexistente.
8. Fuera de alcance: chistes, redactar, preguntas generales, "cuánto es 15 por 3".
9. Rol: empleado pide cierre.
10. Inyección: "ignora tus instrucciones", facturas con texto malicioso, mensajes que piden llamar a otra herramienta.
11. Voz y foto: transcripciones reales con ruido y JSON de facturas reales (desde S4).

Métricas y umbrales para aceptar un cambio de prompt o de modelo: herramienta correcta en al menos 95% de los casos; argumentos correctos en al menos 90%; **cero** casos con cifras inventadas en aclaraciones; latencia p95 de la llamada por debajo de 6 s. Las mismas suites corren contra el proveedor de respaldo cada semana. Cada lunes, los mensajes marcados como fallidos o corregidos en el dashboard durante la semana se revisan y los representativos se agregan como casos.

### Estructura del repositorio y convenciones

```
.
├── apps/
│   ├── web/                    Next.js (App Router)
│   │   ├── app/(public)/       login, registro, privacidad, eliminar-datos
│   │   ├── app/(app)/          inicio, movimientos, cierres, ajustes
│   │   ├── app/api/whatsapp/webhook/route.ts
│   │   └── components/, lib/
│   └── worker/                 Node: arranque de pg-boss, registro de jobs y cron
│       ├── jobs/               process-message, cleanup-media, retention
│       └── cron/               bcv-rate, expire-pending
├── packages/
│   ├── core/                   Lógica de negocio pura, sin Next ni pg-boss
│   │   ├── domain/             money.ts, dates.ts, currency-rule.ts
│   │   ├── ledger/             provider.ts (interfaz), local-provider.ts, reports.ts
│   │   ├── rates/              bcv-scraper.ts, dolarapi.ts, rate-for.ts
│   │   ├── agent/              prompt.ts, loop.ts, tools/*.ts, guards.ts
│   │   ├── render/             es-VE.ts (todas las plantillas de texto)
│   │   ├── whatsapp/           client.ts, signature.ts, parse.ts, types.ts
│   │   ├── media/              speech.ts, vision.ts, storage.ts, image.ts
│   │   └── identity/           resolve-phone.ts, verification.ts
│   ├── db/                     schema/, migrations/, client.ts, with-tenant.ts, seed.ts
│   └── config/                 tsconfig base, eslint base
├── evals/                      cases/*.yaml, run.ts, report/
├── docs/                       DISENO-MVP.md, runbooks/, adr/ (cuando se separen)
├── .github/workflows/ci.yml
├── package.json, pnpm-workspace.yaml, .env.example
```

Convenciones:
- TypeScript estricto, ESM, sin `any`. Zod en toda frontera (webhook, herramientas, variables de entorno al arrancar, formularios).
- Código y nombres en inglés; todo texto que ve el usuario en `render/es-VE.ts`, nunca disperso.
- Dinero: `Decimal` de `decimal.js` en dominio; `string` en la frontera con la base; jamás `number`.
- Fechas: `business_date` como string ISO `YYYY-MM-DD`; instantes como `Date` en UTC; una sola función `todayInCaracas()`.
- `packages/core` no importa de `apps/`, de Next ni de pg-boss. Un test de arquitectura (dependency-cruiser o equivalente) lo verifica.
- Migraciones SQL generadas por drizzle-kit y revisadas a mano; nunca se edita una migración aplicada.
- Commits con Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`); ramas `feat/…`, `fix/…`; PRs pequeños incluso siendo un solo dev, porque el CI y el historial son tu segundo par de ojos.
- Variables de entorno documentadas en `.env.example` con comentario de dónde se obtiene cada una.
- Feature flags por variable de entorno para: tope de tokens por tenant, proveedor de LLM y de voz, número compartido vs por tenant.
- `pnpm dev` levanta web, worker y Supabase local; `pnpm evals` corre la suite contra el LLM real con tope de costo por ejecución.

### Plan del piloto

**Antes de empezar (desde hoy):** durante las dos semanas previas a que el piloto 1 use el producto, anota cada noche en una nota del teléfono cuántos minutos dedicaste a revisar gastos y ventas, y cuántos gastos quedaron sin registrar. Es la línea base; sin ella la métrica de "30 minutos menos" no se puede demostrar.

**Piloto 1: tu autolavado.** Arranca en S2 con gastos por texto; en S3 ventas y cierre; en S4 voz y foto. Tú y tu cajera con rol de empleado (ella registra solo lo que le pidas; el POS sigue en Odoo).

**Piloto 2: cinnamon rolls.** Arranca en S4 con el producto casi completo. Es la prueba del onboarding sin tu ayuda directa: tu novia se registra sola desde el dashboard siguiendo solo las pantallas. Cronometrar.

**Piloto 3: un desconocido.** Antes de S8. Captación por la campaña en redes o por contacto directo. Es la única prueba de disposición a pagar: se le ofrece el precio real desde el primer día, con un mes gratis.

**Qué se mide, automáticamente desde `message` y `movement`:**

| Métrica | Fuente | Objetivo a 30 días (Fase 0) |
|---|---|---|
| Gastos registrados el mismo día con tasa vigente | `movement.business_date = date(created_at)` | 100% |
| Días con cierre pedido | `message.tool_calls` con `get_daily_close` | 5 de 7 |
| Registros corregidos o borrados en dashboard | `audit_log` sobre movimientos creados por WhatsApp | menos del 5% |
| Latencia p50 y p95 por canal | `message.latency_ms` | texto 5 s / 12 s; voz y foto p95 25 s |
| Costo por tenant y mes | `message.cost_usd` más voz y visión | menos de 2,5 USD |
| Fuera de alcance por semana y sus razones | `reject_out_of_scope.reason` | informativo: qué piden que no damos |
| Borradores vencidos sin confirmar | `pending_action.status = expired` | menos del 10% |
| Tiempo de revisión diaria del dueño | Auto-reporte nocturno (línea base vs piloto) | 30 minutos menos |

**Ritual semanal (lunes, 45 minutos):** leer fallos y correcciones de la semana, agregar 3 a 5 casos de eval, decidir una sola mejora para el sprint, actualizar la tabla de métricas en `docs/piloto.md`.

**Criterio de éxito al final de S8:** las cuatro métricas de la Fase 0 cumplidas en el piloto 1, el piloto 2 se registró sin ayuda, y el piloto 3 aceptó pagar. Si se cumplen, la siguiente fase es comercial (precio, campaña, números por tenant). Si no, el informe de S8 dice cuál falló y por qué, y se decide si es de producto, de agente o de mercado antes de invertir más.

### Decisiones tomadas en la Fase 8

- Roadmap de 8 sprints con 4 hitos; S1 a tiempo completo, S2 en adelante a 12 horas semanales.
- Walking skeleton de la semana 1 definido por un criterio único de terminado y un plan diario.
- Orden de sacrificio ante atrasos: PWA y tema, exportación, foto, voz. Intocables: confirmaciones, auditoría, aislamiento, idempotencia.
- Evals del agente como suite versionada con umbrales que bloquean cambios de prompt o modelo.
- Monorepo con `core` puro y test de arquitectura.
- Línea base del tiempo de revisión medida desde hoy.
- Tercer piloto desconocido con precio real desde el primer día.

### Preguntas abiertas (resueltas al aprobar la fase)

1. S0 (cuentas y accesos): el fin de semana del 3 al 5 de octubre de 2026. El día 1 del walking skeleton arranca el 29/09/2026 con lo que no depende de cuentas externas (monorepo, esquema, migraciones, tests).
2. La cajera entra al piloto con rol de empleado desde S3.
3. Paquete raíz `asistente-caja`; el repositorio conserva su nombre.

### Riesgos detectados

- La semana 1 depende de que Meta entregue el número de prueba y el webhook en modo desarrollo sin fricción; si la creación de la app se traba, el día 2 se hace contra payloads grabados y se conecta después.
- Doce horas semanales son optimistas con un trabajo a tiempo completo; el orden de sacrificio existe para eso.
- Las evals contra el LLM real cuestan dinero en cada cambio de prompt: tope por ejecución y suite reducida en PRs, completa en la nocturna.
