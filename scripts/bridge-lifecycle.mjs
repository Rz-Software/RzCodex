const EXIT_WITH_PARENT_ARGUMENT = "--exit-with-parent";
const PARENT_EXIT_POLL_INTERVAL_MS = 250;

export function exitWhenParentStops() {
  if (!process.argv.includes(EXIT_WITH_PARENT_ARGUMENT)) return;

  const parentPid = process.ppid;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(timer);
      process.exit(0);
    }
  }, PARENT_EXIT_POLL_INTERVAL_MS);
  timer.unref();
}
