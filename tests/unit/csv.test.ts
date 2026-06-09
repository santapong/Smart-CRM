import { describe, it, expect } from "vitest";
import { toCsv } from "@/lib/csv";

describe("toCsv", () => {
  it("joins cells with commas and rows with CRLF", () => {
    expect(toCsv([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d\r\n");
  });

  it("quotes cells containing commas", () => {
    expect(toCsv([["Smith, Jane", "x"]])).toBe('"Smith, Jane",x\r\n');
  });

  it("escapes embedded quotes by doubling them", () => {
    expect(toCsv([['She said "hi"']])).toBe('"She said ""hi"""\r\n');
  });

  it("quotes cells containing newlines", () => {
    expect(toCsv([["line1\nline2"]])).toBe('"line1\nline2"\r\n');
  });

  it("renders null and undefined as empty cells", () => {
    expect(toCsv([[null, undefined, "x"]])).toBe(",,x\r\n");
  });
});
