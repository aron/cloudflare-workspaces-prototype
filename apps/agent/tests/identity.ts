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

export const VENKMAN: TestUser = { userId: "u-venkman", email: "venkman@example.com", name: "Venkman" };
export const STANTZ:  TestUser = { userId: "u-stantz",  email: "stantz@example.com",  name: "Stantz"  };

export function asUser(url: string, user: TestUser, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set(IDENTITY_HEADERS.userId, user.userId);
  headers.set(IDENTITY_HEADERS.email,  user.email);
  headers.set(IDENTITY_HEADERS.name,   user.name);
  return new Request(url, { ...init, headers });
}
