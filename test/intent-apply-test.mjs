// Intent apply gauntlet — the deterministic layer under the LLM.
//
// No API, no network: feeds hand-written (schema-shaped) intents through
// step_toolpath_app/modules/intent-apply.js and asserts that every effect
// is something the form itself could have produced — clamped, snapped,
// grounded in known ids — and that everything adjusted or dropped leaves
// a note. Also sanity-checks the schema contract itself (structured-outputs
// constraints) and that the system prompt grounds the model in live state.

import assert from 'node:assert/strict';
import { applyIntent } from '../../step_toolpath_app/modules/intent-apply.js';
import { STEP_INTENT_SCHEMA, buildSystemPrompt, buildParseRequest } from '../intent/step-schema.js';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ✓ ${msg}`); passed++; };

const CTX = {
  featureIds: [1, 2, 3, 7],
  profileId: 7,
  bitOptions: [0.125, 0.25, 0.375, 0.5],
  limits: {
    depthPerPass: { min: 0.01, max: 0.5 },
    feedRate: { min: 10, max: 500 },
    plungeRate: { min: 5, max: 100 },
    rpm: { min: 1000, max: 24000 },
    safeZ: { min: 0.1, max: 2 },
    stockThickness: { min: 0.1, max: 4 },
    chamferWidth: { min: 0.01, max: 0.5 },
    chamferAngle: { min: 15, max: 75 },
  },
};

console.log('[intent-apply] schema contract');
{
  // structured outputs require additionalProperties:false on EVERY object
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `additionalProperties:false missing at ${path}`);
      for (const f of ['minimum', 'maximum', 'minLength', 'maxLength']) {
        assert.ok(!(f in node), `unsupported constraint ${f} at ${path}`);
      }
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(STEP_INTENT_SCHEMA, '$');
  ok(true, 'every object closed, no unsupported numeric/string constraints');
  assert.deepEqual(STEP_INTENT_SCHEMA.required, ['summary', 'actions', 'declined']);
  ok(true, 'top level requires summary + actions + declined');

  const prompt = buildSystemPrompt({
    units: 'in',
    features: [
      { id: 1, type: 'pocket', label: 'Circular Pocket 1', depth: 0.25, selected: true },
      { id: 7, type: 'profile', label: 'Outer profile', depth: 1, selected: true },
    ],
    params: { feedRate: 100 },
    bitOptions: CTX.bitOptions,
    veeBits: [{ angleDeg: 90, diameter: 0.5 }],
    stock: { thickness: 1 },
  });
  ok(prompt.includes('id=1') && prompt.includes('id=7'), 'prompt grounds feature ids');
  ok(prompt.includes('Circular Pocket 1'), 'prompt carries feature labels');
  ok(prompt.includes('declined'), 'prompt states the decline channel');
  ok(prompt.includes('CHAMFER_DEFAULTS') && prompt.includes('PARTIAL FULFILLMENT'),
    'prompt carries chamfer defaults and the partial-fulfillment rule');

  // one request shape for both payers (server proxy and BYO-key browser)
  const req = buildParseRequest('skip the round pocket', { units: 'in', features: [] });
  assert.equal(req.output_config.format.schema, STEP_INTENT_SCHEMA);
  assert.equal(req.messages[0].content, 'skip the round pocket');
  assert.ok(req.model && req.max_tokens > 0 && typeof req.system === 'string');
  ok(true, 'buildParseRequest is the single source of the request shape');
}

console.log('[intent-apply] param clamping & snapping');
{
  const fx = applyIntent({
    actions: [
      { type: 'set_param', name: 'feedRate', value: 9999 },
      { type: 'set_param', name: 'depthPerPass', value: 0.2 },
      { type: 'set_param', name: 'bitDiameter', value: 0.2 },
      { type: 'set_param', name: 'rpm', value: NaN },
      { type: 'set_param', name: 'spindleTorque', value: 5 },
    ],
  }, CTX);
  assert.equal(fx.paramUpdates.feedRate, 500);
  ok(true, 'out-of-range feedRate clamped to max');
  assert.equal(fx.paramUpdates.depthPerPass, 0.2);
  ok(true, 'in-range value passes through untouched');
  assert.equal(fx.paramUpdates.bitDiameter, 0.25);
  ok(true, 'unavailable bit size snapped to nearest option');
  assert.ok(!('rpm' in fx.paramUpdates) && !('spindleTorque' in fx.paramUpdates));
  ok(true, 'NaN value and unknown param dropped');
  assert.equal(fx.notes.length, 4, `expected 4 notes, got: ${fx.notes.join(' | ')}`);
  ok(true, 'every adjustment left a note');
}

console.log('[intent-apply] feature grounding');
{
  const fx = applyIntent({
    actions: [
      { type: 'select_features', ids: [1, 3, 42], selected: false },
      { type: 'select_features', ids: [7], selected: true },
    ],
  }, CTX);
  assert.deepEqual(fx.featureSelections, [
    { id: 1, selected: false }, { id: 3, selected: false }, { id: 7, selected: true },
  ]);
  ok(true, 'known ids applied in order');
  assert.ok(fx.notes.some(n => n.includes('42')));
  ok(true, 'hallucinated id dropped with a note');
}

console.log('[intent-apply] V-bit drawer');
{
  const fx = applyIntent({
    actions: [{ type: 'set_vee_bits', bits: [
      { angleDeg: 90, diameter: 0.5 },
      { angleDeg: 0, diameter: 0.25 },     // invalid angle
      { angleDeg: 60, diameter: -1 },      // invalid diameter
    ] }],
  }, CTX);
  assert.deepEqual(fx.veeBits, [{ angleDeg: 90, diameter: 0.5 }]);
  ok(true, 'invalid V-bit entries filtered');
  assert.ok(fx.notes.length === 1);
  ok(true, 'filtering noted');

  const fx2 = applyIntent({ actions: [] }, CTX);
  assert.equal(fx2.veeBits, null);
  ok(true, 'veeBits null (unchanged) when not mentioned');
}

console.log('[intent-apply] rim chamfer');
{
  const fx = applyIntent({
    actions: [{ type: 'add_rim_chamfer', width: 2, angleDeg: 10 }],
  }, CTX);
  assert.deepEqual(fx.rimChamfers, [{ width: 0.5, angleDeg: 15 }]);
  ok(true, 'width and angle clamped to form limits');

  const fx2 = applyIntent({
    actions: [{ type: 'add_rim_chamfer', width: 0.0625, angleDeg: 45 }],
  }, { ...CTX, profileId: null });
  assert.equal(fx2.rimChamfers.length, 0);
  assert.ok(fx2.notes.some(n => n.includes('profile')));
  ok(true, 'no profile → chamfer refused with a note');
}

console.log('[intent-apply] hostile / empty input');
{
  const fx = applyIntent({
    actions: [{ type: 'drop_table' }, null, { type: 'set_param' }],
  }, CTX);
  assert.equal(Object.keys(fx.paramUpdates).length, 0);
  assert.equal(fx.featureSelections.length, 0);
  ok(true, 'unrecognized and malformed actions all inert');

  const fx2 = applyIntent({ actions: [] }, CTX);
  assert.deepEqual(
    [Object.keys(fx2.paramUpdates).length, fx2.featureSelections.length, fx2.rimChamfers.length, fx2.notes.length],
    [0, 0, 0, 0]);
  ok(true, 'empty intent → empty effects, no notes');

  const fx3 = applyIntent(undefined, CTX);
  assert.equal(fx3.notes.length, 0);
  ok(true, 'missing intent tolerated');
}

console.log(`\n[intent-apply] ALL PASS (${passed} checks)`);
