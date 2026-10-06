import type { Metadata } from "next";
import "../legal.css";

export const metadata: Metadata = { title: "Eliminar mis datos" };

export default function EliminarDatos() {
  return (
    <main className="legal">
      <h1>Eliminar mis datos</h1>
      <p className="updated">Asistente de Caja</p>
      <p>Puedes eliminar todos tus datos de tres formas:</p>
      <ul>
        <li>
          Desde WhatsApp: escribe <strong>eliminar mi cuenta</strong> al asistente desde el número
          del dueño y confirma con el botón. Se borra al instante.
        </li>
        <li>
          Desde el panel: <strong>Ajustes → Negocio → Eliminar mi cuenta</strong>, escribiendo el
          nombre del negocio para confirmar. Se borra al instante.
        </li>
        <li>
          Por correo: escribe a{" "}
          <a href="mailto:privacidad@caja.jpsoftwaredev.com">privacidad@caja.jpsoftwaredev.com</a>{" "}
          desde el correo con el que entras al panel, indicando el nombre de tu negocio.
        </li>
      </ul>
      <p>
        Se borran tu número, tus mensajes, tus movimientos, tus cuentas, tus fotos y tu acceso al
        panel. Por correo lo hacemos en un plazo máximo de 30 días y te confirmamos por el mismo
        medio. Los registros contables que la ley
        te obligue a conservar puedes exportarlos antes desde el panel.
      </p>
      <p>
        Más detalles en la <a href="/privacidad">política de privacidad</a>.
      </p>
    </main>
  );
}
