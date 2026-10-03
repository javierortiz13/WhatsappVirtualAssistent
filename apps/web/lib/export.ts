import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@caja/core";
import ExcelJS from "exceljs";
import type { ExportRow } from "./queries";

const TYPE: Record<string, string> = { expense: "Gasto", income: "Venta" };
const CHANNEL: Record<string, string> = {
  text: "WhatsApp texto",
  voice: "WhatsApp voz",
  image: "WhatsApp foto",
  dashboard: "Dashboard",
};

export const EXPORT_COLUMNS = [
  "Fecha",
  "Tipo",
  "Categoría",
  "Descripción",
  "Monto",
  "Moneda",
  "Tasa",
  "Equivalente USD",
  "Equivalente Bs",
  "Método",
  "Autor",
  "Canal",
] as const;

/** Una fila por movimiento, columnas de US-E3. Números como números, para que Excel sume. */
export async function buildWorkbook(
  rows: ExportRow[],
  meta: { tenantName: string; from: string; to: string },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Asistente de Caja";
  const ws = wb.addWorksheet("Movimientos", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS.map((header, i) => ({
    header,
    key: `c${i}`,
    width: i === 3 ? 32 : i === 2 || i === 10 ? 22 : 14,
  }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const row = ws.addRow([
      r.businessDate,
      TYPE[r.type] ?? r.type,
      r.categoryName ?? "",
      r.description ?? "",
      Number(r.amount),
      r.currency,
      Number(r.rateValue),
      Number(r.amountUsd),
      Number(r.amountVes),
      PAYMENT_METHOD_LABELS[r.paymentMethod as PaymentMethod] ?? r.paymentMethod,
      r.author,
      CHANNEL[r.sourceChannel] ?? r.sourceChannel,
    ]);
    row.getCell(5).numFmt = "#,##0.00";
    // La tasa lleva hasta 8 decimales: con 2, Monto × Tasa no daba la columna Bs.
    row.getCell(7).numFmt = "#,##0.00######";
    row.getCell(8).numFmt = "#,##0.00";
    row.getCell(9).numFmt = "#,##0.00";
  }
  const info = wb.addWorksheet("Info");
  info.addRow(["Negocio", meta.tenantName]);
  info.addRow(["Desde", meta.from]);
  info.addRow(["Hasta", meta.to]);
  info.addRow(["Movimientos", rows.length]);
  info.addRow(["Generado", new Date().toISOString()]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function exportFilename(tenantName: string, from: string, to: string): string {
  const slug = tenantName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 40);
  return `caja-${slug || "negocio"}-${from}-${to}.xlsx`;
}
