import type { Metadata } from "next";
import { PRIVACY_CONTACT } from "@/lib/contact";
import "../legal.css";

export const metadata: Metadata = { title: "Política de privacidad" };

/**
 * Fecha del despliegue (US-200). P-1…P-5 de hábitos v1.2: borrador para el abogado y cumplimiento;
 * no sale a producción hasta que los dos vean este texto exacto y se apruebe la fila (A14).
 */
const UPDATED = "17 de noviembre de 2026";

/** Política de privacidad pública. Meta la exige para publicar la app; refleja la Fase 2 del diseño. */
export default function Privacidad() {
  return (
    <main className="legal">
      <h1>Política de privacidad</h1>
      <p className="updated">Rocco · última actualización: {UPDATED}</p>

      <p>
        Rocco (antes «Asistente de Caja») es un servicio para personas y dueños de negocios pequeños
        que registra gastos, ventas, cuentas y cierres a través de WhatsApp y de un panel web. Esta
        política explica qué datos tratamos, para qué, por cuánto tiempo y cómo puedes ejercer tus
        derechos.
      </p>

      <h2>Responsable</h2>
      <p>
        JP Software Dev (Javier Ortiz). Contacto:{" "}
        <a href={`mailto:${PRIVACY_CONTACT}`}>{PRIVACY_CONTACT}</a>.
      </p>

      <h2>Datos que tratamos</h2>
      <ul>
        <li>
          <strong>Identificación:</strong> tu número de WhatsApp, tu nombre de perfil de WhatsApp y
          el correo con el que entras al panel.
        </li>
        <li>
          <strong>Mensajes:</strong> el texto de los mensajes que le envías a Rocco, las notas de
          voz y las fotos de facturas que decides compartir, y las respuestas que te enviamos.
        </li>
        <li>
          <strong>Datos del negocio:</strong> nombre, tipo, categorías, movimientos de caja (montos,
          monedas, fechas, descripciones) y la tasa de cambio aplicada.
        </li>
        <li>
          <strong>Recordatorios y preferencias:</strong> lo que le pides a Rocco que te recuerde
          (qué, cuándo y, si lo dices, un monto o el nombre de otra persona), los días que nos dices
          que no tuviste gastos, si activaste o apagaste los avisos de Rocco, y tu racha, calculada
          con tus registros.
        </li>
        <li>
          <strong>Datos técnicos:</strong> identificadores de mensajes de WhatsApp, marcas de
          tiempo, registros de errores y métricas de uso sin contenido de los mensajes.
        </li>
      </ul>

      <h2>Para qué los usamos</h2>
      <ul>
        <li>Interpretar tus mensajes y registrar movimientos de caja que tú confirmas.</li>
        <li>Mostrarte cierres, resúmenes y el historial en el panel.</li>
        <li>Enviarte respuestas y avisos por WhatsApp relacionados con tu caja.</li>
        <li>
          Enviarte los recordatorios que pides y, si lo activas, el aviso de racha de las 8 pm, como
          máximo uno al día. Si después de 3 avisos seguidos no anotas nada, lo pausamos 14 días.
        </li>
        <li>
          Puedes apagar estos avisos cuando quieras. Con «no me recuerdes» apagas el aviso de racha
          y los avisos adelantados de tus recordatorios; con «no me escribas», todo lo que Rocco te
          manda por su cuenta, salvo los avisos sobre un pago tuyo o el borrado de tus datos. Antes
          de apagarlos, Rocco te pide confirmar, y mientras no contestes no te los manda. También
          puedes hacerlo en Ajustes, y volver a encenderlos con «actívame los avisos» o «ya puedes
          escribirme».
        </li>
        <li>
          Si en un recordatorio mencionas a otra persona, ese dato solo se usa para mostrártelo a
          ti. Rocco nunca le escribe a esa persona ni usa ese dato para nada más.
        </li>
        <li>Mantener la seguridad, prevenir abusos y corregir fallas del servicio.</li>
      </ul>
      <p>No vendemos tus datos ni los usamos para publicidad.</p>

      <h2>Proveedores que procesan datos por nosotros</h2>
      <ul>
        <li>Meta Platforms (WhatsApp Business Platform) para enviar y recibir mensajes.</li>
        <li>Supabase (base de datos y almacenamiento cifrado) y Vercel y Railway (servidores).</li>
        <li>
          Anthropic para interpretar el texto de los mensajes; Deepgram para transcribir notas de
          voz. Estos proveedores no conservan tus datos para entrenar modelos.
        </li>
        <li>Resend para los correos de acceso al panel.</li>
        <li>
          Sentry para registrar fallas técnicas del servicio (qué falló, dónde y datos técnicos como
          el navegador), nunca el contenido de tus mensajes. Better Stack para vigilar que el
          servicio esté en línea; no recibe datos tuyos.
        </li>
      </ul>

      <h2>Conservación</h2>
      <ul>
        <li>
          El texto de los mensajes se borra a los 90 días. Las notas de voz se borran al
          transcribirse.
        </li>
        <li>Las fotos de facturas se conservan 12 meses y luego se borran.</li>
        <li>Los movimientos de caja se conservan mientras tu cuenta esté activa.</li>
        <li>
          Los recordatorios se borran 90 días después de cumplidos, vencidos o borrados. Si tocas
          «Borrar», el recordatorio pierde su texto al instante; los mensajes del chat donde aparece
          (el tuyo y los de Rocco) se borran a los 90 días, como todos los mensajes. Tus
          preferencias de avisos y los días sin gastos se conservan mientras tengas la cuenta y se
          borran con ella.
        </li>
        <li>
          Si dejas de pagar, tus datos se conservan 90 días desde la suspensión (te avisamos antes)
          y luego pasan a la papelera.
        </li>
        <li>
          Al eliminar tu cuenta, queda 15 días en la papelera para que puedas recuperarla si fue un
          error; no usamos esos datos en ese plazo y al día 15 se borran todos para siempre.
        </li>
      </ul>

      <h2>Tus derechos</h2>
      <p>
        Puedes pedir acceso, corrección, exportación o eliminación de tus datos escribiendo a{" "}
        <a href={`mailto:${PRIVACY_CONTACT}`}>{PRIVACY_CONTACT}</a> o siguiendo las instrucciones en{" "}
        <a href="/eliminar-datos">/eliminar-datos</a>. Respondemos en un máximo de 15 días.
      </p>

      <h2>Seguridad</h2>
      <p>
        Los datos viajan cifrados y se guardan aislados por negocio. En el chat y en el panel solo
        acceden las personas que tú autorizas con su número o correo; el equipo de Rocco los
        consulta solo cuando hace falta para darte soporte, verificar un pago o corregir una falla.
      </p>

      <h2>Cambios</h2>
      <p>
        Si esta política cambia de forma relevante te avisaremos por WhatsApp o en el panel. La
        versión vigente está siempre en esta dirección.
      </p>
    </main>
  );
}
