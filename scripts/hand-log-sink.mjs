#!/usr/bin/env node
/**
 * Receives Hand Lab Recorder output and writes it where an agent can read it.
 *
 *   node scripts/hand-log-sink.mjs [port]      (default 8792)
 *
 * then open the app — from any browser on this machine — with
 * ?handlog=http://127.0.0.1:8792
 *
 * Layout, following optimac's tests/fixtures/clips/<timestamp>/ scheme:
 *
 *   logs/hand-lab-<date>.jsonl         every row, runs or not
 *   logs/clips/<run>/rows.jsonl        a guided run's rows, full landmarks
 *   logs/clips/<run>/frame_NNN.jpg     camera frames at ~5 fps
 *   logs/clips/<run>/manifest.json     { frames: [{ i, cue, stage }] } — truth labels
 *
 * logs/ is gitignored: the frames are of a face, and the repo is public.
 */
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]) || 8792;
const logDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const clipRoot = join(logDir, 'clips');
mkdirSync(clipRoot, { recursive: true });
const dayFile = join(logDir, `hand-lab-${new Date().toISOString().slice(0, 10)}.jsonl`);

// Run ids come from the page; keep them to a filename-safe alphabet.
const safeRun = (run) => (/^[\w-]{1,80}$/.test(run || '') ? run : null);
const manifests = new Map();   // run → frame labels, rewritten as frames land

function clipDir(run) {
    const dir = join(clipRoot, run);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'POST') return res.writeHead(404).end();

    if (url.pathname === '/log') {
        const text = (await readBody(req)).toString('utf8').trimEnd();
        if (text) {
            appendFileSync(dayFile, text + '\n');
            for (const line of text.split('\n')) {
                try {
                    const row = JSON.parse(line);
                    const run = safeRun(row.run);
                    if (run) appendFileSync(join(clipDir(run), 'rows.jsonl'), line + '\n');
                } catch { /* a malformed row is still in the day file */ }
            }
        }
        return res.writeHead(204).end();
    }

    if (url.pathname === '/frame') {
        const run = safeRun(url.searchParams.get('run'));
        const i = Number(url.searchParams.get('i'));
        if (!run || !Number.isInteger(i) || i < 0) return res.writeHead(400).end();
        const dir = clipDir(run);
        writeFileSync(join(dir, `frame_${String(i).padStart(3, '0')}.jpg`), await readBody(req));
        const frames = manifests.get(run) ?? [];
        frames[i] = {
            i,
            cue: url.searchParams.get('cue') || null,
            stage: url.searchParams.get('stage') || null,
        };
        manifests.set(run, frames);
        writeFileSync(join(dir, 'manifest.json'),
            JSON.stringify({ run, fps: 5, frames: frames.filter(Boolean) }, null, 1));
        return res.writeHead(204).end();
    }

    res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => {
    console.log(`hand-log-sink on http://127.0.0.1:${port} → ${logDir}`);
});
