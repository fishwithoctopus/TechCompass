// lib/jobs.js — 极简异步任务表：长耗时分析用 jobId 轮询，避免长连接超时
import { newId } from './store.js';

const JOB_TTL_MS = 30 * 60 * 1000;

export class Jobs {
  constructor() { this.map = new Map(); }

  #prune() {
    const now = Date.now();
    for (const [id, j] of this.map) {
      if ((j.status === 'done' || j.status === 'error') && now - j.createdAt > JOB_TTL_MS) this.map.delete(id);
    }
  }

  create(run) {
    this.#prune();
    const id = newId('job');
    const job = { id, status: 'running', stage: '排队中', result: null, error: null, createdAt: Date.now() };
    this.map.set(id, job);
    const setStage = (stage) => { job.stage = stage; };
    Promise.resolve()
      .then(() => run(setStage))
      .then((result) => { job.status = 'done'; job.result = result ?? null; })
      .catch((err) => { job.status = 'error'; job.error = err?.message || String(err); if (err?.errors) job.errors = err.errors; });
    return id;
  }

  get(id) {
    return this.map.get(id) || null;
  }
}
