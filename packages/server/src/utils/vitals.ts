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
import { Session } from 'node:inspector';
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

/*
  Where the CPU time goes, found by sampling rather than guessing.

  The vitals say the process is busy; they cannot say with what. This asks V8
  for eight seconds of samples and reports the functions that held the CPU
  longest — names and file lines only, never a value from a request. A visitor
  can start one at most every minute (an eight-second sample is a small share
  of that), and the answer stays for forty seconds so a second look finds it.
  It was five minutes and ten, and a result kept that long hid the very moment
  being looked for: the load only shows several minutes after a restart.
*/
const PROFILE_SECONDS = 8;
const PROFILE_COOLDOWN_MS = 60_000;
const PROFILE_KEEP_MS = 40_000;

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }
interface CpuProfile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

let profiling = false;
let lastStartedAt = 0;
let lastResult: { finishedAt: number; top: { where: string; ms: number }[] } | null = null;

/** `/app/node_modules/pg/lib/client.js` -> `pg/lib/client.js`; our own code keeps its path. */
function shortPlace(url: string): string {
  const afterModules = url.split('node_modules/').pop() ?? url;
  return afterModules.replace(/^file:\/\//, '').replace(/^.*\/packages\//, 'packages/');
}

function busiestFunctions(profile: CpuProfile): { where: string; ms: number }[] {
  const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
  const microsByPlace = new Map<string, number>();
  profile.samples.forEach((nodeId, index) => {
    const frame = nodeById.get(nodeId)?.callFrame;
    if (!frame) return;
    const name = frame.functionName || '(anonymous)';
    const where = frame.url ? `${name} ${shortPlace(frame.url)}:${frame.lineNumber + 1}` : name;
    microsByPlace.set(where, (microsByPlace.get(where) ?? 0) + (profile.timeDeltas[index] ?? 0));
  });
  return [...microsByPlace.entries()]
    .map(([where, micros]) => ({ where, ms: Math.round(micros / 1000) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 12);
}

/** Start a sample if none is running and the last one is old enough; report what is known. */
export function readCpuProfile(): { state: string; top?: { where: string; ms: number }[] } {
  const now = Date.now();
  if (lastResult && now - lastResult.finishedAt < PROFILE_KEEP_MS) {
    return { state: 'ready', top: lastResult.top };
  }
  if (profiling) return { state: 'sampling' };
  if (now - lastStartedAt < PROFILE_COOLDOWN_MS) return { state: 'resting' };

  profiling = true;
  lastStartedAt = now;
  const session = new Session();
  session.connect();
  session.post('Profiler.enable', () => {
    session.post('Profiler.start', () => {
      setTimeout(() => {
        session.post('Profiler.stop', (err, result) => {
          if (!err && result) {
            lastResult = { finishedAt: Date.now(), top: busiestFunctions(result.profile as unknown as CpuProfile) };
          }
          session.disconnect();
          profiling = false;
        });
      }, PROFILE_SECONDS * 1000);
    });
  });
  return { state: 'started' };
}
