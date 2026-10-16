let users = 0;
let maintenance: Promise<void> | undefined;
let finishMaintenance: (() => void) | undefined;

export function cfBrowserMaintenanceStatus(): { users: number; maintaining: boolean } {
  return { users, maintaining: !!maintenance };
}

/** Reserve before launch starts, not only after Chromium has opened a page. */
export async function acquireCfBrowserUse(): Promise<() => void> {
  while (maintenance) await maintenance;
  users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users--;
  };
}

/** An updater must never wait while holding resources a browser needs to close. */
export function tryAcquireCfBrowserMaintenance(): (() => void) | undefined {
  if (maintenance || users > 0) return undefined;
  maintenance = new Promise<void>((resolve) => { finishMaintenance = resolve; });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const finish = finishMaintenance;
    maintenance = undefined;
    finishMaintenance = undefined;
    finish?.();
  };
}
