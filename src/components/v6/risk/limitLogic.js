// Pure logic for the limits form. No React, so it can be tested on its own.
//
// Validation runs the engine's real clampRiskConfig instead of a copy of its rules. That
// function silently clamps and reorders, so anything it would change is reported as an
// error: the user must never save one number and get another (gui-design 5.4). The server
// runs the same comparison and has the final say.
import { clampRiskConfig } from '../../../../shared/trading/v6Risk.js';
import { LIMIT_META } from './limitMeta.js';

const EPS = 1e-9;
const round = (v, places) => Number(v.toFixed(places));

/**
 * Display rules (scale, unit, sign, looser) come from the API, because they describe how
 * the engine stores the value. Words and page grouping come from limitMeta: the API's
 * `help` is only a copy of its label, and its groups do not match gui-design 5.4.
 * A key this file has never heard of still renders, from the API alone.
 */
export function fieldMeta(key, apiMeta) {
  const local = LIMIT_META[key] ?? {};
  const api = apiMeta?.[key] ?? {};
  const editable = local.editable !== false && api.editable !== false;
  return {
    scale: 1,
    unit: '',
    step: 1,
    sign: 1,
    ...local,
    ...api,
    label: local.label || api.label || key,
    help: local.help || (api.help !== api.label ? api.help : undefined),
    group: local.group || (editable ? 'advanced' : 'fixed'),
    editable,
  };
}

/** Every field the API reported. A key with no value or no range cannot be edited. */
export function buildFields(data) {
  const keys = Object.keys(data?.config ?? {});
  return keys.map((key) => {
    const meta = fieldMeta(key, data.meta);
    const ceiling = data.ceilings?.[key] ?? null;
    return {
      key,
      meta,
      ceiling,
      value: data.config[key],
      defaultValue: data.defaults?.[key],
      editable: meta.editable && !!ceiling,
    };
  });
}

/** Engine value to the positive number shown in the input. */
export const toInput = (value, meta) => String(round(value * meta.scale, 6));

/** Engine value to display text with its sign and unit: "-5%", "$25", "24 h", "0.7". */
export function formatLimit(value, meta) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const n = round(value * meta.scale, 6);
  const sign = meta.sign === -1 ? '-' : '';
  if (meta.unit === '$') return `${sign}$${n.toLocaleString('en-US')}`;
  return `${sign}${n}${meta.unit ?? ''}`;
}

/** Text in the input to an engine value, or null if it is not a number. */
export function parseInput(text, meta) {
  const raw = String(text).trim();
  // The field shows its own minus sign, so "-5" and "5" both mean the same level.
  const body = meta.sign === -1 ? raw.replace(/^-/, '') : raw;
  if (body === '' || !/^\d*\.?\d+$|^\d+\.$/.test(body)) return null;
  return round(Number(body) / meta.scale, 10);
}

/** 'tighter' | 'looser' | 'changed', from `meta.looser` in engine units. */
export function direction(meta, from, to) {
  if (meta.looser !== 'up' && meta.looser !== 'down') return 'changed';
  const up = to > from;
  return (meta.looser === 'up') === up ? 'looser' : 'tighter';
}

/**
 * Turns drafts into a patch plus field errors.
 * drafts: { key: string }. Only keys that differ from the saved value enter the patch.
 * Returns { patch, changes: [{ key, label, from, to, direction }], errors: { key: text } }.
 */
export function evaluateDrafts(fields, drafts, { loosenBlocked = false } = {}) {
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const patch = {};
  const changes = [];
  const errors = {};

  for (const [key, text] of Object.entries(drafts)) {
    const field = byKey[key];
    if (!field?.editable) continue;
    const { meta, ceiling, value } = field;
    const next = parseInput(text, meta);
    if (next === null) {
      errors[key] = 'Enter a number.';
      continue;
    }
    if (Math.abs(next - value) < EPS) continue;
    if (next < ceiling.min - EPS || next > ceiling.max + EPS) {
      errors[key] = `Allowed ${formatLimit(ceiling.min, meta)} to ${formatLimit(ceiling.max, meta)}.`;
      continue;
    }
    const dir = direction(meta, value, next);
    if (loosenBlocked && dir === 'looser') {
      errors[key] = 'This loosens a limit, which is refused on the quarter-size rung or worse.';
      continue;
    }
    patch[key] = next;
    changes.push({ key, label: meta.label, from: formatLimit(value, meta), to: formatLimit(next, meta), direction: dir });
  }

  const merged = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  Object.assign(merged, patch);
  const clamped = clampRiskConfig(merged);
  for (const field of fields) {
    const { key, meta } = field;
    if (errors[key] || !(key in clamped)) continue;
    if (Math.abs(clamped[key] - merged[key]) < EPS) continue;
    const applied = formatLimit(clamped[key], meta);
    errors[key] = key in patch
      ? `This would really apply as ${applied}, because of a related limit.`
      : `Your other change would move this to ${applied}. Change it too, or undo that change.`;
  }

  return { patch, changes, errors };
}

/** What "Reset to defaults" would change, in the same shape as `changes`. */
export function defaultsDiff(fields) {
  return fields
    .filter((f) => f.editable && typeof f.defaultValue === 'number' && Math.abs(f.defaultValue - f.value) >= EPS)
    .map((f) => ({
      key: f.key,
      label: f.meta.label,
      from: formatLimit(f.value, f.meta),
      to: formatLimit(f.defaultValue, f.meta),
      direction: direction(f.meta, f.value, f.defaultValue),
    }));
}
