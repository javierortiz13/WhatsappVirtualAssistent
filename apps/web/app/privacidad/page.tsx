import type { Metadata } from "next";
import "../legal.css";

export const metadata: Metadata = { title: "Política de privacidad" };

/** Política de privacidad pública. Meta la exige para publicar la app; refleja la Fase 2 del diseño. */
export default function Privacidad() {
  return (
    <main className="legal">
      <h1>Política de privacidad</h1>
      <p className="updated">Asistente de Caja · última actualización: 29 de septiembre de 2026</p>

      <p>
        Asistente de Caja es un servicio para dueños de negocios pequeños que registra gastos,
        ventas y cierres de caja a través de WhatsApp y de un panel web. Esta política explica qué
        datos tratamos, para qué, por cuánto tiempo y cómo puedes ejercer tus derechos.
      </p>

      <h2>Responsable</h2>
      <p>
        JP Software Dev (Javier Ortiz). Contacto:{" "}
        <a href="mailto:privacidad@caja.jpsoftwaredev.com">privacidad@caja.jpsoftwaredev.com</a>.
      </p>

      <h2>Datos que tratamos</h2>
      <ul>
        <li>
          <strong>Identificación:</strong> tu número de WhatsApp, tu nombre de perfil de WhatsApp y
          el correo con el que entras al panel.
        </li>
        <li>
          <strong>Mensajes:</strong> el texto de los mensajes que envías al asistente, las notas de
          voz y las fotos de facturas que decides compartir, y las respuestas que te enviamos.
        </li>
        <li>
          <strong>Datos del negocio:</strong> nombre, tipo, categorías, movimientos de caja (montos,
          monedas, fechas, descripciones) y la tasa de cambio aplicada.
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
        <a href="mailto:privacidad@caja.jpsoftwaredev.com">privacidad@caja.jpsoftwaredev.com</a> o
        siguiendo las instrucciones en <a href="/eliminar-datos">/eliminar-datos</a>. Respondemos en
        un máximo de 15 días.
      </p>

      <h2>Seguridad</h2>
      <p>
        Los datos viajan cifrados, se guardan aislados por negocio y solo acceden a ellos las
        personas que tú autorizas con su número o correo. Ninguna acción que cambie tu caja se
        ejecuta sin tu confirmación.
      </p>

      <h2>Cambios</h2>
      <p>
        Si esta política cambia de forma relevante te avisaremos por WhatsApp o en el panel. La
        versión vigente está siempre en esta dirección.
      </p>
    </main>
  );
}
