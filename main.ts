// Token Radar's program (Node 22, standard library only).
//
// It reads the sealed snapshot from /input/snapshot.json (or --input
// <file|dir>), scores every pre-token protocol with the model in
// lib/model.ts, writes the ranked board to /output/board.json, and copies
// this repository's dashboard/ and screenshots/ to /output. Last it writes
// /output/dossier.json, the summary the judge reads, with the vendored
// make.fun library.
//
// The dashboard is a static page — no framework, no network:
// dashboard/index.html, dashboard/app.css and dashboard/app.js read
// /output/data.js, which this program writes from the same board. The page
// covers the watchlist, states the model, and gives every protocol a farm
// plan. Change the model, the page or the plan; keep the gate's shape.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_CAP = 64 * 1024;
const SHOT_CAP = { max: 4, max_bytes: 512 * 1024 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A `--name <value>` flag out of the arguments, or the fallback. */
function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf('--' + name);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const prefix = '--' + name + '=';
  const joined = process.argv.find((a) => a.startsWith(prefix));
  return joined === undefined ? fallback : joined.slice(prefix.length);
}

function fail(message: string, code: number): never {
  process.stderr.write('token radar: ' + message + '\n');
  process.exit(code);
}

const given = flag('input', '/input');
const snapPath = given.endsWith('.json') ? given : join(given, 'snapshot.json');
if (!existsSync(snapPath)) {
  fail(
    'no snapshot at ' + snapPath + ': pass --input <snapshot.json|directory> or mount the sealed /input',
    2,
  );
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const problem = boardIssue(board, snapshot);
if (problem !== null) fail('the model wrote a board the gate refuses: ' + problem, 1);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows: board }) + '\n');
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping dot-names, and
    return the names copied. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyDir(join(here, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyDir(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  fail(
    'screenshots/ holds ' + shots.length + ' image' + (shots.length === 1 ? '' : 's') +
      ': hand in 3, the board, a detail view and a filtered view',
    1,
  );
}
for (const name of shots) {
  if (!SHOT_NAME.test(name)) {
    fail('screenshots/' + name + ': a name is letters, digits and . _ -, 1 to 128 characters', 1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: TEXT_CAP,
    screenshots: SHOT_CAP,
    dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
  }),
);

process.stdout.write(
  'token radar: ' + snapshot.protocols.length + ' protocols, ' + snapshot.watchlist.length +
    ' on the watchlist, ' + board.length + ' rows scored (' + radar.early_size + ' early, ' +
    radar.live_size + ' live set aside)\n' +
    'token radar: wrote ' + join(outDir, 'board.json') + ', ' + join(outDir, 'data.js') + ', ' +
    join(outDir, 'dashboard') + ' (3 files), ' + join(outDir, 'screenshots') + ' (' + shots.length +
    ' images) and ' + join(outDir, 'dossier.json') + '\n',
);
