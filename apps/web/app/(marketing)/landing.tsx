import { PILOT_NOTE, PLANS } from "@/lib/plans";
import { Effects } from "./effects";

/**
 * Landing pública. Texto en segunda persona, concreto, sin promesas de contabilidad: el producto
 * es "la caja del día sin sentarse". Los planes salen de `lib/plans.ts`.
 */
export function Landing({ waUrl }: { waUrl: string | null }) {
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
            <a href="#como">Cómo funciona</a>
            <a href="#funciones">Funciones</a>
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
            <span className="eyebrow">Para negocios pequeños en Venezuela</span>
            <h1>
              Tu caja, <span className="accent">por WhatsApp.</span>
            </h1>
            <p className="lead">
              Escribe "gasté 15$ en champú", dicta una nota de voz o manda la foto de la factura. El
              asistente lo registra con la tasa BCV del día y te da el cierre cuando lo pidas.
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
              <span className="pill">Tasa BCV automática</span>
              <span className="pill">Bs y $ el mismo día</span>
              <span className="pill">Pago Móvil, punto, Zelle</span>
              <span className="pill">Sin app que instalar</span>
            </div>
          </div>
          <Phone />
        </div>
      </section>

      <section id="como">
        <div className="wrap">
          <div className="reveal">
            <span className="eyebrow">Cómo funciona</span>
            <h2>Tres hábitos. Nada más.</h2>
            <p className="lead">
              No hay menús ni formularios. Le hablas al asistente como le hablarías a tu cajera.
            </p>
          </div>
          <div className="steps" style={{ marginTop: 36 }}>
            <div className="card step reveal d1">
              <h3>Cada gasto, en el momento</h3>
              <p>Pagaste el hielo, lo escribes y tocas Guardar. Él pone la categoría y la tasa.</p>
              <div className="ex">
                <b>Tú:</b> pagué 450 mil de hielo
              </div>
            </div>
            <div className="card step reveal d2">
              <h3>La venta, al cerrar</h3>
              <p>Un mensaje con el total y cómo entró. Él cuadra el desglose y lo convierte.</p>
              <div className="ex">
                <b>Tú:</b> hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto
              </div>
            </div>
            <div className="card step reveal d3">
              <h3>"cierre", antes de contar</h3>
              <p>Te dice cuánto efectivo debería haber en la caja. Cuentas y ves si cuadra.</p>
              <div className="ex">
                <b>Él:</b> Efectivo en caja: $180,00 · Bs 6.570,00
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="funciones">
        <div className="wrap">
          <div className="reveal">
            <span className="eyebrow">Funciones</span>
            <h2>Hecho para cómo se maneja la plata aquí.</h2>
          </div>
          <div className="feats" style={{ marginTop: 36 }}>
            {FEATURES.map((f, i) => (
              <div className={`card feat reveal d${(i % 3) + 1}`} key={f.title}>
                <span className="ico">{f.icon}</span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="dashboard">
        <div className="wrap dash">
          <div className="reveal">
            <span className="eyebrow">Dashboard</span>
            <h2>Y cuando quieras ver todo junto, lo tienes.</h2>
            <p className="lead">
              Entras desde el teléfono con tu correo. Ves el día, el mes, cada movimiento con su
              foto, corriges lo que haga falta y bajas el Excel para tu contador.
            </p>
          </div>
          <DashMock />
        </div>
      </section>

      <section id="planes">
        <div className="wrap">
          <div className="reveal">
            <span className="eyebrow">Planes</span>
            <h2>Menos de lo que cuesta un cuaderno con errores.</h2>
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
                  ${p.priceUsd.toFixed(2)} <small>/ mes</small>
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
            <h2>Esta noche cierra la caja desde el chat.</h2>
            <p className="lead" style={{ margin: "12px auto 24px" }}>
              Crea tu cuenta, vincula tu número con un código y escribe tu primer gasto. Toma tres
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

function Phone() {
  return (
    <div className="phone reveal" aria-hidden="true">
      <div className="notch" />
      <div className="screen">
        <div className="chat-head">
          <span className="av">C</span>
          <div>
            Asistente de Caja
            <small>en línea</small>
          </div>
        </div>
        <div className="chat">
          <div className="msg in">gasté 15$ en champú</div>
          <div className="msg out">
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
          </div>
          <div className="msg in">Guardar</div>
          <div className="msg out">Listo. Hoy llevas $15,00 en gastos.</div>
          <div className="msg in">cierre</div>
          <div className="msg out">
            <strong>Cierre · jue 01/10</strong>
            <br />
            Ventas $350,00 · Gastos $15,00
            <br />
            Neto <strong>$335,00</strong>
            <br />
            Efectivo en caja: $200,00
          </div>
        </div>
        <div className="chat-foot">
          <span />
          <i />
        </div>
      </div>
    </div>
  );
}

function DashMock() {
  const bars = [
    { day: "V", h: 38 },
    { day: "S", h: 22 },
    { day: "D", h: 72, cls: " best" },
    { day: "L", h: 44 },
    { day: "M", h: 8, cls: " worst" },
    { day: "M2", h: 55 },
    { day: "J", h: 64, cls: " today" },
  ];
  return (
    <div className="dash-mock reveal d1" aria-hidden="true">
      <div className="card hero">
        <span className="label">Hoy · jue 01/10</span>
        <p className="big num mint">$335,00</p>
        <p className="sub num">Bs 12.227,50 · 7 movimientos</p>
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="tile">
            <span className="label">Ventas</span>
            <strong className="num mint tile-n">$350,00</strong>
          </div>
          <div className="tile">
            <span className="label">Gastos</span>
            <strong className="num amber tile-n">$15,00</strong>
          </div>
        </div>
        <div className="bars">
          {bars.map((b) => (
            <span className={`bar${b.cls ?? ""}`} key={b.day}>
              <i style={{ height: b.h }} />
              <b>{b.day.charAt(0)}</b>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    title: "Notas de voz",
    text: "Dicta el gasto mientras cargas la camioneta. Él lo transcribe y arma el borrador.",
    icon: (
      <Ico d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />
    ),
  },
  {
    title: "Foto de la factura",
    text: "Manda la foto. Lee el total, el proveedor y la fecha, y guarda la imagen con el gasto.",
    icon: (
      <Ico d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
    ),
  },
  {
    title: "Bs y $ con la tasa del día",
    text: "Cada movimiento guarda su tasa BCV. Lo de ayer no se recalcula con la de hoy.",
    icon: <Ico d="M3 17l6-6 4 4 8-8M14 7h7v7" />,
  },
  {
    title: "Cierre del día",
    text: "Ventas por método de pago, gastos por categoría, neto y efectivo que debe haber en caja.",
    icon: <Ico d="M5 20V10m7 10V4m7 16v-7" />,
  },
  {
    title: "Tu empleado también registra",
    text: "Le das acceso con su número. Registra gastos y ventas; los cierres los ves solo tú.",
    icon: (
      <Ico d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    ),
  },
  {
    title: "Corrige sin pelear",
    text: '"No, eran 25" y listo. Todo cambio queda registrado, y en el dashboard editas lo que quieras.',
    icon: <Ico d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z" />,
  },
];

const FAQ = [
  {
    q: "¿Tengo que instalar algo?",
    a: "No. El asistente es un número de WhatsApp. Creas la cuenta con tu correo, vinculas tu número con un código de seis dígitos y empiezas a escribirle.",
  },
  {
    q: "¿Qué pasa con mis datos?",
    a: "Son tuyos. Cada negocio está aislado de los demás, puedes exportar todo a Excel cuando quieras y borrar tu cuenta desde el dashboard. Las notas de voz se transcriben y se descartan; nunca se guardan.",
  },
  {
    q: "¿Y si la tasa cambia a mitad de día?",
    a: 'Usamos la tasa oficial del BCV vigente para la fecha del movimiento. Si registras algo de ayer, va con la de ayer. Si necesitas otra tasa para un caso puntual, se la dices: "ponlo a tasa 850".',
  },
  {
    q: "¿Lleva inventario o factura?",
    a: "No, y a propósito. Esto es la caja: lo que entra, lo que sale y cuánto queda. Para inventario y facturación sigue con tu sistema; el Excel que exportas se lo pasas a tu contador.",
  },
  {
    q: "¿Cómo se paga?",
    a: "Pago Móvil en bolívares a la tasa del día, Zelle o USDT. Durante el piloto no se cobra.",
  },
];

function Ico({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      width="40"
      height="40"
      style={{ padding: 8, background: "rgba(63,224,176,.1)", borderRadius: 12 }}
    >
      <path d={d} />
    </svg>
  );
}

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
