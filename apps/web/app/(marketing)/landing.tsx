import { PILOT_NOTE, PLANS } from "@/lib/plans";
import { Effects } from "./effects";
import { type Scene, Story } from "./story";

/** Sueldo de referencia de una administradora de caja en Venezuela (USD/mes). Hipótesis del fundador. */
const ADMIN_SALARY = 300;
const NEGOCIO = PLANS.find((p) => p.id === "negocio") ?? PLANS[1];
const money = (n: number | undefined) => `$${(n ?? 0).toFixed(2).replace(".", ",")}`;

/**
 * Landing pública. Posicionamiento: un asistente administrativo por WhatsApp que hace la parte
 * de la caja que hoy hace una persona, por una fracción del sueldo. La página es una conversación:
 * el visitante "le escribe" al asistente al hacer scroll y las respuestas son el servicio.
 */
export function Landing({ waUrl, heroPhoto }: { waUrl: string | null; heroPhoto: string | null }) {
  const primary = waUrl ?? "/login";
  return (
    <div className="lp">
      <Effects />
      <header className="lp-nav">
        <div className="wrap">
          <a className="logo" href="/">
            <Logo />
            Asistente de Caja
          </a>
          <nav className="links" aria-label="Secciones">
            <a href="#historia">Cómo funciona</a>
            <a href="#planes">Planes</a>
            <a href="#preguntas">Preguntas</a>
          </nav>
          <span className="spacer" />
          <a className="enter" href="/login">
            Entrar
          </a>
          <a className="btn small" href="/registro">
            Crear cuenta
          </a>
        </div>
      </header>

      <section className="lp-hero">
        <div className="wrap">
          <div>
            <span className="eyebrow">Asistente administrativo por WhatsApp</span>
            <h1>
              Una administradora cuesta <span className="accent">${ADMIN_SALARY}</span> al mes.
              <br />
              Tu asistente, <span className="accent">{money(NEGOCIO?.priceUsd)}</span>.
            </h1>
            <p className="lead">
              Lleva la caja de tu negocio desde el chat: anota gastos y ventas, cuida la tasa BCV y
              te da el cierre cada noche. Sin app, sin Excel, sin sueldo.
            </p>
            <div className="ctas">
              <a
                className="btn lg wa"
                href={primary}
                target={waUrl ? "_blank" : undefined}
                rel="noreferrer"
              >
                <WaIcon />
                Probar por WhatsApp
              </a>
              <a className="btn lg secondary" href="/registro">
                Crear mi cuenta
              </a>
            </div>
            <div className="trust">
              <span className="pill">Responde en segundos, 7 días</span>
              <span className="pill">Bs y $ con tasa BCV</span>
              <span className="pill">Texto, voz y foto</span>
            </div>
          </div>
          {heroPhoto ? (
            <figure className="hero-photo reveal d1">
              <img
                src={heroPhoto}
                alt="Dueño de un negocio registrando un gasto por WhatsApp desde su mostrador"
                width={1200}
                height={1500}
              />
              <Compare />
            </figure>
          ) : (
            <Compare />
          )}
          <a className="scroll-hint" href="#historia">
            Desliza y háblale <span>↓</span>
          </a>
        </div>
      </section>

      <div id="historia" style={{ scrollMarginTop: 72 }}>
        <Story scenes={scenes(waUrl)}>
          <div className="ctas">
            <a className="btn lg" href="/registro">
              Crear mi cuenta
            </a>
            {waUrl ? (
              <a className="btn lg secondary" href={waUrl} target="_blank" rel="noreferrer">
                Escribirle ahora
              </a>
            ) : null}
          </div>
        </Story>
      </div>

      <section id="planes">
        <div className="wrap">
          <div className="reveal">
            <span className="eyebrow">Planes</span>
            <h2>Lo que cuesta una tarde de trabajo, no un sueldo.</h2>
            <p className="lead">{PILOT_NOTE}</p>
          </div>
          <div className="plans" style={{ marginTop: 36 }}>
            {PLANS.map((p, i) => (
              <div className={`card plan reveal d${i + 1}${p.highlight ? " hi" : ""}`} key={p.id}>
                <div className="name">
                  {p.name}
                  {p.highlight ? <span className="badge ok">Más elegido</span> : null}
                </div>
                <div className="price num">
                  {money(p.priceUsd)} <small>/ mes</small>
                </div>
                <p className="tag">{p.tagline}</p>
                <ul>
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <a className={`btn${p.highlight ? "" : " secondary"}`} href="/registro">
                  Empezar con {p.name}
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="preguntas">
        <div className="wrap">
          <div className="reveal" style={{ textAlign: "center", marginBottom: 32 }}>
            <span className="eyebrow">Preguntas</span>
            <h2>Lo que todo el mundo pregunta primero.</h2>
          </div>
          <div className="faq">
            {FAQ.map((q) => (
              <details className="card reveal" key={q.q}>
                <summary>{q.q}</summary>
                <p>{q.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-final">
        <div className="wrap">
          <div className="card reveal">
            <h2>Esta noche, que la caja la cuadre él.</h2>
            <p className="lead" style={{ margin: "12px auto 24px" }}>
              Crea tu cuenta, vincula tu número con un código y escríbele tu primer gasto. Toma tres
              minutos.
            </p>
            <div className="ctas" style={{ justifyContent: "center" }}>
              <a className="btn lg" href="/registro">
                Crear mi cuenta
              </a>
              {waUrl ? (
                <a className="btn lg secondary" href={waUrl} target="_blank" rel="noreferrer">
                  Escribirle al asistente
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="wrap">
          <span>© {new Date().getFullYear()} Asistente de Caja · JP Software</span>
          <nav aria-label="Legal">
            <a href="/privacidad">Privacidad</a>
            <a href="/eliminar-datos">Eliminar mis datos</a>
            <a href="/login">Entrar</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Compare() {
  return (
    <div className="hero-compare reveal d1" aria-hidden="true">
      <div className="card cmp">
        <span className="label">Administradora de caja</span>
        <p className="big num amber">${ADMIN_SALARY}</p>
        <p className="sub">al mes · un turno · se enferma, se va de vacaciones</p>
      </div>
      <div className="card cmp hi">
        <span className="label">Asistente de Caja · plan Negocio</span>
        <p className="big num mint">{money(NEGOCIO?.priceUsd)}</p>
        <p className="sub">al mes · 24 horas · nunca se le olvida la tasa</p>
      </div>
    </div>
  );
}

function scenes(waUrl: string | null): Scene[] {
  return [
    {
      user: "hola",
      bot: (
        <>
          Hola 👋 Soy tu asistente de caja. Hago lo que una administradora hace con la caja: anoto
          lo que entra y lo que sale, lo cuadro y te aviso. ¿Qué quieres saber?
          <div className="btns">
            <span>Qué haces</span>
            <span>Cuánto cuestas</span>
          </div>
        </>
      ),
      caption: {
        title: "Siempre en línea. Nunca de reposo.",
        text: "Responde en segundos, los siete días, desde el mismo WhatsApp que ya usas con tus clientes.",
      },
    },
    {
      user: "¿qué haces?",
      bot: (
        <>
          Registro cada gasto y cada venta. Me escribes, me dictas una nota de voz o me mandas la
          foto de la factura. Yo pongo la categoría y la tasa BCV del día, y lo guardo cuando tú
          confirmas.
          <br />
          <br />
          También llevo las ventas por método de pago, te doy el cierre, y tu empleado puede
          registrar desde su número.
        </>
      ),
      caption: {
        title: "Lo que le dictarías a tu administradora, me lo dictas a mí.",
        text: "Texto, nota de voz o foto. Bolívares y dólares el mismo día, cada uno con su tasa.",
      },
    },
    {
      user: "gasté 15$ en champú",
      bot: (
        <>
          <strong>Gasto por confirmar</strong>
          <br />
          $15,00 · Bs 547,50 (tasa 36,50)
          <br />
          Insumos · hoy
          <div className="btns">
            <span>Guardar</span>
            <span>Corregir</span>
            <span>Cancelar</span>
          </div>
        </>
      ),
      caption: {
        title: "Nada entra sin tu OK.",
        text: "Te muestra el borrador con el monto, la categoría y la tasa. Guardas, corriges o cancelas con un toque.",
      },
    },
    {
      user: "Guardar",
      bot: <>Listo ✅ Hoy llevas $15,00 en gastos.</>,
      caption: {
        title: "Y queda guardado con fecha, tasa y quién lo registró.",
        text: 'Si algo cambia, le dices "no, eran 25" y lo corrige. Todo cambio deja rastro.',
      },
    },
    {
      user: "cierre",
      bot: (
        <>
          <strong>Cierre · jue 01/10</strong>
          <br />
          Ventas $350,00 · Gastos $15,00
          <br />
          Neto <strong>$335,00</strong> · Bs 12.227,50
          <br />
          Efectivo en caja: $200,00 · Bs 3.650,00
        </>
      ),
      caption: {
        title: "El cierre, antes de contar la caja.",
        text: "Ventas por método, gastos por categoría, neto del día y el efectivo que debe haber. Cuentas y ves si cuadra.",
      },
    },
    {
      user: "¿cuánto cuestas?",
      bot: (
        <>
          Menos que una tarde de trabajo.
          <br />
          <br />
          {PLANS.map((p) => (
            <span key={p.id} className="planline">
              <b>{p.name}</b> · {money(p.priceUsd)}/mes · {p.features[0]}
              <br />
            </span>
          ))}
          <br />
          Durante el piloto, gratis.
        </>
      ),
      caption: {
        title: `$${ADMIN_SALARY} de sueldo al mes, o ${money(NEGOCIO?.priceUsd)} de plan.`,
        text: "El plan Negocio incluye tu número y el de un empleado, ventas, cierre y dashboard. Sin contrato.",
      },
    },
    {
      user: "¿y mis datos?",
      bot: (
        <>
          Son tuyos. Cada negocio está aislado de los demás, exportas todo a Excel cuando quieras y
          puedes borrar tu cuenta desde el dashboard. Las notas de voz se transcriben y se
          descartan: nunca se guardan.
        </>
      ),
      caption: {
        title: "Tu caja es tuya.",
        text: "Nada se comparte, nada se vende. Y tu contador recibe el Excel que siempre pidió.",
      },
    },
    {
      user: "quiero empezar",
      bot: (
        <>
          Crea tu cuenta con tu correo, vincula tu número con un código de seis dígitos y escríbeme
          tu primer gasto. Tres minutos.
          <div className="btns">
            <span>Crear cuenta</span>
            {waUrl ? <span>Escribirle ahora</span> : null}
          </div>
        </>
      ),
      caption: {
        title: "Empieza esta noche.",
        text: "Sin tarjeta, sin instalar nada. Durante el piloto no se cobra.",
      },
    },
  ];
}

const FAQ = [
  {
    q: "¿De verdad reemplaza a una administradora?",
    a: "Reemplaza la parte de la caja: anotar, convertir, cuadrar y cerrar. No factura, no lleva inventario ni nómina. Si hoy pagas a alguien solo para que lleve el cuaderno de la caja, sí.",
  },
  {
    q: "¿Tengo que instalar algo?",
    a: "No. El asistente es un número de WhatsApp. Creas la cuenta con tu correo, vinculas tu número con un código de seis dígitos y empiezas a escribirle.",
  },
  {
    q: "¿Y si la tasa cambia a mitad de día?",
    a: 'Usa la tasa oficial del BCV vigente para la fecha del movimiento. Lo de ayer va con la de ayer. Si necesitas otra tasa para un caso puntual, se la dices: "ponlo a tasa 850".',
  },
  {
    q: "¿Mi empleado puede usarlo?",
    a: "Sí. Lo agregas con su número desde Ajustes y registra gastos y ventas; los cierres y los totales los ves solo tú.",
  },
  {
    q: "¿Cómo se paga?",
    a: "Pago Móvil en bolívares a la tasa del día, Zelle o USDT. Durante el piloto no se cobra y los precios se avisan con 30 días de anticipación.",
  },
];

function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#0f7b5f" />
      <path d="M16 22h32v22a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4z" fill="#fff" />
      <path d="M14 20a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v4H14z" fill="#d9f2e8" />
      <circle cx="40" cy="35" r="4" fill="#0f7b5f" />
    </svg>
  );
}

function WaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.6.8-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 12 12 0 0 0 4.6 4c1.7.7 2 .6 2.7.5a2.3 2.3 0 0 0 1.5-1.1c.2-.5.2-1 .1-1.1l-.3-.1z" />
    </svg>
  );
}
