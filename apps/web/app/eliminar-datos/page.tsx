import type { Metadata } from "next";
import "../legal.css";

export const metadata: Metadata = { title: "Eliminar mis datos" };

export default function EliminarDatos() {
  return (
    <main className="legal">
      <h1>Eliminar mis datos</h1>
      <p className="updated">Asistente de Caja</p>
      <p>Puedes pedir la eliminación completa de tus datos de dos formas:</p>
      <ul>
        <li>
          Desde WhatsApp: escribe <strong>eliminar mi cuenta</strong> al asistente desde el número
          registrado. Te pediremos una confirmación.
        </li>
        <li>
          Por correo: escribe a{" "}
          <a href="mailto:privacidad@caja.jpsoftwaredev.com">privacidad@caja.jpsoftwaredev.com</a>{" "}
          desde el correo con el que entras al panel, indicando el nombre de tu negocio.
        </li>
      </ul>
      <p>
        En un plazo máximo de 30 días borramos tu número, tus mensajes, tus movimientos, tus fotos y
        tu cuenta del panel, y te confirmamos por el mismo medio. Los registros contables que la ley
        te obligue a conservar puedes exportarlos antes desde el panel.
      </p>
      <p>
        Más detalles en la <a href="/privacidad">política de privacidad</a>.
      </p>
    </main>
  );
}
