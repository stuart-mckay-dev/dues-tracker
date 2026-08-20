import { describe, expect, it } from "vitest";
import { isLocalRequest } from "../../src/middleware/access";

/**
 * The local-development bypass is gated on two independent conditions:
 * DEV_SKIP_ACCESS must be set, AND the request must not have come through
 * Cloudflare's edge. These cover the second one.
 */
describe("isLocalRequest — the dev-bypass gate", () => {
  it("is true for a request with no CF-Ray (a local workerd process)", () => {
    expect(isLocalRequest(new Request("http://localhost:8787/api/bootstrap"))).toBe(true);
  });

  it("is FALSE whenever CF-Ray is present, whatever the hostname", () => {
    // Cloudflare stamps CF-Ray on everything that traverses its edge, and a
    // client cannot suppress it. Its presence means this is a real request.
    const edge = new Request("https://dues.example.com/api/members", {
      headers: { "CF-Ray": "8f2c1a0b1234abcd-SEA" },
    });
    expect(isLocalRequest(edge)).toBe(false);
  });

  it("does NOT rely on the hostname", () => {
    // The regression this replaced: `wrangler dev` presents the configured
    // route hostname to the Worker, so a localhost check broke local dev the
    // moment a route was added to wrangler.toml. A production-looking
    // hostname with no CF-Ray is local; localhost with a CF-Ray is not.
    expect(isLocalRequest(new Request("http://dues.example.com/api/bootstrap"))).toBe(true);
    expect(
      isLocalRequest(
        new Request("http://localhost:8787/api/bootstrap", {
          headers: { "CF-Ray": "8f2c1a0b1234abcd-SEA" },
        }),
      ),
    ).toBe(false);
  });

  it("treats an empty CF-Ray as present, not absent", () => {
    const r = new Request("https://dues.example.com/", { headers: { "CF-Ray": "" } });
    expect(isLocalRequest(r)).toBe(false);
  });
});
