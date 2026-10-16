export type LatestRequestContext = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  commit: (update: () => void) => boolean;
};

type RequestHooks = {
  onStart?: () => void;
  onFinish?: () => void;
  onError?: (error: unknown) => void;
};

export function isRequestCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; name?: string };
  return value.code === "ERR_CANCELED" || value.name === "CanceledError" || value.name === "AbortError";
}

/** One owner per independently replaceable request; dispose it when its view unmounts. */
export function createLatestRequest(hooks: RequestHooks = {}) {
  let active: AbortController | null = null;
  let disposed = false;

  function cancel() {
    const previous = active;
    active = null;
    previous?.abort();
    if (previous && !disposed) hooks.onFinish?.();
  }

  async function run<T>(
    task: (context: LatestRequestContext) => Promise<T>,
    options: { ifIdle?: boolean } = {},
  ): Promise<T | undefined> {
    if (disposed || (options.ifIdle && active)) return undefined;
    cancel();
    const controller = new AbortController();
    active = controller;
    const isCurrent = () => !disposed && active === controller && !controller.signal.aborted;
    const context: LatestRequestContext = {
      signal: controller.signal,
      isCurrent,
      commit(update) {
        if (!isCurrent()) return false;
        update();
        return true;
      },
    };
    try {
      hooks.onStart?.();
      const result = await task(context);
      return isCurrent() ? result : undefined;
    } catch (error) {
      if (isCurrent() && !isRequestCancelled(error)) {
        if (hooks.onError) hooks.onError(error);
        else throw error;
      }
      return undefined;
    } finally {
      if (active === controller) {
        active = null;
        controller.abort();
        if (!disposed) hooks.onFinish?.();
      }
    }
  }

  return {
    run,
    cancel,
    dispose() { disposed = true; cancel(); },
    get pending() { return active !== null; },
  };
}
