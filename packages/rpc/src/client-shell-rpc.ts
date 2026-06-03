import type { ExecEvent, ShellRPC } from "./interface.js";
import { disposeRpcResultAfterStream } from "./rpc-lifetime.js";

export function wrapShellRpcResults(remote: ShellRPC): ShellRPC {
  return {
    async exec(input) {
      const result = await remote.exec(input);
      return {
        id: result.id,
        events: disposeRpcResultAfterStream<ExecEvent>(result.events, result),
      };
    },

    async getExec(input) {
      const result = await remote.getExec(input);
      return {
        id: result.id,
        events: disposeRpcResultAfterStream<ExecEvent>(result.events, result),
      };
    },

    killExec(input) {
      return remote.killExec(input);
    },

    disposeExec(input) {
      return remote.disposeExec(input);
    },
  };
}
