// Live intent-parse smoke test — NOT in npm test (needs a real API key,
// costs a fraction of a cent per run). Exercises the same model call the
// server makes, on a realistic context, and asserts the parse is grounded:
//
//   node test/intent-live-test.mjs ["custom utterance"]
//
// Skips cleanly (exit 0) when /var/opt/apps/.intent.env has no key.

import fs from 'node:fs';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { buildParseRequest } from '../intent/step-schema.js';
import { applyIntent } from '../../step_toolpath_app/modules/intent-apply.js';

const key = (() => {
  try { return fs.readFileSync('/var/opt/apps/.intent.env', 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() || null; }
  catch { return null; }
})();
if (!key) {
  console.log('[intent-live] SKIP — no key in /var/opt/apps/.intent.env');
  process.exit(0);
}

// Test Part V2's real feature set (locked in step-real-test)
const context = {
  units: 'in',
  features: [
    { id: 1, type: 'pocket', label: 'Circular Pocket 1', depth: 0.25, selected: true },
    { id: 2, type: 'pocket', label: 'Pocket 2', depth: 0.25, selected: true },
    { id: 3, type: 'pocket', label: 'Pocket 3', depth: 0.5, openEdges: 3, selected: true },
    { id: 4, type: 'profile', label: 'Outer profile', depth: 1.0, selected: true },
  ],
  params: { bitDiameter: 0.25, depthPerPass: 0.125, feedRate: 100, plungeRate: 30, rpm: 18000, safeZ: 0.5, stockThickness: 1.0 },
  bitOptions: [0.125, 0.25, 0.375, 0.5],
  veeBits: [{ angleDeg: 90, diameter: 0.5 }],
  stock: { thickness: 1.0 },
};

const utterance = process.argv[2] ??
  'use the 1/8 bit, skip the round pocket, put a 45 degree chamfer on the top edge, and add tabs so the part doesn\'t fly out';

const client = new Anthropic({ apiKey: key });
const t0 = Date.now();
const response = await client.messages.create(buildParseRequest(utterance, context));
const intent = JSON.parse(response.content.find(b => b.type === 'text').text);

console.log(`[intent-live] "${utterance}"`);
console.log(`  ${Date.now() - t0}ms, ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
console.log('  summary:', intent.summary);
for (const a of intent.actions) console.log('  action: ', JSON.stringify(a));
for (const d of intent.declined) console.log('  declined:', JSON.stringify(d));

// assertions only for the default utterance
if (!process.argv[2]) {
  const byType = t => intent.actions.filter(a => a.type === t);
  assert.ok(byType('set_param').some(a => a.name === 'bitDiameter' && a.value === 0.125), 'bit → 0.125');
  console.log('  ✓ bit change grounded in BIT_OPTIONS');
  assert.ok(byType('select_features').some(a => a.ids.includes(1) && a.selected === false), 'deselect pocket 1');
  console.log('  ✓ "round pocket" resolved to the circular pocket id');
  assert.ok(byType('add_rim_chamfer').some(a => a.angleDeg === 45), '45° rim chamfer');
  console.log('  ✓ rim chamfer parsed');
  assert.ok(intent.declined.some(d => /tab/i.test(d.request)), 'tabs declined');
  console.log('  ✓ tabs honestly declined (not approximated)');

  const fx = applyIntent(intent, {
    featureIds: context.features.map(f => f.id),
    profileId: 4,
    bitOptions: context.bitOptions,
    limits: {
      depthPerPass: { min: 0.01, max: 0.5 }, feedRate: { min: 10, max: 500 },
      plungeRate: { min: 5, max: 100 }, rpm: { min: 1000, max: 24000 },
      safeZ: { min: 0.1, max: 2 }, stockThickness: { min: 0.1, max: 4 },
      chamferWidth: { min: 0.01, max: 0.5 }, chamferAngle: { min: 15, max: 75 },
    },
  });
  assert.equal(fx.notes.length, 0, `live parse needed no corrections, got: ${fx.notes.join(' | ')}`);
  console.log('  ✓ parse applied cleanly (no clamps, no unknown ids)');
  console.log('\n[intent-live] ALL PASS');
}
