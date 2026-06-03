interface DisposableRpcValue {
  [Symbol.dispose]?: () => void;
}

export function disposeRpcResult(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const dispose = (value as DisposableRpcValue)[Symbol.dispose];
  if (typeof dispose === "function") {
    dispose.call(value);
  }
}

export function disposeRpcResultAfterStream<T>(
  stream: ReadableStream<T>,
  result: unknown,
): ReadableStream<T> {
  const reader = stream.getReader();
  let disposed = false;
  let lockReleased = false;

  const releaseLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    reader.releaseLock();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeRpcResult(result);
  };
  const finish = () => {
    releaseLock();
    dispose();
  };

  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}
