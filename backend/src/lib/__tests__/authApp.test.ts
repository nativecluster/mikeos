import { describe, expect, it } from "vitest";
import {
  ncAppMode,
  ncPersonEmailOf,
  ncPersonNameOf,
  ncPersonOf,
  requestOriginIsAllowed,
  requestOriginIsAppOwn,
} from "../authApp";

const APP = { MIKE_NC_APP: "1", NODE_ENV: "production" } as NodeJS.ProcessEnv;
const OFF = { NODE_ENV: "production", FRONTEND_URL: "https://mike.example.test" } as NodeJS.ProcessEnv;

function headers(values: Record<string, string>) {
  const lower = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return { get: (name: string) => lower[name.toLowerCase()] } as never;
}

describe("NativeCluster app mode", () => {
  it("is on only with MIKE_NC_APP=1", () => {
    expect(ncAppMode(APP)).toBe(true);
    expect(ncAppMode({} as NodeJS.ProcessEnv)).toBe(false);
    expect(ncAppMode({ MIKE_NC_APP: "true" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("reads the NativeCluster person the launcher names, and nothing else", () => {
    expect(ncPersonOf(headers({ "X-NC-Person": "p_3f9a01" }))).toBe("p_3f9a01");
    expect(ncPersonOf(headers({ "X-NC-Person": " p_3f9a01 " }))).toBe("p_3f9a01");
    expect(ncPersonOf(headers({ "X-NC-Person": "" }))).toBe("");
    expect(ncPersonOf(headers({}))).toBe("");
    expect(ncPersonOf(headers({ "X-NC-Person": "lawyer@example.test" }))).toBe("");
    expect(ncPersonOf(headers({ "X-NC-Person": "p_a,p_b" }))).toBe("");
  });

  it("reads the person's email and name when NativeCluster gives them", () => {
    expect(ncPersonEmailOf(headers({ "X-NC-Person-Email": " Alice@Firm.Example " }))).toBe(
      "alice@firm.example",
    );
    expect(ncPersonEmailOf(headers({ "X-NC-Person-Email": "not an email" }))).toBe("");
    expect(ncPersonEmailOf(headers({}))).toBe("");
    expect(ncPersonNameOf(headers({ "X-NC-Person-Name": " Alice Example " }))).toBe("Alice Example");
    expect(ncPersonNameOf(headers({ "X-NC-Person-Name": "x".repeat(300) }))).toHaveLength(200);
    expect(ncPersonNameOf(headers({}))).toBe("");
  });

  it("reads the name the launcher percent-encodes, any script", () => {
    expect(ncPersonNameOf(headers({ "X-NC-Person-Name": encodeURIComponent("Zoë 李") }))).toBe("Zoë 李");
    expect(ncPersonNameOf(headers({ "X-NC-Person-Name": "Ann%20Smith" }))).toBe("Ann Smith");
    // Not encoded by the launcher: kept as it came.
    expect(ncPersonNameOf(headers({ "X-NC-Person-Name": "100% Ann" }))).toBe("100% Ann");
  });
});

describe("the app's own origin", () => {
  it("is the origin whose host is the request's Host, whatever the port", () => {
    expect(requestOriginIsAppOwn("https://127.0.0.1:8493", "127.0.0.1:8493", APP)).toBe(true);
    expect(requestOriginIsAppOwn("https://127.0.0.1:8497", "127.0.0.1:8497", APP)).toBe(true);
  });

  it("refuses another app's port on the same computer, and anything else", () => {
    expect(requestOriginIsAppOwn("https://127.0.0.1:8494", "127.0.0.1:8493", APP)).toBe(false);
    expect(requestOriginIsAppOwn("https://attacker.example", "127.0.0.1:8493", APP)).toBe(false);
    expect(requestOriginIsAppOwn("null", "127.0.0.1:8493", APP)).toBe(false);
    expect(requestOriginIsAppOwn(undefined, "127.0.0.1:8493", APP)).toBe(false);
    expect(requestOriginIsAppOwn("https://127.0.0.1:8493", undefined, APP)).toBe(false);
    expect(requestOriginIsAppOwn("file://127.0.0.1:8493", "127.0.0.1:8493", APP)).toBe(false);
  });

  it("never applies outside app mode", () => {
    expect(requestOriginIsAppOwn("https://127.0.0.1:8493", "127.0.0.1:8493", OFF)).toBe(false);
    expect(requestOriginIsAllowed("https://127.0.0.1:8493", "127.0.0.1:8493", OFF)).toBe(false);
    expect(requestOriginIsAllowed("https://mike.example.test", "anything", OFF)).toBe(true);
  });
});
