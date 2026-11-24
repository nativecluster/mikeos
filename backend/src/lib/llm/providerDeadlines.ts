import type { LanguageModelMiddleware } from "ai" with {
  "resolution-mode": "import",
};
import { abortable } from "../abortable";
import { streamChunkTimeouts } from "../runtimeConfig";

/**
 * How often an untimed call that is still open tells its run it is alive.
 * Well inside the run's idle deadline (STREAM_IDLE_TIMEOUT_MS, 30 s at least).
 */
export const UNTIMED_CALL_HEARTBEAT_MS = 15_000;

/**
 * Bound one provider call, including headers, without timing the SDK's tools.
 *
 * `untimed` is for a provider whose calls wait in a shared line before they
 * start (NativeCluster): no first-chunk or between-chunk deadline applies,
 * and while the call is open its run is told it is alive, so only the
 * person's own Stop (the abort signal) ends it.
 */
export function providerDeadlines(
  onActivity?: () => void,
  options: { untimed?: boolean } = {},
): LanguageModelMiddleware {
  return {
    wrapStream: async ({ model, params }) => {
      const limits = streamChunkTimeouts();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(params.abortSignal?.reason);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (options.untimed && onActivity) {
        // While NativeCluster holds a call in its line it sends only SSE
        // comments, which never reach this stream as parts.
        heartbeat = setInterval(onActivity, UNTIMED_CALL_HEARTBEAT_MS);
        heartbeat.unref?.();
        // A stopped call is not alive, whether or not its stream is read again.
        controller.signal.addEventListener(
          "abort",
          () => clearInterval(heartbeat),
          { once: true },
        );
      }
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        params.abortSignal?.removeEventListener("abort", forwardAbort);
      };
      const arm = (label: string, ms: number) => {
        clearTimeout(timer);
        if (options.untimed) return;
        timer = setTimeout(
          () =>
            controller.abort(
              new DOMException(
                `${label} timeout of ${ms}ms exceeded`,
                "TimeoutError",
              ),
            ),
          ms,
        );
        timer.unref?.();
      };
      if (params.abortSignal?.aborted) forwardAbort();
      else
        params.abortSignal?.addEventListener("abort", forwardAbort, {
          once: true,
        });
      arm("First chunk", limits.firstChunkMs);
      try {
        controller.signal.throwIfAborted();
        const pending = Promise.resolve(
          model.doStream({ ...params, abortSignal: controller.signal }),
        );
        // A non-cooperative provider may resolve after the deadline has fired.
        void pending.then(
          (result) => {
            if (controller.signal.aborted)
              void result.stream.cancel().catch(() => {});
          },
          () => {},
        );
        const result = await abortable(pending, controller.signal);
        const reader = result.stream.getReader();
        return {
          ...result,
          stream: new ReadableStream({
            async pull(sink) {
              try {
                const next = await abortable(reader.read(), controller.signal);
                if (next.done) {
                  cleanup();
                  sink.close();
                  return;
                }
                const part = next.value;
                switch (part.type) {
                  case "text-delta":
                  case "reasoning-delta":
                  case "tool-input-delta":
                  case "tool-call":
                  case "file":
                    arm("Chunk", limits.chunkMs);
                    onActivity?.();
                    break;
                  case "finish":
                  case "error":
                    cleanup();
                    sink.enqueue(part);
                    sink.close();
                    void reader.cancel().catch(() => {});
                    return;
                }
                sink.enqueue(part);
              } catch (error) {
                cleanup();
                void reader.cancel(error).catch(() => {});
                sink.error(error);
              }
            },
            cancel(reason) {
              cleanup();
              controller.abort(reason);
              void reader.cancel(reason).catch(() => {});
            },
          }),
        };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
  };
}
