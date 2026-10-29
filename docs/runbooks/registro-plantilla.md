# Runbook · Plantilla de registro pendiente: cómo correr el lote

Una sola corrida en la vida del producto (decisión 3B, aprobación A-0031): hasta 30 envíos de la
plantilla `rocco_registro_pendiente` a registros por WhatsApp sin terminar, con un costo de hasta
$3,00. No hay segunda corrida sin una aprobación nueva, aunque esta se pare antes de terminar. El
CLI nunca imprime números ni nombres: solo cuentas.

**Antes:** marca «Le escribí yo» en /admin → Registros sin terminar en todos a los que ya les
escribiste después de la invitación. En WhatsApp Manager revisa que la calidad del número esté en
verde, que la plantilla esté activa y en Marketing, que el límite de mensajes sea de 250 o más, que
haya un medio de pago y que la tarifa de marketing de «Rest of Latin America» no pase de $0,10.

**Solo contar** (cualquier día): `railway run --service worker pnpm --filter @caja/worker
signup:rescue`. Muestra los excluidos por motivo, los elegibles por paso, cuántos se enviarían
(el tope es 30), el costo estimado y la calidad de la plantilla y del número, o «no se pudo leer»
(sin `META_WABA_ID`, la de la plantilla no se lee). Manda esas cuentas a la agencia.

**Enviar:** enciende «Registro: plantilla (lote)» en /admin. Un martes, miércoles o jueves,
entre las 10:00 y las 10:45 de Caracas, corre lo mismo con `--apply --confirm <N>`, con N igual
a «a enviar» del conteo. Sale uno cada 90 segundos (unos 45 minutos para 30), del más reciente
al más viejo.

**Se para sola** antes de cada envío si pasa algo de esto, y sale con código 3:
- **S1:** apagaste el interruptor en /admin. Es tu freno desde el teléfono, ante un reporte, un
  bloqueo o cualquier cosa rara.
- **S2:** dos personas de esta corrida dijeron «No me escribas».
- **S3:** Meta devolvió un código de calidad, de límite o de cuenta.
- **S4:** Meta retuvo un envío (`held_for_quality_assessment`).
- **S5:** hubo dos fallos de otro tipo. El 131049 se cuenta pero no para la corrida.
- **S6:** la plantilla dejó de estar aprobada o en verde, o el número dejó de estar en verde. Se
  revisa al empezar y cada 5 envíos; si no se puede leer, lo dice y siguen las demás reglas.
- **S7:** pasaron las 11:30 o empezó el horario nocturno.

**Después:** manda a la agencia la salida (enviados, retenidos, fallidos por código, «No me
escribas», motivo de parada, sin enviar y costo) y apaga el interruptor.

Variables en Railway (servicio worker): `META_SIGNUP_TEMPLATE=rocco_registro_pendiente` y,
opcionales, `META_WABA_ID` (para leer la calidad de la plantilla) y `META_MARKETING_RATE_USD`
(0,074 por defecto).
