import assert from "node:assert/strict";
import test from "node:test";
import { csrfProtection } from "./csrf";

function request(
  method: string,
  path: string,
  options: { token?: string; cookie?: string; origin?: string } = {},
) {
  const headers: Record<string, string> = {};
  headers.host = "app.example.test";
  if (options.token) headers["x-csrf-token"] = options.token;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  return {
    method,
    path,
    session: { csrfToken: "session-token" },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as never;
}

function run(req: never) {
  let statusCode = 200;
  let body: unknown;
  let called = false;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as never;
  csrfProtection(req, res, () => {
    called = true;
  });
  return { statusCode, body, called };
}

test("login and setup are CSRF exempt while protected JSON mutations are not", () => {
  assert.equal(run(request("POST", "/auth/login")).called, true);
  assert.equal(run(request("POST", "/auth/setup")).called, true);
  assert.equal(run(request("POST", "/settings")).statusCode, 403);
});

test("JSON and multipart mutations require matching session, cookie, and header", () => {
  const cookie = "investflow_csrf=session-token";
  assert.equal(
    run(request("POST", "/settings", { cookie, token: "wrong" })).statusCode,
    403,
  );
  assert.equal(
    run(request("POST", "/settings", { cookie, token: "session-token" })).called,
    true,
  );
  assert.equal(
    run(request("POST", "/workflows/1/documents", { cookie, token: "session-token" }))
      .called,
    true,
  );
});

test("logout accepts only same-origin recovery or a valid token", () => {
  assert.equal(
    run(request("POST", "/auth/logout")).statusCode,
    403,
  );
  assert.equal(
    run(request("POST", "/auth/logout", { origin: "https://app.example.test" }))
      .called,
    true,
  );
  assert.equal(
    run(
      request("POST", "/auth/logout", {
        origin: "https://app.example.test",
        cookie: "investflow_csrf=session-token",
        token: "session-token",
      }),
    ).called,
    true,
  );
});