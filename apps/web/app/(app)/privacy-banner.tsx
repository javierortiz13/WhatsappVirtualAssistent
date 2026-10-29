import { es } from "@caja/core";
import { dismissPrivacyBanner } from "./privacy-actions";

const B = es.PRIVACY_BANNER;

/** H53b (US-200): aviso de la política nueva en el panel del dueño, hasta que lo cierre. */
export function PrivacyBanner() {
  return (
    <section className="notice privacy-banner" aria-label={B.text}>
      <p>
        {B.text} <a href="/privacidad">{B.link}</a>
      </p>
      <form action={dismissPrivacyBanner}>
        <button className="btn secondary small" type="submit" aria-label={B.dismissLabel}>
          {B.dismiss}
        </button>
      </form>
    </section>
  );
}
