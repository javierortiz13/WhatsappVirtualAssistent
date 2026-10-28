/**
 * Login CSRF (seguridad F4, 27/10): los route handlers POST no tienen el chequeo de Origin de las
 * server actions. Una página ajena podría mandar un token_hash suyo y dejar a la víctima dentro de
 * la cuenta del atacante. Se rechaza si el Origin no es el del panel ni el del propio servidor que
 * atiende (con o sin www, un preview), o si el navegador dice que la petición es de otro sitio.
 */
export function isCrossSite(req: Request, dashboardOrigin: string): boolean {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  const own = new URL(req.url).origin;
  return Boolean(
    (origin && origin !== dashboardOrigin && origin !== own) || (site && site !== "same-origin"),
  );
}
