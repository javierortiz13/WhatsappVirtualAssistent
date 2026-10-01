import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildWorkbook, EXPORT_COLUMNS, exportFilename } from "../lib/export";

describe("exportar a Excel", () => {
  it("una fila por movimiento con las columnas de US-E3 y números como números", async () => {
    const buf = await buildWorkbook(
      [
        {
          businessDate: "2026-09-29",
          type: "expense",
          categoryName: "Insumos de lavado",
          description: "Champú",
          amount: "15.00",
          currency: "USD",
          rateValue: "858.00000000",
          amountUsd: "15.00",
          amountVes: "12870.00",
          paymentMethod: "unspecified",
          author: "Javier",
          sourceChannel: "voice",
        },
        {
          businessDate: "2026-09-29",
          type: "income",
          categoryName: null,
          description: null,
          amount: "85800.00",
          currency: "VES",
          rateValue: "858.00000000",
          amountUsd: "100.00",
          amountVes: "85800.00",
          paymentMethod: "pago_movil",
          author: "+584121234567",
          sourceChannel: "text",
        },
      ],
      { tenantName: "Autolavado El Rápido", from: "2026-09-01", to: "2026-09-30" },
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Movimientos") as ExcelJS.Worksheet;
    expect(ws).toBeDefined();
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual([...EXPORT_COLUMNS]);
    const r2 = (ws.getRow(2).values as unknown[]).slice(1);
    expect(r2).toEqual([
      "2026-09-29",
      "Gasto",
      "Insumos de lavado",
      "Champú",
      15,
      "USD",
      858,
      15,
      12870,
      "Sin especificar",
      "Javier",
      "WhatsApp voz",
    ]);
    const r3 = (ws.getRow(3).values as unknown[]).slice(1);
    expect(r3[1]).toBe("Venta");
    expect(r3[9]).toBe("Pago Móvil");
    expect(ws.rowCount).toBe(3);
    expect(wb.getWorksheet("Info")?.getRow(1).values).toEqual([
      undefined,
      "Negocio",
      "Autolavado El Rápido",
    ]);
  });

  it("nombre de archivo sin acentos ni espacios", () => {
    expect(exportFilename("Autolavado El Rápido", "2026-09-01", "2026-09-30")).toBe(
      "caja-autolavado-el-rapido-2026-09-01-2026-09-30.xlsx",
    );
  });
});
