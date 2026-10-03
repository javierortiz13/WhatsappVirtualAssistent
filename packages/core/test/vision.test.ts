import { describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest } from "../src/agent/llm";
import { Decimal } from "../src/domain/money";
import { createReceiptReader, READ_RECEIPT_TOOL, receiptUserText } from "../src/vision/receipt";

function llmReturning(input: unknown, capture: LlmRequest[] = []): LlmClient {
  return {
    model: "fake-vision",
    async complete(req) {
      capture.push(req);
      return {
        toolCalls: input === null ? [] : [{ id: "r1", name: "read_receipt", input }],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 1500, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "fake-vision",
      };
    },
    costUsd: () => new Decimal("0.0051"),
  };
}

describe("lector de facturas", () => {
  it("manda la imagen con la única herramienta y devuelve la extracción con costo", async () => {
    const reqs: LlmRequest[] = [];
    const reader = createReceiptReader(
      llmReturning(
        {
          is_receipt: true,
          total: "1250.50",
          currency: "VES",
          date: "2026-09-30",
          vendor: "Ferretería El Tornillo",
          line_items_count: 3,
          confidence: 0.92,
        },
        reqs,
      ),
    );
    const r = await reader.read(new Uint8Array([1, 2]), "image/jpeg");
    expect(r.extraction).toMatchObject({ is_receipt: true, total: "1250.50", currency: "VES" });
    expect(r.costUsd).toBe("0.005100");
    const turn = reqs[0]?.turns[0];
    expect(turn && "image" in turn && turn.image?.mimeType).toBe("image/jpeg");
    expect(reqs[0]?.tools.map((t) => t.name)).toEqual([READ_RECEIPT_TOOL.name]);
  });

  it("sin llamada a herramienta o con datos inválidos: no es factura, confianza 0", async () => {
    const none = await createReceiptReader(llmReturning(null)).read(new Uint8Array(1), "image/png");
    expect(none.extraction).toMatchObject({ is_receipt: false, confidence: 0 });
    const bad = await createReceiptReader(llmReturning({ is_receipt: "sí" })).read(
      new Uint8Array(1),
      "image/png",
    );
    expect(bad.extraction.is_receipt).toBe(false);
  });

  it("el texto para el agente no inventa lo que no se leyó", () => {
    const t = receiptUserText({
      is_receipt: true,
      total: "45.00",
      currency: "unknown",
      date: "",
      vendor: "",
      line_items_count: 0,
      confidence: 0.7,
      document_type: "expense",
    });
    expect(t).toContain("total 45.00 (moneda no legible)");
    expect(t).toContain("fecha no legible");
    expect(t).toContain("proveedor no legible");
    expect(t).toContain("draft_expense");
  });

  it("un reporte de ventas va a la venta del día; la leyenda del archivo manda", () => {
    const sales = receiptUserText(
      {
        is_receipt: true,
        total: "115.80",
        currency: "USD",
        date: "2026-09-30",
        vendor: "Jp Car Wash",
        line_items_count: 4,
        confidence: 0.9,
        document_type: "sales",
      },
      "Ventas del día",
    );
    expect(sales).toContain("Reporte de ventas leído por el sistema");
    expect(sales).toContain("draft_income_day_total");
    expect(sales).toContain("emisor Jp Car Wash");
    expect(sales).toContain('El usuario escribió junto al archivo: "Ventas del día"');
  });

  it("el esquema de la herramienta no tiene uniones (modo strict)", async () => {
    const { countUnions } = await import("../src/agent/tools");
    expect(countUnions(READ_RECEIPT_TOOL.inputSchema)).toBe(0);
  });
});
