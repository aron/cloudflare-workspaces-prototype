/**
 * Test helper: build a Request with worker-attached identity headers so DO
 * `readIdentity()` succeeds. Mirrors what `withIdentity()` does in production.
 */
import { IDENTITY_HEADERS } from "../src/identity.js";

export interface TestUser {
  userId: string;
  email:  string;
  name:   string;
}

export const ARON: TestUser = { userId: "u-aron", email: "aron@example.com", name: "Aron" };
export const BEA:  TestUser = { userId: "u-bea",  email: "bea@example.com",  name: "Bea"  };

export function asUser(url: string, user: TestUser, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set(IDENTITY_HEADERS.userId, user.userId);
  headers.set(IDENTITY_HEADERS.email,  user.email);
  headers.set(IDENTITY_HEADERS.name,   user.name);
  return new Request(url, { ...init, headers });
}
