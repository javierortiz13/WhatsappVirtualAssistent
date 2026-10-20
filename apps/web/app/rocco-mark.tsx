/**
 * Rocco V1 (dirección B, «Fiel»; aprobado por el fundador el 20/10/2026). Fondo transparente: va
 * sobre el fondo oscuro (`--bg`) o blanco; el borde canela lo sostiene en los dos.
 * Reglas de uso: la marca completa desde 40 px; de 16 a 39 px, el corte pequeño (sin arrugas ni ✓).
 * No se recolorea ni se mete en un cuadro verde. Fuente: agencia, `design/logo-2026-10/final/`.
 */
const KEYLINE = "#9C7446";
const COAT = "#E3C79B";
const INK = "#1E1A17";
const PUPIL = "#0A0706";
const IRIS = "#5A3A22";
const BANDANA = "#0F7B5F";

/** Marca completa, para 40 px o más (por ejemplo, el login a 44 px). */
export function RoccoMark() {
  const head =
    "M320 140C426 140 518 176 530 270C540 352 512 430 460 468C418 498 370 506 320 506C270 506 222 498 180 468C128 430 100 352 110 270C122 176 214 140 320 140Z";
  const earL = "M236 150C196 132 138 136 106 172C90 190 84 218 90 248C116 216 168 182 236 150Z";
  const earR = "M404 150C444 132 502 136 534 172C550 190 556 218 550 248C524 216 472 182 404 150Z";
  return (
    <svg viewBox="56 104 528 528" aria-hidden="true">
      <defs>
        <clipPath id="rocco-mark-head">
          <path d={head} />
        </clipPath>
      </defs>
      <g stroke={KEYLINE} strokeWidth="30" strokeLinejoin="round" fill={KEYLINE}>
        <path d={head} />
        <path d={earL} />
        <path d={earR} />
      </g>
      <path d={head} fill={COAT} />
      <g fill="none" stroke={KEYLINE} strokeWidth="13" strokeLinecap="round">
        <path d="M198 258C220 230 264 226 292 260" />
        <path d="M442 258C420 230 376 226 348 260" />
        <path d="M270 214C280 206 292 203 302 204" />
        <path d="M370 214C360 206 348 203 338 204" />
        <path d="M320 182C324 206 324 238 320 262" />
      </g>
      <path d={earL} fill={INK} />
      <path d={earR} fill={INK} />
      <path
        d="M320 294C338 278 360 270 388 270C426 270 456 300 456 338C456 358 451 373 442 385C454 405 460 430 458 456C454 498 402 514 320 514C238 514 186 498 182 456C180 430 186 405 198 385C189 373 184 358 184 338C184 300 214 270 252 270C280 270 302 278 320 294Z"
        fill={INK}
        clipPath="url(#rocco-mark-head)"
      />
      <circle cx="252" cy="338" r="46" fill={IRIS} />
      <circle cx="252" cy="337" r="36" fill={PUPIL} />
      <circle cx="236" cy="320" r="12.5" fill="#FFFFFF" />
      <circle cx="269" cy="353" r="5.5" fill="#FFFFFF" fillOpacity=".85" />
      <circle cx="388" cy="338" r="46" fill={IRIS} />
      <circle cx="388" cy="337" r="36" fill={PUPIL} />
      <circle cx="372" cy="320" r="12.5" fill="#FFFFFF" />
      <circle cx="405" cy="353" r="5.5" fill="#FFFFFF" fillOpacity=".85" />
      <g fill="none" stroke="#5C4D41" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round">
        <path d="M266 398C294 372 346 372 374 398" />
        <path d="M320 440L320 454" />
        <path d="M298 460C312 462 328 462 342 460" />
      </g>
      <path
        d="M290 410C305 399 335 399 350 410C358 425 345 440 320 440C295 440 282 425 290 410Z"
        fill={PUPIL}
      />
      <path
        d="M308 407C314 404 326 404 332 407"
        fill="none"
        stroke="#3B312A"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path d="M204 496C268 514 372 514 436 496L345 602C332 617 308 617 295 602Z" fill={BANDANA} />
      <path d="M204 496C268 514 372 514 436 496L428 506C366 522 274 522 212 506Z" fill="#0A5B46" />
      <path
        d="M146 446C212 488 428 488 494 446L504 476C438 522 202 522 136 476Z"
        fill={BANDANA}
        stroke={BANDANA}
        strokeWidth="10"
        strokeLinejoin="round"
      />
      <path
        d="M288 534L312 558L356 514"
        fill="none"
        stroke="#3FE0B0"
        strokeWidth="24"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Corte pequeño en una retícula de 32, para 16 a 39 px (encabezado de la landing a 30 px). */
export function RoccoMarkSmall() {
  const head =
    "M16 6.5C22 6.5 26.5 9 27 14C27.5 19.5 25 24 16 25.5C7 24 4.5 19.5 5 14C5.5 9 10 6.5 16 6.5Z";
  const earL = "M12 7C9.5 6 6 6.3 4.2 8.5C3.2 9.7 2.8 11.5 3.2 13.5C5 11.5 8 9 12 7Z";
  const earR = "M20 7C22.5 6 26 6.3 27.8 8.5C28.8 9.7 29.2 11.5 28.8 13.5C27 11.5 24 9 20 7Z";
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <g fill={KEYLINE} stroke={KEYLINE} strokeWidth="2" strokeLinejoin="round">
        <path d={head} />
        <path d={earL} />
        <path d={earR} />
      </g>
      <path d={head} fill={COAT} />
      <path d={earL} fill={INK} />
      <path d={earR} fill={INK} />
      <path
        d="M16 13C17 12 18.5 11.5 20 11.5C22.5 11.5 24 13.3 24 15.5C24 16.6 23.7 17.4 23.2 18C23.8 19.2 24 20.4 24 21.5C24 24 20.5 25.5 16 25.5C11.5 25.5 8 24 8 21.5C8 20.4 8.2 19.2 8.8 18C8.3 17.4 8 16.6 8 15.5C8 13.3 9.5 11.5 12 11.5C13.5 11.5 15 12 16 13Z"
        fill={INK}
      />
      <circle cx="12" cy="15.5" r="2.6" fill={IRIS} />
      <circle cx="20" cy="15.5" r="2.6" fill={IRIS} />
      <circle cx="12" cy="15.5" r="1.7" fill={PUPIL} />
      <circle cx="20" cy="15.5" r="1.7" fill={PUPIL} />
      <rect x="10.5" y="13.5" width="1.5" height="1.5" rx=".4" fill="#FFFFFF" />
      <rect x="18.5" y="13.5" width="1.5" height="1.5" rx=".4" fill="#FFFFFF" />
      <path
        d="M14 19.5C15 19 17 19 18 19.5C18.5 20.5 17.5 21.5 16 21.5C14.5 21.5 13.5 20.5 14 19.5Z"
        fill={PUPIL}
      />
      <path d="M7 23C11 25.5 21 25.5 25 23L25.5 26C21 28.5 11 28.5 6.5 26Z" fill={BANDANA} />
      <path d="M12.5 27L16 30.5L19.5 27Z" fill={BANDANA} />
    </svg>
  );
}
