import { describe, expect, it } from "vitest";
import { normalizeSiteUrl } from "@/lib/url";

describe("normalizeSiteUrl", () => {
  it("accepts normal sites and drops trailing slash, query and hash", () => {
    expect(normalizeSiteUrl("https://shop.vercel.app/")).toBe("https://shop.vercel.app");
    expect(normalizeSiteUrl("https://shop.vercel.app/app/?utm=1#top")).toBe("https://shop.vercel.app/app");
    expect(normalizeSiteUrl("  http://example.com  ")).toBe("http://example.com");
  });

  it("adds https when the scheme is missing", () => {
    expect(normalizeSiteUrl("shop.vercel.app")).toBe("https://shop.vercel.app");
  });

  it("rejects non-web schemes, credentials and empty input", () => {
    for (const bad of ["", "   ", "javascript:alert(1)", "ftp://example.com", "file:///etc/passwd", "https://user:pw@example.com"]) {
      expect(normalizeSiteUrl(bad)).toBeUndefined();
    }
    expect(normalizeSiteUrl(null)).toBeUndefined();
    expect(normalizeSiteUrl(undefined)).toBeUndefined();
  });

  it("rejects hosts a GitHub runner could not reach or should not be pointed at", () => {
    for (const bad of [
      "http://localhost:3000",
      "https://app.localhost",
      "http://127.0.0.1",
      "http://10.0.0.5",
      "http://192.168.1.10",
      "http://172.16.0.1",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]",
      "https://intranet",
      "https://box.internal",
    ]) {
      expect(normalizeSiteUrl(bad)).toBeUndefined();
    }
    expect(normalizeSiteUrl("http://172.32.0.1")).toBe("http://172.32.0.1"); // outside the private 172.16/12 range
  });
});
