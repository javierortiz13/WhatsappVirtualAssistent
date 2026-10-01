"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Conversación guiada por el scroll: el teléfono queda fijo y, a medida que la persona baja,
 * "envía" un mensaje y recibe la respuesta. Cada escena es un paso; el progreso sale del scroll
 * (sin librería), con un indicador de "escribiendo" entre el mensaje y la respuesta. Con
 * "reducir movimiento" se muestra la conversación completa, sin fijar nada.
 */
export type Scene = {
  user: string;
  bot: ReactNode;
  caption: { title: string; text: string };
};

const USER_AT = 0.06;
const TYPING_AT = 0.22;
const BOT_AT = 0.52;

export function Story({ scenes, children }: { scenes: Scene[]; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(0);
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setReduce(true);
      setPos(scenes.length);
      return;
    }
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
  }, [scenes.length]);

  // El chat baja solo cuando aparece un mensaje nuevo, como WhatsApp.
  const step = Math.min(scenes.length - 1, Math.floor(pos));
  const frac = pos - Math.floor(pos);
  const showUser = (i: number) => i < step || (i === step && frac >= USER_AT);
  const showTyping = (i: number) => i === step && frac >= TYPING_AT && frac < BOT_AT;
  const showBot = (i: number) => i < step || (i === step && frac >= BOT_AT) || pos >= scenes.length;
  const visibleCount = scenes.reduce(
    (n, _, i) => n + (showUser(i) ? 1 : 0) + (showBot(i) ? 1 : 0) + (showTyping(i) ? 1 : 0),
    0,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: el scroll depende de cuántas burbujas hay.
  useEffect(() => {
    const c = chatRef.current;
    if (!c) return;
    c.scrollTo({ top: c.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [visibleCount, reduce]);

  const captionIndex = Math.min(scenes.length - 1, pos >= scenes.length ? scenes.length - 1 : step);
  const caption = scenes[captionIndex]?.caption;

  return (
    <div
      className={`story${reduce ? " static" : ""}`}
      ref={ref}
      style={reduce ? undefined : { height: `${(scenes.length + 1) * 100}vh` }}
    >
      <div className="stage">
        <div className="caption" key={captionIndex}>
          <span className="eyebrow">
            {captionIndex + 1} / {scenes.length}
          </span>
          <h2>{caption?.title}</h2>
          <p className="lead">{caption?.text}</p>
        </div>
        <div
          className="phone play"
          role="img"
          aria-label="Conversación de ejemplo con el asistente"
        >
          <div className="notch" />
          <div className="screen">
            <div className="chat-head">
              <span className="av">C</span>
              <div>
                Asistente de Caja
                <small>en línea</small>
              </div>
            </div>
            <div className="chat" ref={chatRef}>
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
              <span>{step < scenes.length && frac < USER_AT ? scenes[step]?.user : ""}</span>
              <i />
            </div>
          </div>
        </div>
        {captionIndex === scenes.length - 1 && pos >= scenes.length - 0.5 ? (
          <div className="stage-cta">{children}</div>
        ) : (
          <div className="hint" aria-hidden="true">
            Desliza para seguir la conversación
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
      {user ? <div className="msg in live">{scene.user}</div> : null}
      {typing ? (
        <div className="msg out live typing">
          <i />
          <i />
          <i />
        </div>
      ) : null}
      {bot ? <div className="msg out live">{scene.bot}</div> : null}
    </>
  );
}
