import { PILOT_NOTE, PLANS } from "@/lib/plans";
import { Effects } from "./effects";
import { type Scene, Story } from "./story";

const money = (n: number | undefined) => `$${(n ?? 0).toFixed(2).replace(".", ",")}`;

/**
 * Landing pública con la marca Rocco (07/10/2026): "tu amigo fiel con tus finanzas", un pug que
 * te lleva las cuentas por WhatsApp. Sirve para lo personal y para el negocio. La página es una
 * conversación: el visitante "le escribe" a Rocco al hacer scroll y las respuestas son el
 * servicio. Colores de siempre; cambia el texto (guía de voz: docs/marca/rocco.md).
 */
export function Landing({ waUrl, heroPhoto }: { waUrl: string | null; heroPhoto: string | null }) {
  const primary = waUrl ?? "/registro";
  return (
    <div className="lp">
      <Effects />
      <header className="lp-nav">
        <div className="wrap">
          <a className="logo" href="/">
            <Logo />
            Rocco
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
          <a
            className="btn small"
            href={primary}
            target={waUrl ? "_blank" : undefined}
            rel="noreferrer"
          >
            Probar gratis
          </a>
        </div>
      </header>

      <section className="lp-hero">
        <div className="wrap">
          <div>
            <span className="eyebrow">Rocco · Fiel a tus cuentas</span>
            <h1>
              Tu amigo fiel
              <br />
              con tus <span className="accent">finanzas</span>.
            </h1>
            <p className="lead">
              Rocco te lleva las cuentas por WhatsApp. Le escribes como a un pana, le mandas una
              nota de voz o la foto de la factura, y él anota tus gastos y ventas en bolívares y
              dólares con la tasa del día. Sin apps, sin Excel, sin cuaderno.
            </p>
            <div className="ctas">
              <a
                className="btn lg wa"
                href={primary}
                target={waUrl ? "_blank" : undefined}
                rel="noreferrer"
              >
                <WaIcon />
                Escribirle a Rocco
              </a>
              <a className="btn lg secondary" href="/registro">
                Crear cuenta en la web
              </a>
            </div>
            <div className="trust">
              <span className="pill">Tu cuenta se crea en el mismo chat</span>
              <span className="pill">Bs, $ y USDT con tasa BCV</span>
              <span className="pill">Texto, voz y foto</span>
            </div>
          </div>
          {heroPhoto ? (
            <figure className="hero-photo reveal d1">
              <img
                src={heroPhoto}
                alt="Persona anotando un gasto con Rocco por WhatsApp"
                width={920}
                height={1150}
              />
              <Compare />
            </figure>
          ) : (
            <Compare />
          )}
          <a className="scroll-hint" href="#historia">
            Desliza y háblale a Rocco <span>↓</span>
          </a>
        </div>
      </section>

      <div id="historia" style={{ scrollMarginTop: 72 }}>
        <Story scenes={scenes(waUrl)}>
          <div className="ctas">
            <a
              className="btn lg"
              href={primary}
              target={waUrl ? "_blank" : undefined}
              rel="noreferrer"
            >
              Escribirle a Rocco
            </a>
            <a className="btn lg secondary" href="/registro">
              Crear cuenta en la web
            </a>
          </div>
        </Story>
      </div>

      <section id="planes">
        <div className="wrap">
          <div className="reveal">
            <span className="eyebrow">Planes</span>
            <h2>Un plan para tu bolsillo y otro para tu negocio.</h2>
            <p className="lead">
              Empiezas con 14 días gratis. Los primeros 50 tienen precio de fundador: 40 % menos.{" "}
              {PILOT_NOTE}
            </p>
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
                <a
                  className={`btn${p.highlight ? "" : " secondary"}`}
                  href={primary}
                  target={waUrl ? "_blank" : undefined}
                  rel="noreferrer"
                >
                  Probar gratis
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
            <h2>Lo que todo el mundo le pregunta a Rocco primero.</h2>
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
            <h2>Hoy mismo, que las cuentas las lleve Rocco.</h2>
            <p className="lead" style={{ margin: "12px auto 24px" }}>
              Escríbele <strong>hola</strong> por WhatsApp y crea tu cuenta en el mismo chat. Toma
              dos minutos y tienes 14 días gratis.
            </p>
            <div className="ctas" style={{ justifyContent: "center" }}>
              <a
                className="btn lg wa"
                href={primary}
                target={waUrl ? "_blank" : undefined}
                rel="noreferrer"
              >
                <WaIcon />
                Escribirle a Rocco
              </a>
              <a className="btn lg secondary" href="/registro">
                Crear cuenta en la web
              </a>
            </div>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="wrap">
          <span>© {new Date().getFullYear()} Rocco · Fiel a tus cuentas · JP Software</span>
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
        <span className="label">Sin Rocco</span>
        <p className="big num amber">3 apps</p>
        <p className="sub">
          cuaderno, calculadora y Excel para cada gasto, y la tasa en otra pestaña
        </p>
      </div>
      <div className="card cmp hi">
        <span className="label">Con Rocco</span>
        <p className="big num mint">1 chat</p>
        <p className="sub">le escribes como a un pana y él anota, convierte y suma por ti</p>
      </div>
    </div>
  );
}

function scenes(waUrl: string | null): Scene[] {
  return [
    {
      user: "hola Rocco",
      bot: (
        <>
          ¡Hola! Soy Rocco 🐾, tu amigo fiel con tus finanzas. Te llevo los gastos, las ventas y tus
          cuentas desde este chat. ¿Qué quieres saber?
          <div className="btns">
            <span>Qué sabes hacer</span>
            <span>Cómo empiezo</span>
          </div>
        </>
      ),
      caption: {
        title: "Un pana que nunca se olvida de anotar.",
        text: "Responde en segundos, de día y de noche, desde el mismo WhatsApp que ya usas todos los días.",
      },
    },
    {
      user: "¿qué sabes hacer?",
      bot: (
        <>
          Anoto cada gasto y cada venta. Me escribes, me mandas una nota de voz o la foto de la
          factura, y yo le pongo la categoría y la tasa BCV del día.
          <br />
          <br />
          También llevo tus cuentas (banco, Binance, Zelle, efectivo), te hago las cuentas en Bs y
          $, divido la cuenta del restaurante y te digo cómo vas en el mes.
        </>
      ),
      caption: {
        title: "Lo que anotabas en el cuaderno, ahora se lo dices a Rocco.",
        text: "Texto, nota de voz o foto. Bolívares, dólares y USDT, cada uno con su tasa.",
      },
    },
    {
      user: "gasté 15$ en champú",
      bot: (
        <>
          <strong>Gasto por confirmar</strong>
          <br />
          Champú: <strong>$15,00</strong>
          <br />
          Bs 12.998,40 · tasa BCV 866,56
          <br />
          Categoría: Cuidado personal · hoy
          <div className="btns">
            <span>Guardar</span>
            <span>Corregir</span>
            <span>Cancelar</span>
          </div>
        </>
      ),
      caption: {
        title: "Nada se guarda sin tu OK.",
        text: "Rocco te muestra el monto, la categoría y la tasa. Guardas, corriges o cancelas con un toque.",
      },
    },
    {
      user: "Guardar",
      bot: <>✅ Guardado. Gastos de hoy: $15,00 (1 registro).</>,
      caption: {
        title: "Y queda anotado, con fecha, tasa y cuenta.",
        text: 'Si te equivocaste, le dices "no, eran 25" y Rocco lo corrige al toque.',
      },
    },
    {
      user: "cuánto es 8000 bs en $",
      bot: (
        <>
          🧮 8.000,00 Bs son <strong>$9,23</strong>
          <br />
          Tasa BCV: Bs 866,56 (vigente hoy).
        </>
      ),
      caption: {
        title: "La calculadora que habla en bolívares.",
        text: "Convierte, suma varios montos y divide la cuenta con la foto de la factura: «yo la pizza, Pedro la hamburguesa».",
      },
    },
    {
      user: "cómo va el mes",
      bot: (
        <>
          <strong>📊 Octubre (1 al 15)</strong>
          <br />
          Ventas: $1.240,00
          <br />
          Gastos: $385,50
          <br />
          Ventas menos gastos: <strong>$854,50</strong>
          <br />
          <br />
          Vas bien. ¡Sigue así!
        </>
      ),
      caption: {
        title: "Siempre sabes cómo vas.",
        text: "El cierre del día, el resumen del mes, tus presupuestos y el saldo de cada cuenta, cuando se lo pidas.",
      },
    },
    {
      user: "¿y mis datos?",
      bot: (
        <>
          Son tuyos. Tu cuenta está separada de las demás, exportas todo a Excel cuando quieras y la
          puedes borrar escribiéndome <strong>eliminar mi cuenta</strong>. Las notas de voz las
          escucho y las descarto: nunca se guardan.
        </>
      ),
      caption: {
        title: "Fiel también con tu privacidad.",
        text: "Nada se comparte, nada se vende. Y tu contador recibe el Excel que siempre te pidió.",
      },
    },
    {
      user: "quiero empezar",
      bot: (
        <>
          ¡Dale! Escríbeme <strong>hola</strong> desde tu WhatsApp y creamos tu cuenta aquí mismo en
          dos minutos. Tienes 14 días gratis para probarme.
          <div className="btns">
            {waUrl ? <span>Escribirle a Rocco</span> : null}
            <span>Crear cuenta en la web</span>
          </div>
        </>
      ),
      caption: {
        title: "Empieza hoy, sin instalar nada.",
        text: "Sin tarjeta. Durante la beta no se cobra, y los primeros 50 tienen precio de fundador.",
      },
    },
  ];
}

const FAQ = [
  {
    q: "¿Quién es Rocco?",
    a: "Rocco es un asistente automático por WhatsApp. Se llama así por el pug de la familia: fiel, siempre contigo y nunca se le olvida nada. No es una persona, pero le escribes como a un pana y él lleva tus cuentas.",
  },
  {
    q: "¿Es para mis finanzas personales o para mi negocio?",
    a: "Para las dos. En lo personal llevas tus gastos, tus cuentas y tus presupuestos. En un negocio, además, las ventas por método de pago, el cierre del día y un empleado que registra desde su número.",
  },
  {
    q: "¿Tengo que instalar algo?",
    a: "No. Rocco es un número de WhatsApp: le escribes hola y creas tu cuenta en el mismo chat. Si prefieres, también la puedes crear en la web. Para ver todo en grande tienes un dashboard.",
  },
  {
    q: "¿Y si la tasa cambia a mitad de día?",
    a: 'Rocco usa la tasa oficial del BCV vigente para la fecha de cada movimiento: lo de ayer va con la de ayer. Si cambiaste USDT a otra tasa, se la dices ("cambié 100 usdt a 970") y tus gastos en Bs salen a esa.',
  },
  {
    q: "¿Mi empleado puede usarlo?",
    a: "Sí, en el plan Negocio. Lo agregas con su número y registra gastos y ventas; los cierres y los totales los ves solo tú.",
  },
  {
    q: "¿Cómo se paga?",
    a: "Pago móvil en bolívares, Zelle o USDT por Binance, desde el mismo chat: escribes renovar y Rocco te dice cuánto. Durante la beta no se cobra y los precios se avisan con 30 días de anticipación.",
  },
];

/** Rocco provisional: un pug sencillo en los colores de la marca, hasta tener el logo final. */
function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#0f7b5f" />
      <path d="M13 24c-1-7 4-11 10-9l-1 12z" fill="#0a3d30" />
      <path d="M51 24c1-7-4-11-10-9l1 12z" fill="#0a3d30" />
      <ellipse cx="32" cy="35" rx="17" ry="15" fill="#f4efe6" />
      <ellipse cx="32" cy="41.5" rx="9.5" ry="7.5" fill="#0a3d30" />
      <circle cx="24.5" cy="31.5" r="3.2" fill="#0a3d30" />
      <circle cx="39.5" cy="31.5" r="3.2" fill="#0a3d30" />
      <circle cx="25.5" cy="30.5" r="1" fill="#fff" />
      <circle cx="40.5" cy="30.5" r="1" fill="#fff" />
      <path
        d="M28.5 44q3.5 2.2 7 0"
        stroke="#f4efe6"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
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
