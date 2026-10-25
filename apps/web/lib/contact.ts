/**
 * Correo de contacto de privacidad (PRD hábitos US-200, decisión D11 del 20/10): uno solo para
 * /privacidad y /eliminar-datos. Mientras no se confirme que privacidad@caja.jpsoftwaredev.com
 * recibe correos, se puede cambiar en Vercel con PRIVACY_CONTACT sin tocar el código.
 */
export const PRIVACY_CONTACT =
  process.env.PRIVACY_CONTACT?.trim() || "privacidad@caja.jpsoftwaredev.com";
