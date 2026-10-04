import { eq, schema } from "@caja/db";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { euroRateFor, NoEurRateError, NoRateError, rateFor } from "../src/ledger/rate-for";
import { getRateInfo } from "../src/rates/current";
import { errorWithCause, refreshRates } from "../src/rates/refresh";
import {
  bcvSource,
  dolarApiSource,
  inferEffectiveDateFromUpdate,
  nextBusinessDay,
  parseBcvHtml,
} from "../src/rates/sources";
import { storeRate } from "../src/rates/store";

const BCV_HTML = `
<html><body>
<div class="view-content">
 <div id="euro"><div class="col-sm-6 col-xs-6"><span> EUR </span></div><div class="col-sm-6 col-xs-6 centrado"><strong> 1.001,23456789 </strong></div></div>
 <div id="dolar"><div class="col-sm-6 col-xs-6"><span> USD </span></div><div class="col-sm-6 col-xs-6 centrado"><strong> 858,12345678 </strong></div></div>
 <div class="pull-right dinpro center"><span class="date-display-single" property="dc:date" datatype="xsd:dateTime" content="2026-09-30T00:00:00-04:00">Miércoles, 30 Septiembre 2026</span></div>
</div></body></html>`;

function fakeFetch(status: number, body: string, contentType = "text/html") {
  return (async () =>
    new Response(body, { status, headers: { "content-type": contentType } })) as typeof fetch;
}

describe("fuente BCV", () => {
  it("parsea tasa con coma y 8 decimales y la fecha valor", () => {
    const r = parseBcvHtml(BCV_HTML);
    expect(r.rate.toFixed(8)).toBe("858.12345678");
    expect(r.rateEur?.toFixed(8)).toBe("1001.23456789");
    expect(r.effectiveDate).toBe("2026-09-30");
    // Sin bloque del euro la tasa del dólar sigue saliendo.
    expect(
      parseBcvHtml(BCV_HTML.replace(/<div id="euro">.*?<\/div><\/div>/s, "")).rateEur,
    ).toBeNull();
  });
  it("tolera comillas simples, &nbsp; y etiquetas dentro del <strong>", () => {
    const html = BCV_HTML.replace('id="dolar"', "id='dolar'").replace(
      "<strong> 858,12345678 </strong>",
      "<strong class='x'>&nbsp;<span> 858,12345678</span></strong>",
    );
    expect(parseBcvHtml(html).rate.toFixed(8)).toBe("858.12345678");
  });
  it("lanza si la página cambió", () => {
    expect(() => parseBcvHtml("<html></html>")).toThrow(/bloque del dólar/);
    expect(() => parseBcvHtml('<div id="dolar"><strong> 858,1 </strong></div>')).toThrow(
      /fecha valor/,
    );
  });
  it("fetch devuelve la tasa con fuente bcv y falla con HTTP no OK", async () => {
    const [r] = await bcvSource(fakeFetch(200, BCV_HTML)).fetch(new Date());
    expect(r).toMatchObject({ source: "bcv", effectiveDate: "2026-09-30" });
    await expect(bcvSource(fakeFetch(503, "")).fetch(new Date())).rejects.toThrow(/HTTP 503/);
  });
});

describe("fuente DolarAPI", () => {
  it("infiere la fecha valor: después de las 15:00 Caracas en día hábil rige el siguiente día hábil", () => {
    // martes 29/09/2026 16:30 Caracas = 20:30Z
    expect(inferEffectiveDateFromUpdate(new Date("2026-09-29T20:30:00Z"))).toBe("2026-09-30");
    // martes 10:00 Caracas = 14:00Z
    expect(inferEffectiveDateFromUpdate(new Date("2026-09-29T14:00:00Z"))).toBe("2026-09-29");
    // viernes 02/10/2026 17:00 Caracas → lunes 05/10
    expect(inferEffectiveDateFromUpdate(new Date("2026-10-02T21:00:00Z"))).toBe("2026-10-05");
    // Visto un sábado (aunque sea antes de las 15:00): es la tasa del viernes, rige el lunes.
    expect(inferEffectiveDateFromUpdate(new Date("2026-10-03T14:00:00Z"))).toBe("2026-10-05");
    expect(nextBusinessDay(asIsoDate("2026-10-03"))).toBe("2026-10-05");
  });
  it("parsea promedio y fechaActualizacion", async () => {
    const body = JSON.stringify({
      fuente: "oficial",
      promedio: 858.5,
      fechaActualizacion: "2026-09-29T20:30:00.000Z",
    });
    const [r] = await dolarApiSource(fakeFetch(200, body, "application/json")).fetch(new Date());
    expect(r).toMatchObject({ source: "dolarapi", effectiveDate: "2026-09-30" });
    expect(r?.rate.toFixed(2)).toBe("858.50");
    await expect(
      dolarApiSource(fakeFetch(200, "{}", "application/json")).fetch(new Date()),
    ).rejects.toThrow(/promedio/);
  });
  it("trae el euro oficial si rige el mismo día; si falla o es de otro día, null", async () => {
    const at = "2026-09-29T20:30:00.000Z";
    const byUrl = (euro: { status: number; body: unknown }) =>
      (async (url: string | URL | Request) => {
        const isEuro = String(url).includes("/euros/");
        const r = isEuro
          ? euro
          : { status: 200, body: { promedio: 858.5, fechaActualizacion: at } };
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
    const [ok] = await dolarApiSource(
      byUrl({ status: 200, body: { promedio: 976.84, fechaActualizacion: at } }),
    ).fetch(new Date());
    expect(ok?.rateEur?.toFixed(2)).toBe("976.84");
    const [down] = await dolarApiSource(byUrl({ status: 503, body: {} })).fetch(new Date());
    expect(down?.rateEur).toBeNull();
    const [stale] = await dolarApiSource(
      byUrl({ status: 200, body: { promedio: 970, fechaActualizacion: "2026-09-28T14:00:00Z" } }),
    ).fetch(new Date());
    expect(stale?.rateEur).toBeNull();
  });
});

describe("storeRate, refreshRates y rateFor", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("inserta, no deja que DolarAPI pise al BCV, y el BCV corrige", async () => {
    const d = asIsoDate("2026-09-30");
    expect(
      await storeRate(t.db, {
        rate: new Decimal("858"),
        effectiveDate: d,
        publishedAt: null,
        source: "dolarapi",
      }),
    ).toBe("inserted");
    expect(
      await storeRate(t.db, {
        rate: new Decimal("858.1"),
        effectiveDate: d,
        publishedAt: null,
        source: "bcv",
      }),
    ).toBe("updated");
    expect(
      await storeRate(t.db, {
        rate: new Decimal("900"),
        effectiveDate: d,
        publishedAt: null,
        source: "dolarapi",
      }),
    ).toBe("kept_bcv");
    expect(
      await storeRate(t.db, {
        rate: new Decimal("858.1"),
        effectiveDate: d,
        publishedAt: null,
        source: "bcv",
      }),
    ).toBe("unchanged");
    const [row] = await t.db.select().from(schema.bcvRate);
    expect(row?.source).toBe("bcv");
    expect(row?.rate).toBe("858.10000000");
    expect(row?.rateEur).toBeNull();
    // El respaldo completa el euro que le falta a la fila del BCV, sin tocar el dólar.
    expect(
      await storeRate(t.db, {
        rate: new Decimal("900"),
        rateEur: new Decimal("976.84"),
        effectiveDate: d,
        publishedAt: null,
        source: "dolarapi",
      }),
    ).toBe("kept_bcv");
    const [filled] = await t.db.select().from(schema.bcvRate);
    expect(filled).toMatchObject({ rate: "858.10000000", rateEur: "976.84000000" });
  });

  it("refreshRates usa el respaldo cuando el BCV falla y reporta si todo falla", async () => {
    const dolar = JSON.stringify({ promedio: 860, fechaActualizacion: "2026-09-30T20:30:00.000Z" });
    const r = await refreshRates({
      db: t.db,
      sources: [
        bcvSource(fakeFetch(500, "")),
        dolarApiSource(fakeFetch(200, dolar, "application/json")),
      ],
    });
    expect(r.source).toBe("dolarapi");
    expect(r.stored[0]).toMatchObject({ effectiveDate: "2026-10-01", outcome: "inserted" });
    expect(r.errors).toHaveLength(1);
    const dead = await refreshRates({
      db: t.db,
      sources: [bcvSource(fakeFetch(500, "")), dolarApiSource(fakeFetch(500, ""))],
    });
    expect(dead.source).toBeNull();
    expect(dead.errors).toHaveLength(2);
  });

  it("euroRateFor: el último euro publicado en o antes del día; sin euro, lanza", async () => {
    // Las pruebas anteriores dejaron euro desde el 30/09; antes de esa fecha no hay.
    await expect(euroRateFor(t.db, asIsoDate("2026-09-20"))).rejects.toBeInstanceOf(NoEurRateError);
    await storeRate(t.db, {
      rate: new Decimal("860.17"),
      rateEur: new Decimal("976.84"),
      effectiveDate: asIsoDate("2026-10-02"),
      publishedAt: null,
      source: "bcv",
    });
    const sat = await euroRateFor(t.db, asIsoDate("2026-10-03"));
    expect(sat.rate).toMatchObject({ source: "bcv_eur", effectiveDate: "2026-10-02" });
    expect(sat.rate.value.toFixed(2)).toBe("976.84");
    expect(sat.usedPriorDay).toBe(true);
    await t.db.delete(schema.bcvRate).where(eq(schema.bcvRate.effectiveDate, "2026-10-02"));
  });

  it("fin de semana: la tasa del lunes ya publicada (Venezuela); sin ella, la del viernes (04/10)", async () => {
    const put = (d: string, r: string, eur: string | null = null) =>
      storeRate(t.db, {
        rate: new Decimal(r),
        rateEur: eur ? new Decimal(eur) : null,
        effectiveDate: asIsoDate(d),
        publishedAt: null,
        source: "bcv",
      });
    await put("2026-10-09", "870", "990"); // viernes
    // Sábado antes de que el BCV publique el lunes: la del viernes.
    expect((await rateFor(t.db, asIsoDate("2026-10-10"))).rate.effectiveDate).toBe("2026-10-09");
    expect((await getRateInfo(t.db, asIsoDate("2026-10-10"))).current?.effectiveDate).toBe(
      "2026-10-09",
    );
    await put("2026-10-12", "875", "995"); // lunes, publicada el viernes
    for (const d of ["2026-10-10", "2026-10-11"]) {
      const r = await rateFor(t.db, asIsoDate(d));
      expect(r.rate.effectiveDate).toBe("2026-10-12");
      expect(r.usedPriorDay).toBe(true);
      expect((await euroRateFor(t.db, asIsoDate(d))).rate.value.toFixed(0)).toBe("995");
    }
    // El viernes sigue con la suya.
    expect((await rateFor(t.db, asIsoDate("2026-10-09"))).rate.value.toFixed(0)).toBe("870");
    const sun = await getRateInfo(t.db, asIsoDate("2026-10-11"));
    expect(sun.current?.effectiveDate).toBe("2026-10-12");
    expect(sun.next).toBeNull();
    const fri = await getRateInfo(t.db, asIsoDate("2026-10-09"));
    expect(fri.current?.effectiveDate).toBe("2026-10-09");
    expect(fri.next?.effectiveDate).toBe("2026-10-12");
    // Feriado entre semana (sin publicación propia): la del próximo día hábil.
    await put("2026-10-14", "880"); // miércoles; el martes 13 fue feriado
    expect((await rateFor(t.db, asIsoDate("2026-10-13"))).rate.effectiveDate).toBe("2026-10-14");
    // Un día hábil con dólar y sin euro no salta al euro de un día después.
    await put("2026-10-15", "885");
    await put("2026-10-16", "890", "1000");
    expect((await euroRateFor(t.db, asIsoDate("2026-10-15"))).rate.value.toFixed(0)).toBe("995");
    for (const d of ["2026-10-09", "2026-10-12", "2026-10-14", "2026-10-15", "2026-10-16"])
      await t.db.delete(schema.bcvRate).where(eq(schema.bcvRate.effectiveDate, d));
  });

  it("rateFor: fin de semana sin el lunes usa la última publicada; sin historia usa la más antigua posterior; sin nada lanza", async () => {
    const sat = await rateFor(t.db, asIsoDate("2026-10-03"));
    expect(sat.rate.effectiveDate).toBe("2026-10-01");
    expect(sat.usedPriorDay).toBe(true);
    const exact = await rateFor(t.db, asIsoDate("2026-09-30"));
    expect(exact.usedPriorDay).toBe(false);
    expect(exact.rate.value.toFixed(1)).toBe("858.1");
    // El sistema es nuevo: una fecha anterior a toda la historia usa la primera tasa conocida.
    const early = await rateFor(t.db, asIsoDate("2026-01-01"));
    expect(early.rate.effectiveDate).toBe("2026-09-30");
    expect(early.usedPriorDay).toBe(true);
    await t.db.delete(schema.bcvRate);
    await expect(rateFor(t.db, asIsoDate("2026-01-01"))).rejects.toThrow(NoRateError);
  });

  it("el error de una fuente lleva la causa de undici", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("unable to verify the first certificate"), {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      }),
    });
    expect(errorWithCause(err)).toBe("fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
    expect(errorWithCause(new Error("HTTP 500"))).toBe("HTTP 500");
  });
});
