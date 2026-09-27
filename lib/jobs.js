// lib/jobs.js — 极简异步任务表：长耗时分析用 jobId 轮询，避免长连接超时
import { newId } from './store.js';

const JOB_TTL_MS = 30 * 60 * 1000;

export class Jobs {
  constructor() { this.map = new Map(); }

  #prune() {
    const now = Date.now();
    for (const [id, j] of this.map) {
      if (j.status !== 'running' && now - j.createdAt > JOB_TTL_MS) this.map.delete(id);
    }
  }

  create(run) {
    this.#prune();
    const id = newId('job');
    const job = { id, status: 'running', stage: '排队中', result: null, error: null, createdAt: Date.now(), controller: new AbortController() };
    this.map.set(id, job);
    const setStage = (stage) => { if (job.status === 'running') job.stage = stage; };
    Promise.resolve()
      .then(() => { job.controller.signal.throwIfAborted(); return run(setStage, job.controller.signal); })
      .then((result) => { if (job.status !== 'running') return; job.status = 'done'; job.result = result ?? null; })
      .catch((err) => { if (job.status !== 'running') return; job.status = 'error'; job.error = err?.message || String(err); if (err?.errors) job.errors = err.errors; });
    return id;
  }

  get(id) {
    return this.map.get(id) || null;
  }

  cancel(id) {
    const job = this.get(id);
    if (job?.status === 'running') {
      job.status = 'cancelled'; job.stage = '已取消';
      job.controller.abort(new Error('分析已取消'));
    }
    return job;
  }
}
