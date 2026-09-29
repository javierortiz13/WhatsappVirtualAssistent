import { schema } from "@caja/db";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates.js";
import { Decimal } from "../src/domain/money.js";
import { NoRateError, rateFor } from "../src/ledger/rate-for.js";
import { refreshRates } from "../src/rates/refresh.js";
import {
  bcvSource,
  dolarApiSource,
  inferEffectiveDateFromUpdate,
  nextBusinessDay,
  parseBcvHtml,
} from "../src/rates/sources.js";
import { storeRate } from "../src/rates/store.js";

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
    expect(r.effectiveDate).toBe("2026-09-30");
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

  it("rateFor: fin de semana usa la última publicada; sin tasa anterior lanza", async () => {
    const sat = await rateFor(t.db, asIsoDate("2026-10-03"));
    expect(sat.rate.effectiveDate).toBe("2026-10-01");
    expect(sat.usedPriorDay).toBe(true);
    const exact = await rateFor(t.db, asIsoDate("2026-09-30"));
    expect(exact.usedPriorDay).toBe(false);
    expect(exact.rate.value.toFixed(1)).toBe("858.1");
    await expect(rateFor(t.db, asIsoDate("2026-01-01"))).rejects.toThrow(NoRateError);
  });
});
