#!/usr/bin/env node
/**
 * Live parity check for the three backends.
 *
 * The repository has no committed real session (see NODEJS_BACKEND_REWRITE_PLAN.md §9), so
 * this is the only check that covers real telemetry. Start all three backends on the same
 * machine against the same session, then point this script at them:
 *
 *   python backend:   SERVER_PORT=8012 ...
 *   java backend:     SERVER_PORT=8011 ...
 *   node backend:     SERVER_PORT=8010 node dist/server.js
 *
 *   node tools/parity/live-parity.mjs --session 2026_05_04_....duckdb --lap 1
 *
 * Every response is compared pairwise: Java against Python (the behavioural reference) and
 * Node against both. JSON numbers are compared with an absolute tolerance because the three
 * implementations use different float pipelines; `null` (JSON) and NaN are the same value.
 * Exit code is 1 when any pair differs.
 *
 * Read-only endpoints only: nothing here mutates profiles or sessions.
 */
import process from 'node:process';

const DEFAULTS = {
  python: 'http://127.0.0.1:8012',
  java: 'http://127.0.0.1:8011',
  node: 'http://127.0.0.1:8010',
  profile: 'guest',
  lap: '1',
  tolerance: '1e-6',
  timeout: '120000',
};

const MAX_DIFFS_PER_PAIR = 20;

function usage() {
  return [
    'Usage: node tools/parity/live-parity.mjs --session <file.duckdb> [options]',
    '',
    'Options:',
    '  --session <id>      session file name visible to all backends (required)',
    '  --lap <n>           lap used by /telemetry and /3d-track (default 1)',
    '  --profile <id>      profile_id (default guest)',
    '  --tolerance <n>     absolute numeric tolerance (default 1e-6)',
    '  --timeout <ms>      per-request timeout (default 120000)',
    '  --python <url>      default http://127.0.0.1:8012',
    '  --java <url>        default http://127.0.0.1:8011',
    '  --node <url>        default http://127.0.0.1:8010',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (!(name in DEFAULTS) && name !== 'session') {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    options[name] = value;
  }
  return options;
}

const q = encodeURIComponent;

/** The endpoint matrix, as `(options) => path`. */
const JSON_CHECKS = [
  { name: 'health', path: () => '/health' },
  { name: 'api health', path: () => '/api/v1/health' },
  { name: 'ping', path: () => '/api/v1/ping' },
  { name: 'profiles', path: () => '/api/v1/profiles' },
  { name: 'discord config', path: () => '/api/v1/discord/config' },
  { name: 'steering wheels', path: () => '/api/v1/steering-wheels' },
  { name: 'sessions', path: (o) => `/api/v1/sessions?profile_id=${q(o.profile)}` },
  {
    name: 'lap header',
    path: (o) => `/api/v1/sessions/${q(o.session)}/laps?profile_id=${q(o.profile)}`,
  },
  {
    name: 'telemetry (whole session, 10 Hz)',
    path: (o) => `/api/v1/sessions/${q(o.session)}/telemetry?freq=10&profile_id=${q(o.profile)}`,
  },
  {
    name: 'telemetry (one lap, 60 Hz)',
    path: (o) =>
      `/api/v1/sessions/${q(o.session)}/telemetry?freq=60&lap_id=${q(o.lap)}&profile_id=${q(o.profile)}`,
  },
  {
    name: '3d track',
    path: (o) =>
      `/api/v1/sessions/${q(o.session)}/3d-track?lap=${q(o.lap)}&profile_id=${q(o.profile)}`,
  },
  {
    name: 'setup',
    path: (o) => `/api/v1/sessions/${q(o.session)}/setup?profile_id=${q(o.profile)}`,
  },
];

const TEXT_CHECKS = [
  {
    name: 'setup export (.svm)',
    path: (o) => `/api/v1/sessions/${q(o.session)}/setup/export?profile_id=${q(o.profile)}`,
  },
];

async function requestJson(base, path, timeout) {
  const url = new URL(path, base);
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  if (!response.ok) {
    return { error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `invalid JSON: ${error.message}` };
  }
}

async function requestText(base, path, timeout) {
  const url = new URL(path, base);
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  if (!response.ok) {
    return { error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  }
  return { value: text };
}

/** Collects structural and numeric differences between two JSON values. */
function diffValues(path, left, right, tolerance, out) {
  if (out.length >= MAX_DIFFS_PER_PAIR) return;

  if (typeof left === 'number' && typeof right === 'number') {
    if (Number.isNaN(left) && Number.isNaN(right)) return;
    if (Object.is(left, right)) return;
    if (Math.abs(left - right) <= tolerance) return;
    out.push(`${path}: ${left} != ${right} (Δ=${Math.abs(left - right)})`);
    return;
  }

  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    if (!Object.is(left, right)) {
      out.push(`${path}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
    }
    return;
  }

  if (Array.isArray(left) !== Array.isArray(right)) {
    out.push(`${path}: ${Array.isArray(left) ? 'array' : 'object'} != ${Array.isArray(right) ? 'array' : 'object'}`);
    return;
  }

  if (Array.isArray(left)) {
    if (left.length !== right.length) {
      out.push(`${path}.length: ${left.length} != ${right.length}`);
    }
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length && out.length < MAX_DIFFS_PER_PAIR; i++) {
      diffValues(`${path}[${i}]`, left[i], right[i], tolerance, out);
    }
    return;
  }

  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (out.length >= MAX_DIFFS_PER_PAIR) return;
    if (!(key in left)) {
      out.push(`${path}.${key}: missing on left`);
      continue;
    }
    if (!(key in right)) {
      out.push(`${path}.${key}: missing on right`);
      continue;
    }
    diffValues(`${path}.${key}`, left[key], right[key], tolerance, out);
  }
}

function diffText(left, right) {
  if (left === right) return [];
  let offset = 0;
  while (offset < left.length && offset < right.length && left[offset] === right[offset]) {
    offset++;
  }
  return [
    `first difference at byte ${offset}: ${JSON.stringify(left.slice(offset, offset + 60))} != ${JSON.stringify(right.slice(offset, offset + 60))}`,
  ];
}

function compare(pairs, check, values) {
  let failed = false;
  for (const [leftName, rightName] of pairs) {
    const left = values[leftName];
    const right = values[rightName];
    let differences;
    if (left.error !== undefined || right.error !== undefined) {
      differences = [`${left.error ?? 'ok'} != ${right.error ?? 'ok'}`];
    } else if (typeof left.value === 'string' || typeof right.value === 'string') {
      differences = diffText(String(left.value), String(right.value));
    } else {
      differences = [];
      diffValues('$', left.value, right.value, check.tolerance, differences);
    }

    const label = `${check.name}: ${leftName} vs ${rightName}`;
    if (differences.length === 0) {
      console.log(`  PASS  ${label}`);
    } else {
      failed = true;
      console.log(`  FAIL  ${label}`);
      for (const line of differences) {
        console.log(`          ${line}`);
      }
    }
  }
  return failed;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.session === undefined) {
    console.error(`--session is required\n\n${usage()}`);
    process.exit(2);
  }

  const tolerance = Number(options.tolerance);
  const timeout = Number(options.timeout);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    console.error('--tolerance must be a non-negative number');
    process.exit(2);
  }
  if (!Number.isInteger(timeout) || timeout <= 0) {
    console.error('--timeout must be a positive integer');
    process.exit(2);
  }

  const backends = [
    ['python', options.python],
    ['java', options.java],
    ['node', options.node],
  ];
  const pairs = [
    ['java', 'python'],
    ['node', 'java'],
    ['node', 'python'],
  ];

  console.log(`Session: ${options.session}  profile: ${options.profile}  lap: ${options.lap}`);
  for (const [name, base] of backends) {
    console.log(`  ${name.padEnd(6)} ${base}`);
  }
  console.log(`Tolerance: ${tolerance} (absolute)\n`);

  const reachable = new Map();
  for (const [name, base] of backends) {
    try {
      const health = await requestJson(base, '/health', timeout);
      reachable.set(name, health.error === undefined);
      console.log(`  ${health.error === undefined ? 'UP  ' : 'DOWN'}  ${name} (${base})${health.error ? `: ${health.error}` : ''}`);
    } catch (error) {
      reachable.set(name, false);
      console.log(`  DOWN  ${name} (${base}): ${error.message}`);
    }
  }
  const up = [...reachable].filter(([, ok]) => ok).map(([name]) => name);
  if (up.length < 2) {
    console.error('\nAt least two backends must be reachable to compare anything.');
    process.exit(1);
  }
  console.log('');

  let failed = false;
  const checks = [
    ...JSON_CHECKS.map((check) => ({ ...check, text: false, tolerance })),
    ...TEXT_CHECKS.map((check) => ({ ...check, text: true, tolerance })),
  ];

  for (const check of checks) {
    const path = check.path(options);
    const values = {};
    for (const [name, base] of backends) {
      if (!reachable.get(name)) {
        values[name] = { error: 'unreachable' };
        continue;
      }
      try {
        values[name] = check.text
          ? await requestText(base, path, timeout)
          : await requestJson(base, path, timeout);
      } catch (error) {
        values[name] = { error: error.message };
      }
    }
    if (compare(pairs, check, values)) {
      failed = true;
    }
  }

  console.log('');
  if (failed) {
    console.log('Parity check finished with differences.');
    process.exit(1);
  }
  console.log('Parity check finished: all compared endpoints agree.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
