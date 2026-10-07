"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * Conversación guiada. Dos modos según el ancho:
 * - escritorio (≥ 900 px): el teléfono queda fijo y el scroll "envía" cada mensaje;
 * - teléfono: sin fijar nada ni secuestrar el scroll (en iOS se traba). La persona toca el botón
 *   de enviar con el próximo mensaje ya escrito y la conversación avanza, como en WhatsApp.
 * Con "reducir movimiento" se muestra la conversación completa.
 */
export type Scene = {
  user: string;
  bot: ReactNode;
  caption: { title: string; text: string };
};

const USER_AT = 0.06;
const TYPING_AT = 0.22;
const BOT_AT = 0.52;
type Phase = "idle" | "user" | "typing" | "bot";
const PHASE_FRAC: Record<Phase, number> = {
  idle: 0,
  user: USER_AT,
  typing: TYPING_AT,
  bot: BOT_AT,
};

function useMode(): "scroll" | "tap" | "static" | null {
  const [mode, setMode] = useState<"scroll" | "tap" | "static" | null>(null);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const wide = window.matchMedia("(min-width: 900px)");
    const pick = () => setMode(reduce.matches ? "static" : wide.matches ? "scroll" : "tap");
    pick();
    wide.addEventListener("change", pick);
    reduce.addEventListener("change", pick);
    return () => {
      wide.removeEventListener("change", pick);
      reduce.removeEventListener("change", pick);
    };
  }, []);
  return mode;
}

export function Story({ scenes, children }: { scenes: Scene[]; children?: ReactNode }) {
  const mode = useMode();
  const ref = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(0);
  const [tap, setTap] = useState<{ step: number; phase: Phase }>({ step: 0, phase: "idle" });
  const timers = useRef<number[]>([]);

  // Modo scroll: el progreso dentro del contenedor alto marca la escena.
  useEffect(() => {
    if (mode !== "scroll") return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = el.offsetHeight - window.innerHeight;
      const p = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 1;
      setPos(p * scenes.length);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [mode, scenes.length]);

  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    [],
  );

  // Modo tap: enviar el próximo mensaje y dejar que el bot "escriba".
  const send = useCallback(() => {
    setTap((t) => {
      if (t.phase !== "idle" || t.step >= scenes.length) return t;
      const step = t.step;
      timers.current.push(
        window.setTimeout(() => setTap({ step, phase: "typing" }), 350),
        window.setTimeout(() => setTap({ step, phase: "bot" }), 1250),
        window.setTimeout(() => setTap({ step: step + 1, phase: "idle" }), 1300),
      );
      return { step, phase: "user" };
    });
  }, [scenes.length]);

  const done =
    mode === "static" || (mode === "tap" ? tap.step >= scenes.length : pos >= scenes.length);
  const step =
    mode === "tap"
      ? Math.min(scenes.length - 1, tap.step)
      : Math.min(scenes.length - 1, Math.floor(pos));
  const frac = mode === "tap" ? PHASE_FRAC[tap.phase] : pos - Math.floor(pos);
  const showUser = (i: number) => done || i < step || (i === step && frac >= USER_AT);
  const showTyping = (i: number) => !done && i === step && frac >= TYPING_AT && frac < BOT_AT;
  const showBot = (i: number) => done || i < step || (i === step && frac >= BOT_AT);
  // Cambia cuando aparece o se reemplaza cualquier burbuja (el "escribiendo…" por la respuesta
  // no altera el número de burbujas, por eso no basta con contarlas).
  const visibleKey = scenes
    .map((_, i) => `${showUser(i) ? "u" : ""}${showTyping(i) ? "t" : ""}${showBot(i) ? "b" : ""}`)
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: el chat baja cuando cambian las burbujas visibles.
  useEffect(() => {
    const c = chatRef.current;
    if (!c) return;
    const toBottom = () =>
      c.scrollTo({ top: c.scrollHeight, behavior: mode === "static" ? "auto" : "smooth" });
    toBottom();
    // La burbuja termina de aparecer unos milisegundos después: segundo empujón.
    const t = window.setTimeout(toBottom, 380);
    return () => window.clearTimeout(t);
  }, [visibleKey, mode]);

  const captionIndex = done ? scenes.length - 1 : step;
  const caption = scenes[captionIndex]?.caption;
  const next = done ? null : scenes[mode === "tap" ? tap.step : step]?.user;
  const pending = mode === "tap" ? tap.phase === "idle" : frac < USER_AT;

  return (
    <div
      className={`story ${mode ?? "tap"}`}
      ref={ref}
      style={mode === "scroll" ? { height: `${(scenes.length + 1) * 100}vh` } : undefined}
    >
      <div className="stage">
        <div className="caption" key={captionIndex}>
          <span className="eyebrow">
            {captionIndex + 1} / {scenes.length}
          </span>
          <h2>{caption?.title}</h2>
          <p className="lead">{caption?.text}</p>
        </div>

        <div className="iphone" role="img" aria-label="Conversación de ejemplo con Rocco">
          <span className="side power" />
          <span className="side vol1" />
          <span className="side vol2" />
          <span className="side mute" />
          <div className="screen">
            <div className="island" />
            <div className="status">
              <span>9:41</span>
              <span className="icons">
                <svg viewBox="0 0 18 12" width="17" height="11" aria-hidden="true">
                  <rect x="0" y="8" width="3" height="4" rx="0.8" fill="#fff" />
                  <rect x="5" y="5.5" width="3" height="6.5" rx="0.8" fill="#fff" />
                  <rect x="10" y="3" width="3" height="9" rx="0.8" fill="#fff" />
                  <rect x="15" y="0" width="3" height="12" rx="0.8" fill="#fff" />
                </svg>
                <svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true">
                  <path d="M8 11.2 10.3 8.5a3.3 3.3 0 0 0-4.6 0z" fill="#fff" />
                  <path d="M3.4 6.2a6.6 6.6 0 0 1 9.2 0l1.6-1.8a9 9 0 0 0-12.4 0z" fill="#fff" />
                  <path d="M5.7 8.3a3.4 3.4 0 0 1 4.6 0l1.6-1.8a5.8 5.8 0 0 0-7.8 0z" fill="#fff" />
                </svg>
                <svg viewBox="0 0 27 12" width="27" height="12" aria-hidden="true">
                  <rect
                    x="0.5"
                    y="0.5"
                    width="22"
                    height="11"
                    rx="3"
                    fill="none"
                    stroke="#fff"
                    strokeOpacity="0.45"
                  />
                  <rect x="2" y="2" width="19" height="8" rx="1.8" fill="#fff" />
                  <path d="M24.5 4v4a2 2 0 0 0 0-4z" fill="#fff" fillOpacity="0.45" />
                </svg>
              </span>
            </div>
            <div className="chat-head">
              <span className="back">‹</span>
              <span className="av" aria-hidden="true">
                🐶
              </span>
              <div className="who">
                Rocco
                <small>en línea</small>
              </div>
              <span className="acts">
                <i />
                <i />
              </span>
            </div>
            <div className="chat" ref={chatRef}>
              <div className="daychip">Hoy</div>
              {scenes.map((s, i) => (
                <StoryScene
                  key={s.user}
                  scene={s}
                  user={showUser(i)}
                  typing={showTyping(i)}
                  bot={showBot(i)}
                />
              ))}
            </div>
            <div className="chat-foot">
              <span className={`input${pending && next ? " ready" : ""}`}>
                {pending ? next : ""}
              </span>
              {mode === "tap" ? (
                <button
                  type="button"
                  className={`send${pending && next ? " ready" : ""}`}
                  onClick={send}
                  disabled={!pending || !next}
                  aria-label="Enviar el siguiente mensaje"
                >
                  <SendIcon />
                </button>
              ) : (
                <i className="send-static" />
              )}
            </div>
            <div className="homebar" />
          </div>
        </div>

        {done ? (
          <div className="stage-cta">{children}</div>
        ) : (
          <div className="hint" aria-hidden="true">
            {mode === "tap"
              ? "Toca enviar para seguir la conversación"
              : "Desliza para seguir la conversación"}
          </div>
        )}
      </div>
    </div>
  );
}

function StoryScene({
  scene,
  user,
  typing,
  bot,
}: {
  scene: Scene;
  user: boolean;
  typing: boolean;
  bot: boolean;
}) {
  return (
    <>
      {user ? (
        <div className="msg in live">
          {scene.user}
          <span className="meta">
            9:41 <i className="ticks" />
          </span>
        </div>
      ) : null}
      {typing ? (
        <div className="msg out live typing">
          <i />
          <i />
          <i />
        </div>
      ) : null}
      {bot ? (
        <div className="msg out live">
          {scene.bot}
          <span className="meta">9:41</span>
        </div>
      ) : null}
    </>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true">
      <path d="M2.5 3.3a1 1 0 0 1 1.1-.2l17.6 7.9a1 1 0 0 1 0 1.8L3.6 20.7a1 1 0 0 1-1.4-1.1l1.7-6.1a1 1 0 0 1 .8-.7l8.9-1-8.9-1a1 1 0 0 1-.8-.7L2.2 4.3a1 1 0 0 1 .3-1z" />
    </svg>
  );
}
