import { describe, expect, it } from "vitest";
import {
  isUsable,
  pagoMovilData,
  parseBank,
  parseIdNumber,
  parsePhone,
} from "../src/domain/pago-movil";

describe("datos de pago móvil", () => {
  it.each([
    ["0102 Banco de Venezuela", "0102", "Banco de Venezuela"],
    ["Banco Venezuela", "0102", "Banco de Venezuela"],
    ["BDV", "0102", "Banco de Venezuela"],
    ["Banesco", "0134", "Banesco"],
    ["0105", "0105", "Mercantil"],
    ["BBVA Provincial", "0108", "Provincial"],
    ["Venezolano de Crédito", "0104", "Venezolano de Crédito"],
    ["Bancamiga 0172", "0172", "Bancamiga"],
    ["Banco Raro", null, "Banco Raro"],
    ["", null, null],
  ])("banco %s → %s", (raw, code, name) => {
    expect(parseBank(raw)).toEqual({ code, name });
  });

  it.each([
    ["0412-302.02.56", "04123020256"],
    ["+58 412 3020256", "04123020256"],
    ["4123020256", "04123020256"],
    ["0414 123 45 67", "04141234567"],
    ["0212-5551234", null],
    ["123", null],
  ])("teléfono %s → %s", (raw, phone) => {
    expect(parsePhone(raw)).toBe(phone);
  });

  it.each([
    ["V-25.871.244", { letter: "V", number: "25871244" }],
    ["C.I 25871244", { letter: "V", number: "25871244" }],
    ["E-81234567", { letter: "E", number: "81234567" }],
    ["J-40123456-7", { letter: "J", number: "401234567" }],
    ["12", null],
  ])("cédula %s", (raw, id) => {
    expect(parseIdNumber(raw)).toEqual(id);
  });

  it("con dos de banco, teléfono y cédula ya sirve", () => {
    const full = pagoMovilData({
      bank: "Banco Venezuela",
      phone: "04123020256",
      id_number: "C.I 25871244",
      holder: " Javier Ortiz ",
    });
    expect(full).toEqual({
      bankCode: "0102",
      bankName: "Banco de Venezuela",
      phone: "04123020256",
      idLetter: "V",
      idNumber: "25871244",
      holder: "Javier Ortiz",
    });
    expect(isUsable(full)).toBe(true);
    expect(isUsable(pagoMovilData({ bank: "", phone: "0412", id_number: "", holder: "X" }))).toBe(
      false,
    );
  });
});
