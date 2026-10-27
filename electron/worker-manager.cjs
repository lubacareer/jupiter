/** Manage one utility process without retrying a crash in an automatic loop. */
function createWorkerManager({ spawn, publish, onData }) {
  let current = null;
  let stopped = false;
  let generation = 0;

  function unavailable(message) {
    publish({ status: 'error', timeSeconds: 0, samples: [], workerAvailable: false, workerGeneration: generation, message });
  }

  function startWorker() {
    if (stopped || current) return Boolean(current);
    let child;
    try {
      child = spawn();
      current = child;
      generation += 1;
      child.on('message', (message) => {
        if (stopped || current !== child) return;
        if (message?.type === 'snapshot') publish({ ...message.snapshot, workerAvailable: true, workerGeneration: generation });
        else onData(message);
      });
      child.on('error', () => {
        if (current !== child) return;
        current = null;
        if (!stopped) unavailable('Simulation process failed; in-memory results were lost. Start a new run or load a checkpoint.');
      });
      child.on('exit', (code) => {
        if (current !== child) return;
        current = null;
        if (!stopped) unavailable(`Simulation process exited (${code}); in-memory results were lost. Start a new run or load a checkpoint.`);
      });
      return true;
    } catch (error) {
      current = null;
      if (!stopped) unavailable(`Could not start the simulation process: ${error.message}`);
      return false;
    }
  }

  function send(command, { restart = false } = {}) {
    if (stopped) return false;
    if (!current && !restart) {
      unavailable('Simulation process is unavailable. Start a new run or load a checkpoint.');
      return false;
    }
    if (!current && !startWorker()) return false;
    const child = current;
    try {
      child.postMessage(command);
      return true;
    } catch (error) {
      if (current === child) current = null;
      try { child.kill(); } catch { /* The process may already be gone. */ }
      unavailable(`Simulation process is unavailable; in-memory results were lost: ${error.message}`);
      return false;
    }
  }

  function stop() {
    stopped = true;
    const child = current;
    current = null;
    if (child) {
      try { child.kill(); } catch { /* The process may already be gone. */ }
    }
  }
  return { startWorker, send, stop };
}

module.exports = { createWorkerManager };
