/**
 * How busy is this server process, in four numbers.
 *
 * 11 October 2026: a page that never touches the database took 0.3 s on some
 * tries and 1.5–2.3 s on others. That points at the process itself — on a
 * half-CPU box, one slow job holds up every request behind it — and nothing
 * the server could say would tell us which. These are the numbers that do:
 *
 *  - loop delay: how long a request waits before Node even looks at it;
 *  - cpu: the share of one CPU the process used since the last reading;
 *  - memory: resident size, because 512 MB is not much;
 *  - pool: connections in use and requests queued for one.
 *
 * Counters, no customer data. Reading resets the window, so each reading
 * describes the time since the one before it.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pool } from '../db/pool.js';

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

let lastCpu = process.cpuUsage();
let lastAt = Date.now();

const ms = (nanoseconds: number): number => Math.round(nanoseconds / 1e4) / 100;

export function readVitals(): Record<string, number> {
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpu);
  const wallMicros = Math.max(1, (now - lastAt) * 1000);
  const reading = {
    windowSeconds: Math.round((now - lastAt) / 1000),
    loopDelayP99Ms: ms(loop.percentile(99)),
    loopDelayMaxMs: ms(loop.max),
    cpuPercentOfOneCpu: Math.round(((cpu.user + cpu.system) / wallMicros) * 100),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    poolInUse: pool.totalCount - pool.idleCount,
    poolWaiting: pool.waitingCount,
  };
  loop.reset();
  lastCpu = process.cpuUsage();
  lastAt = now;
  return reading;
}
