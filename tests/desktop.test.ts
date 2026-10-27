import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { writeJsonAtomically, makeExport } = require('../electron/files.cjs');
const { createWorkerManager } = require('../electron/worker-manager.cjs');

describe('atomic JSON saves', () => {
  it('replaces the destination only after a successful write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'europa-save-'));
    try {
      const target = path.join(dir, 'checkpoint.json');
      await fs.writeFile(target, 'old');
      await writeJsonAtomically(target, { value: 3 });
      expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ value: 3 });
      expect(await fs.readdir(dir)).toEqual(['checkpoint.json']);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('preserves an existing destination and cleans the temporary file after rename failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'europa-save-'));
    try {
      const target = path.join(dir, 'checkpoint.json');
      await fs.writeFile(target, 'previous data');
      const fileSystem = { ...fs, rename: async () => { throw new Error('rename failed'); } };
      await expect(writeJsonAtomically(target, { value: 3 }, { fileSystem })).rejects.toThrow('rename failed');
      expect(await fs.readFile(target, 'utf8')).toBe('previous data');
      expect(await fs.readdir(dir)).toEqual(['checkpoint.json']);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('flushes file data before closing and renaming the temporary file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'europa-save-'));
    try {
      const target = path.join(dir, 'checkpoint.json');
      const events: string[] = [];
      const fileSystem = {
        ...fs,
        open: async (file: string, flags: string) => {
          const handle = await fs.open(file, flags);
          return {
            writeFile: async (data: string, encoding: BufferEncoding) => { events.push('write'); await handle.writeFile(data, encoding); },
            sync: async () => { events.push('sync'); await handle.sync(); },
            close: async () => { events.push('close'); await handle.close(); },
          };
        },
        rename: async (from: string, to: string) => { events.push('rename'); await fs.rename(from, to); },
      };
      await writeJsonAtomically(target, { value: 3 }, { fileSystem });
      expect(events).toEqual(['write', 'sync', 'close', 'rename']);
      expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({ value: 3 });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('preserves the destination and closes and removes the temporary file when sync fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'europa-save-'));
    try {
      const target = path.join(dir, 'checkpoint.json');
      await fs.writeFile(target, 'previous data');
      const events: string[] = [];
      const fileSystem = {
        ...fs,
        open: async (file: string, flags: string) => {
          const handle = await fs.open(file, flags);
          return {
            writeFile: async (data: string, encoding: BufferEncoding) => { events.push('write'); await handle.writeFile(data, encoding); },
            sync: async () => { events.push('sync'); throw new Error('sync failed'); },
            close: async () => { events.push('close'); await handle.close(); },
          };
        },
        rename: async (from: string, to: string) => { events.push('rename'); await fs.rename(from, to); },
      };
      await expect(writeJsonAtomically(target, { value: 3 }, { fileSystem })).rejects.toThrow('sync failed');
      expect(events).toEqual(['write', 'sync', 'close']);
      expect(await fs.readFile(target, 'utf8')).toBe('previous data');
      expect(await fs.readdir(dir)).toEqual(['checkpoint.json']);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('does not present imported checkpoint provenance as established origin', () => {
    const result = makeExport({ version: 2, provenance: 'imported-unverified', initialOverrides: {}, samples: [] });
    expect(result.schema).toBe('europa-orbit-export-v2');
    expect(result.provenance).toBe('imported-unverified');
    expect(result.provenanceNote).toContain('not verified');
    expect(result.modelConfiguration.referenceEpoch).toBe('2025-01-01 TDB');
    expect(result.epoch).toBeUndefined();
  });
});

class FakeWorker extends EventEmitter {
  messages: unknown[] = [];
  killed = false;
  postMessage(message: unknown) { this.messages.push(message); }
  kill() { this.killed = true; this.emit('exit', 0); }
}

describe('simulation worker manager', () => {
  it('clears a crashed worker and restarts only on an explicit allowed command', () => {
    const workers: FakeWorker[] = [];
    const states: Array<Record<string, unknown>> = [];
    const manager = createWorkerManager({ spawn: () => { const child = new FakeWorker(); workers.push(child); return child; }, publish: (state: Record<string, unknown>) => states.push(state), onData: () => {} });
    manager.startWorker();
    workers[0].emit('message', { type: 'snapshot', snapshot: { status: 'running', samples: [] } });
    expect(states.at(-1)?.workerAvailable).toBe(true);
    expect(states.at(-1)?.workerGeneration).toBe(1);
    workers[0].emit('exit', 1);
    expect(states.at(-1)?.workerAvailable).toBe(false);
    expect(states.at(-1)?.message).toContain('in-memory results were lost');
    expect(manager.send({ type: 'getCheckpoint' })).toBe(false);
    expect(workers).toHaveLength(1);
    expect(manager.send({ type: 'start' }, { restart: true })).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].messages).toEqual([{ type: 'start' }]);
    workers[1].emit('message', { type: 'snapshot', snapshot: { status: 'running' } });
    expect(states.at(-1)?.workerGeneration).toBe(2);
    workers[0].emit('exit', 0);
    workers[0].emit('message', { type: 'snapshot', snapshot: { status: 'running' } });
    expect(manager.send({ type: 'pause' })).toBe(true);
    expect(workers[1].messages).toHaveLength(2);
    manager.stop();
    expect(workers[1].killed).toBe(true);
    const count = states.length;
    expect(manager.send({ type: 'start' }, { restart: true })).toBe(false);
    expect(states).toHaveLength(count);
  });

  it('reports an unexpected successful exit as unavailable and permits a load restart', () => {
    const workers: FakeWorker[] = [];
    const states: Array<Record<string, unknown>> = [];
    const manager = createWorkerManager({ spawn: () => { const child = new FakeWorker(); workers.push(child); return child; }, publish: (state: Record<string, unknown>) => states.push(state), onData: () => {} });
    manager.startWorker();
    workers[0].emit('exit', 0);
    expect(states.at(-1)?.workerAvailable).toBe(false);
    expect(manager.send({ type: 'load', checkpoint: {} }, { restart: true })).toBe(true);
    expect(workers[1].messages).toEqual([{ type: 'load', checkpoint: {} }]);
    manager.stop();
  });

  it('reports fatal worker errors without allowing commands to target that process', () => {
    const child = new FakeWorker();
    const states: Array<Record<string, unknown>> = [];
    const manager = createWorkerManager({ spawn: () => child, publish: (state: Record<string, unknown>) => states.push(state), onData: () => {} });
    manager.startWorker();
    child.emit('error', new Error('fatal'));
    expect(states.at(-1)?.workerAvailable).toBe(false);
    expect(manager.send({ type: 'pause' })).toBe(false);
    expect(child.messages).toHaveLength(0);
    manager.stop();
  });
});
