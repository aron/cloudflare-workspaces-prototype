/**
 * @cloudflare/workspace/container-sandbox
 *
 * Container-side companion to the DO-side `Workspace` class.
 * This module is bundled into a single `dist/container-sandbox.cjs` that
 * consumers COPY into their Docker image and run as a process inside the
 * `@cloudflare/sandbox` container.
 */

import "./server.js";
