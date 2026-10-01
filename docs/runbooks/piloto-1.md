# Runbook · Piloto 1 (tu autolavado, 30 días)

Objetivo: usar el asistente todos los días con caja real, con dos personas (tú como dueño y tu
cajera como empleada), y salir con las cuatro métricas de la Fase 0 medidas. No es una demo: lo
que no funcione se anota y entra como caso de eval o como bug.

## 1. Antes del día 1 (una tarde)

- [ ] Meta → número de prueba → lista de destinatarios: tu número ya está; agrega el de la cajera.
      Sin eso Meta rechaza las respuestas (código 131030) y el bot parece mudo.
- [ ] Dashboard → Ajustes → Números → agregar a la cajera como empleada con su nombre. Su primer
      "hola" la activa y le llega la bienvenida.
- [ ] Meta → Business Manager → solicitar la verificación del negocio (tarda días; no bloquea el
      piloto con el número de prueba, pero sí la salida a un número real).
- [ ] Mide el "antes": durante 3 días, cuánto tiempo te toma al cierre pasar la caja a Excel u
      Odoo. Anótalo aquí: ____ minutos por día. Sin este número no se puede medir la cuarta
      métrica.
- [ ] Guarda el enlace del dashboard en la pantalla de inicio del teléfono (Añadir a inicio): abre
      como app, sin barra del navegador.
- [ ] Confirma en Sentry que el evento de prueba del navegador llegó (runbook s2-monitoreo, §3).

## 2. Guion para la cajera (mándaselo por WhatsApp)

1. Guarda el número del asistente como "Caja".
2. Cada gasto que pagues del dinero del negocio, escríbelo como lo dirías: "gasté 15$ en champú",
   "pagué 450 mil de hielo". Si prefieres, nota de voz. Toca **Guardar** cuando el borrador esté
   bien, **Corregir** si no.
3. Si pagaste con factura, mándale la foto: él la lee y te muestra el borrador.
4. Las ventas y los cierres son del dueño; a ti te dirá que no puede.
5. Si no entiende algo, dímelo a mí con una captura. Eso es lo que estamos probando.

## 3. Rutina del dueño

**Durante el día**: registra tus gastos igual que la cajera. Al cerrar: "hoy vendí 350$: 200
efectivo, 100 pago móvil, 50 punto" y Guardar; luego "cierre". Compara el efectivo en caja que
dice el bot con el conteo real y anota si cuadra.

**Cada noche (2 minutos)**: en el dashboard, Movimientos → ¿hay algo mal registrado? Corrígelo
ahí. Cada corrección cuenta para la métrica de "mensajes mal entendidos".

**Cada mañana (3 minutos)**:
1. Sentry → Issues de los dos proyectos. Un issue nuevo es un bug: cópialo en la bitácora.
2. Railway → logs: debe haber "tasa actualizada" de la tarde anterior.
3. Better Stack sin incidentes.

**Cada domingo (15 minutos)**: `pnpm metrics 7` y llena la tabla de la §5. Repasa la lista de
fallos de la §4 y conviértelos en casos de eval.

## 4. Fallos: cómo anotarlos para que sirvan

Un fallo es cualquier respuesta distinta de la esperada: monto o moneda equivocados, categoría
absurda, una pregunta cuando no hacía falta, un "fuera de alcance" a algo de caja, una nota de
voz mal transcrita, una factura mal leída. Anota tres cosas: **lo que se escribió o dijo**, **lo
que respondió** y **lo que debía hacer**. Con eso se escribe un caso en `evals/cases/*.yaml`:

```yaml
- name: lo que falló, en una línea
  input: "lo que se escribió, literal"      # o kind: voice con la transcripción
  expect:
    tool: draft_expense
    args: { amount: "15", currency: USD }
```

Si fue una respuesta a un botón, va con `history` (lo anterior y la pregunta del bot). Si fue una
foto, va con `receipt` y lo que se leyó. Las evals corren con `pnpm evals` desde tu máquina, con
`ANTHROPIC_API_KEY` en el `.env`; cuestan menos de 0,50 USD por corrida.

## 5. Tabla semanal

| Métrica | Sem 1 | Sem 2 | Sem 3 | Sem 4 | Meta |
|---|---|---|---|---|---|
| Gastos del día registrados el mismo día (%) | | | | | 100 % |
| Días con cierre pedido (de 7) | | | | | ≥ 5 |
| Cierres que cuadran con el conteo de caja (de los pedidos) | | | | | todos |
| Minutos de revisión diaria (antes: ___) | | | | | −30 min |
| Mensajes mal entendidos / total (%) | | | | | < 5 % |
| Latencia p50 / p95 del agente | | | | | ≤ 4 s / ≤ 8 s |
| Costo LLM por turno (USD) | | | | | ≤ 0,01 |
| Mensajes de servicio del mes (cupo 1.000) | | | | | proyección < 1.000 |
| Issues nuevos en Sentry | | | | | 0 repetidos |

## 6. Cuándo parar y arreglar antes de seguir

- El bot deja de responder a alguien más de 10 minutos (revisa el runbook semana-1 §6: cola FIFO).
- Un gasto se guarda con un monto distinto al confirmado. Eso es un bug de contabilidad, no de
  comprensión: se arregla el mismo día.
- La tasa lleva dos días sin actualizarse.
- Sentry muestra el mismo error tres veces.

Todo lo demás sigue: se anota y se corrige en la revisión semanal.

## 7. Al cierre de los 30 días

Con las cuatro tablas llenas, se escribe el informe de la S8 (`docs/`): métrica por métrica contra
la meta, costo real por tenant, lista de fallos por tipo, y la decisión de ir o no con un segundo
negocio que no sea de la familia.
