# Documento de Diseño del MVP

Asistente de caja por WhatsApp para pymes venezolanas.

Documento acumulativo. Cada fase agrega una sección al cerrarse.

| Fase | Estado |
|---|---|
| 0. Descubrimiento (Product Brief) | Entregado, pendiente de aprobación |
| 1. Requerimientos | Pendiente |
| 2. Modelo de dominio y datos | Pendiente |
| 3. Arquitectura | Pendiente |
| 4. UX conversacional | Pendiente |
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
