import { spawn, execFile, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

export interface Transcript {
  text: string;
  segments: Array<{ start: number; text: string }>;
}

interface Job {
  audioPath: string;
  resolve: (t: Transcript) => void;
  reject: (e: Error) => void;
}

const WORKER_SCRIPT =
  process.env.B24_TRANSCRIBE_SCRIPT ||
  fileURLToPath(new URL("../scripts/transcribe_worker.py", import.meta.url));

const MANAGED_VENV = path.join(os.homedir(), ".cache", "bitrix24-mcp", "whisper-venv");
const MANAGED_PYTHON = path.join(MANAGED_VENV, "bin", "python");

function defaultConcurrency(): number {
  const env = parseInt(process.env.B24_TRANSCRIBE_CONCURRENCY ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  return Math.max(1, Math.floor((os.cpus().length || 4) / 4)); // 8-core → 2, 4-core → 1
}

// Resolve a Python interpreter with faster-whisper available — bootstrapping a managed
// venv on first use so the feature works out of the box (no manual pip/venv steps).
async function canImportFasterWhisper(python: string): Promise<boolean> {
  try {
    await execFileP(python, ["-c", "import faster_whisper"], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function bootstrapPython(): Promise<string> {
  // explicit override wins and is assumed ready
  const override = process.env.B24_TRANSCRIBE_PYTHON;
  if (override) {
    if (await canImportFasterWhisper(override)) return override;
    throw new Error(
      `B24_TRANSCRIBE_PYTHON='${override}' has no faster-whisper. Install it there, or unset the var to let the MCP bootstrap its own venv.`,
    );
  }
  if (existsSync(MANAGED_PYTHON) && (await canImportFasterWhisper(MANAGED_PYTHON))) return MANAGED_PYTHON;

  const base = process.env.B24_BOOTSTRAP_PYTHON || "python3";
  // eslint-disable-next-line no-console
  console.error(`[transcriber] bootstrapping Whisper venv at ${MANAGED_VENV} (one-time)…`);
  if (!existsSync(MANAGED_PYTHON)) {
    await execFileP(base, ["-m", "venv", MANAGED_VENV], { timeout: 120_000 });
  }
  await execFileP(MANAGED_PYTHON, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "faster-whisper"], {
    timeout: 600_000,
  });
  if (!(await canImportFasterWhisper(MANAGED_PYTHON))) {
    throw new Error("bootstrap finished but faster-whisper still not importable");
  }
  // eslint-disable-next-line no-console
  console.error("[transcriber] Whisper venv ready");
  return MANAGED_PYTHON;
}

class Worker {
  proc: ChildProcess;
  ready = false;
  busy = false;
  current: Job | null = null;
  private buf = "";
  private nextId = 1;

  constructor(
    python: string,
    threads: number,
    private onReady: () => void,
    private onIdle: () => void,
    private onDeath: (w: Worker) => void,
  ) {
    this.proc = spawn(python, [WORKER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, B24_WHISPER_CPU_THREADS: String(threads) },
    });
    this.proc.stdout!.on("data", (c: Buffer) => this.onStdout(c.toString()));
    this.proc.stderr!.on("data", (c: Buffer) => {
      const s = c.toString().trim();
      if (s) console.error(`[whisper] ${s}`);
    });
    this.proc.on("exit", () => this.die(new Error("whisper worker exited")));
    this.proc.on("error", (e) => this.die(e));
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: { ready?: boolean; fatal?: string; text?: string; segments?: Transcript["segments"]; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore non-JSON noise
    }
    if (msg.fatal) {
      this.die(new Error(msg.fatal));
      return;
    }
    if (msg.ready) {
      this.ready = true;
      this.onReady();
      return;
    }
    const job = this.current;
    if (!job) return;
    this.current = null;
    this.busy = false;
    if (msg.error) job.reject(new Error(msg.error));
    else job.resolve({ text: msg.text ?? "", segments: msg.segments ?? [] });
    this.onIdle();
  }

  assign(job: Job): void {
    this.busy = true;
    this.current = job;
    this.proc.stdin!.write(JSON.stringify({ id: this.nextId++, path: job.audioPath }) + "\n");
  }

  private die(err: Error): void {
    if (this.current) {
      this.current.reject(err);
      this.current = null;
    }
    this.ready = false;
    this.busy = false;
    this.onDeath(this);
  }
}

// Singleton pool: bounds concurrency to `concurrency` workers regardless of how many
// transcribe requests arrive (e.g. 300 at once just queue and drain N-at-a-time).
class TranscriberPool {
  private concurrency = defaultConcurrency();
  private threads = Math.max(1, Math.floor((os.cpus().length || 4) / this.concurrency));
  private pythonP: Promise<string> | null = null;
  private workers: Worker[] = [];
  private queue: Job[] = [];

  submit(audioPath: string): Promise<Transcript> {
    return new Promise<Transcript>((resolve, reject) => {
      this.queue.push({ audioPath, resolve, reject });
      void this.pump();
    });
  }

  private python(): Promise<string> {
    if (!this.pythonP) {
      this.pythonP = bootstrapPython().catch((e) => {
        this.pythonP = null; // allow retry on a later submit
        throw e;
      });
    }
    return this.pythonP;
  }

  private async pump(): Promise<void> {
    if (!this.queue.length) return;
    let python: string;
    try {
      python = await this.python();
    } catch (e) {
      // bootstrap failed — fail everything currently queued with a clear message
      const err = e instanceof Error ? e : new Error(String(e));
      while (this.queue.length) this.queue.shift()!.reject(err);
      return;
    }
    // dispatch to idle ready workers
    for (const w of this.workers) {
      if (!this.queue.length) break;
      if (w.ready && !w.busy) w.assign(this.queue.shift()!);
    }
    // spawn workers only for work that no existing worker will pick up — never more than
    // are actually needed (busy workers + still-queued jobs), capped at `concurrency`.
    const busy = this.workers.filter((w) => w.busy).length;
    const desired = Math.min(this.concurrency, busy + this.queue.length);
    while (this.workers.length < desired) {
      const w = new Worker(
        python,
        this.threads,
        () => void this.pump(), // onReady
        () => void this.pump(), // onIdle
        (dead) => {
          this.workers = this.workers.filter((x) => x !== dead);
          void this.pump();
        },
      );
      this.workers.push(w);
    }
  }
}

let pool: TranscriberPool | null = null;
export function getTranscriberPool(): TranscriberPool {
  if (!pool) pool = new TranscriberPool();
  return pool;
}
