// Bike garage and gearing: the #garage popup (Bikes | Gearing tabs) and its editors. Moved out of js/app.js
// Nov 17 (code-health plan step 4) with no change in behavior. The editors work on `draft`, never on settings;
// picking a bike or gearing writes settings and saves through app.js. Pure logic: js/engine/garage.js,
// drivetrain.js, bikes.js. Shared DOM helpers come from js/ui.js; app.js passes app state and its own hooks in through initGarage().
import { DEFAULT_SETTINGS } from './engine/session.js?v=202611102147';
import { DRIVETRAINS, WHEELS, CUSTOM, checkSpec, presetFor, GEAR_COUNTS, COG_MINS, COG_MAXES, simpleSpec } from './engine/drivetrain.js?v=202611102147';
import { BIKE_TYPES, MATERIALS, BUILDS, BIKE_PRESETS, BIKE_CUSTOM, BIKE_EXACT, MAX_TRAVEL, cleanSpec, presetSpec, estimateBikeKg, bikePresetFor } from './engine/bikes.js?v=202611102147';
import { BIKE_MODELS, MAX_BIKES, MAX_GEARINGS, garageOf, currentBike, selectBike, shiftStyleFor, bikeFromModel, cleanBike, newBikeId, bikeLine, gearingsOf, myGearings, currentGearing, selectGearing, selectPreset, gearingLine, gearingName, cleanGearing } from './engine/garage.js?v=202611102147';
import { logMsg } from './ble/base.js?v=202611102147';
import { ls } from './store.js?v=202611102147';
import { $, $$, esc, toast, fld, placeInk, inkObserver, slideIn } from './ui.js?v=202611102147';

// from app.js, set by initGarage()
let app, numField, saveSettings, ask, syncClient, setDevPop;

// ---- gearing: a known drivetrain, or your own chainrings and cogs
// The menu is "a x b" gears, chainring teeth, smallest and largest cog (the cogs between come from cassette()).
/** The chainrings/cogs in use: the preset's, or the custom ones. */
export function dtSpec(st = app.settings) {
  if (st.drivetrain === CUSTOM) { const r = checkSpec(st.customDrivetrain || {}); if (r.spec) return r.spec; }
  return DRIVETRAINS[st.drivetrain] || DRIVETRAINS[DEFAULT_SETTINGS.drivetrain];
}
function dtSummary(d) {
  if (d.seq) return `Zwift's 24 virtual gears, ratios ${d.seq[0].toFixed(2)} to ${d.seq.at(-1).toFixed(2)}.`;
  const lo = d.rings[0], hi = d.rings.at(-1), big = d.cogs.at(-1), small = d.cogs[0];
  return `Cogs ${d.cogs.join('-')}. Easiest ${lo}×${big}, hardest ${hi}×${small}.`;
}
const cogOpts = (list, cur) => [...new Set([...list, cur])].sort((a, b) => a - b).map((t) => `<option value="${t}">${t}</option>`).join('');
function gearingHtml() {
  return `${fld('set-gears', 'Gears', `<select id="set-gears">${GEAR_COUNTS.map((g) => `<option value="${g}">${g}</option>`).join('')}<option value="zwift">Zwift virtual, 24 gears</option></select>`, '', 'full')}
    <div class="dt-fields">
      ${fld('set-ring1', 'Chainring (teeth)', '<input id="set-ring1" type="number" min="20" max="60" step="1" inputmode="numeric">')}
      ${fld('set-ring2', 'Small ring (teeth)', '<input id="set-ring2" type="number" min="20" max="60" step="1" inputmode="numeric">', '', 'dt-2x')}
      ${fld('set-cmin', 'Smallest cog', '<select id="set-cmin"></select>')}
      ${fld('set-cmax', 'Largest cog', '<select id="set-cmax"></select>')}
    </div>
    <div class="help" id="dt-sum"></div>
    ${fld('set-style', 'Shifting style', '<select id="set-style"></select>')}
    <div class="help" id="style-help"></div>`;
}
/** 1x: which hood the shifter is on. 2x: SRAM or Shimano. Keeps draft.shiftStyle valid for the gearing. */
function fillStyle(d) {
  const one = !d.seq && d.rings.length === 1, el = $('#set-style');
  draft.shiftStyle = shiftStyleFor(draft.shiftStyle, one);
  $('label[for="set-style"]').textContent = one ? 'Shifter side' : 'Shifting style';
  el.innerHTML = one ? '<option value="right">Right</option><option value="left">Left</option>' : '<option value="sram">SRAM</option><option value="shimano">Shimano</option>';
  el.value = draft.shiftStyle;
  el.closest('.fld').classList.toggle('hidden', !!d.seq);
  $('#style-help').textContent = styleHelp(d);
}
function styleHelp(d) {
  if (d.seq) return '';
  if (d.rings.length === 1) { const s = draft.shiftStyle === 'left' ? 'left' : 'right', o = s === 'left' ? 'right' : 'left'; return `1x: ${s} shift-up or paddle = harder, ${s} shift-down = easier. The ${o} side doesn't shift.`; }
  return draft.shiftStyle === 'shimano'
    ? 'Shimano 2x: right buttons = rear harder / easier, left buttons = big / small ring.'
    : 'SRAM 2x: right = harder, left = easier, both together = front shift.';
}
function fillDrivetrain() {
  const d = dtSpec(draft), two = !d.seq && d.rings.length > 1;
  $('#set-gears').value = d.seq ? 'zwift' : `${d.rings.length}x${d.cogs.length}`;
  $('.dt-fields').classList.toggle('hidden', !!d.seq);
  $$('.dt-2x').forEach((el) => el.classList.toggle('hidden', !two));
  if (!d.seq) {
    $('label[for="set-ring1"]').textContent = two ? 'Big ring (teeth)' : 'Chainring (teeth)';
    $('#set-ring1').closest('.fld').classList.toggle('full', !two);
    $('#set-ring1').value = d.rings.at(-1);
    $('#set-ring2').value = two ? d.rings[0] : '';
    $('#set-cmin').innerHTML = cogOpts(COG_MINS, d.cogs[0]);
    $('#set-cmax').innerHTML = cogOpts(COG_MAXES, d.cogs.at(-1));
    $('#set-cmin').value = d.cogs[0];
    $('#set-cmax').value = d.cogs.at(-1);
  }
  $('#dt-sum').textContent = dtSummary(d);
  fillStyle(d);
}
/** Reads the gearing fields. Saves only a valid set; returns false (and says why) otherwise. */
function editDrivetrain(el) {
  const count = $('#set-gears').value;
  if (count === 'zwift') { draft.drivetrain = 'zwift-24'; draft.customDrivetrain = null; fillDrivetrain(); return true; }
  const two = count.startsWith('2');
  let r1 = Number($('#set-ring1').value) || 0, r2 = Number($('#set-ring2').value) || 0;
  if (el?.id === 'set-gears') {
    // coming from Zwift's gears or switching 1x / 2x: start from rings that make sense
    if (!r1) r1 = two ? 50 : 32;
    if (two && !r2) { r2 = Math.max(24, r1 - 16); if (r1 < 44) { r1 = 50; r2 = 34; } }
    $('#set-ring1').value = r1;
    $('#set-ring2').value = two ? r2 : '';
    if ($('#set-cmin').options.length === 0) { $('#set-cmin').innerHTML = cogOpts(COG_MINS, 11); $('#set-cmax').innerHTML = cogOpts(COG_MAXES, 34); $('#set-cmin').value = 11; $('#set-cmax').value = 34; }
    $$('.dt-2x').forEach((x) => x.classList.toggle('hidden', !two));
    $('label[for="set-ring1"]').textContent = two ? 'Big ring (teeth)' : 'Chainring (teeth)';
    $('#set-ring1').closest('.fld').classList.toggle('full', !two);
    $('.dt-fields').classList.remove('hidden');
  }
  const r = simpleSpec({ count, rings: two ? [r1, r2] : [r1], min: $('#set-cmin').value, max: $('#set-cmax').value });
  if (r.error) { $('#dt-sum').textContent = `Not saved yet. ${r.error}`; return false; }
  const id = presetFor(r.spec);
  if (id) draft.drivetrain = id;
  else { draft.drivetrain = CUSTOM; draft.customDrivetrain = r.spec; }
  $('#dt-sum').textContent = dtSummary(r.spec);
  fillStyle(r.spec);
  return true;
}

// ---- bike: a preset or your own spec estimates the weight; or type the weight
function bikeOptions() {
  const build = draft.bikeSpec?.build || 'mid', groups = {};
  for (const [k, p] of Object.entries(BIKE_PRESETS)) (groups[p.group] ||= []).push(`<option value="${k}">${esc(p.name)} \u00b7 ${estimateBikeKg(presetSpec(k, build)).toFixed(1)} kg</option>`);
  return Object.entries(groups).map(([g, o]) => `<optgroup label="${esc(g)}">${o.join('')}</optgroup>`).join('') +
    `<option value="${BIKE_CUSTOM}">Your own spec (type, frame, travel, build)</option><option value="${BIKE_EXACT}">Exact weight (type it)</option>`;
}
const optHtml = (o) => Object.entries(o).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
function bikeHtml() {
  return `${fld('set-bike', 'Weight from', '<select id="set-bike"></select>', '', 'full')}
    <div class="bike-fields">
      ${fld('set-btype', 'Type', `<select id="set-btype">${optHtml(BIKE_TYPES)}</select>`)}
      ${fld('set-bmat', 'Frame', `<select id="set-bmat">${optHtml(MATERIALS)}</select>`)}
      ${fld('set-bfront', 'Fork travel (mm)', `<input id="set-bfront" type="number" step="10" min="0" max="${MAX_TRAVEL}">`, '0 = rigid', 'bike-mtb')}
      ${fld('set-brear', 'Rear travel (mm)', `<input id="set-brear" type="number" step="10" min="0" max="${MAX_TRAVEL}">`, '0 = hardtail', 'bike-mtb')}
      ${fld('set-bbuild', 'Build', `<select id="set-bbuild">${optHtml(BUILDS)}</select>`, '', 'full')}
    </div>
    ${numField(['bikeKg', 'Bike weight (kg)', 0.1])}
    <div class="help" id="bike-sum"></div>`;
}
/** Shows the bike settings. keepWeight: leave the weight field alone (it's being typed in). */
function fillBike(keepWeight = false) {
  const spec = draft.bikeSpec ? cleanSpec(draft.bikeSpec) : null;
  $('#set-bike').innerHTML = bikeOptions();
  $('#set-bike').value = spec ? bikePresetFor(spec) || BIKE_CUSTOM : BIKE_EXACT;
  $('.bike-fields').classList.toggle('hidden', !spec);
  if (!keepWeight) $('#set-bikeKg').value = +draft.bikeKg.toFixed(1);
  if (spec) {
    $('#set-btype').value = spec.type;
    $('#set-bmat').value = spec.material;
    $('#set-bfront').value = spec.front;
    $('#set-brear').value = spec.rear;
    $('#set-bbuild').value = spec.build;
    $$('.bike-mtb').forEach((el) => el.classList.toggle('hidden', BIKE_TYPES[spec.type].fam !== 'mtb'));
  }
  $('#bike-sum').textContent = spec
    ? 'Estimated from frame, suspension and build (size M, no pedals). Type a weight to use your own.'
    : 'Typed weight (with pedals is closest to real). Or pick an estimate above.';
}
function setBikeSpec(spec) {
  draft.bikeSpec = spec && cleanSpec(spec);
  if (spec) draft.bikeKg = estimateBikeKg(spec);
}
function pickBike(id) {
  const cur = draft.bikeSpec;
  if (id === BIKE_EXACT) draft.bikeSpec = null;
  else if (id === BIKE_CUSTOM) setBikeSpec(cur || presetSpec('road-carbon'));
  else setBikeSpec(presetSpec(id, cur?.build));
  fillBike();
}
/** Reads the spec fields. A new type starts from that type's usual travel. */
function editBike(el) {
  const s = {
    type: $('#set-btype').value, material: $('#set-bmat').value, build: $('#set-bbuild').value,
    front: $('#set-bfront').value, rear: $('#set-brear').value,
  };
  if (el.id === 'set-btype') { s.front = BIKE_TYPES[s.type].front; s.rear = BIKE_TYPES[s.type].rear; }
  if ((el.id === 'set-bfront' || el.id === 'set-brear') && el.value === '') return false;
  setBikeSpec(s);
  fillBike();
  return true;
}

// ---- garage (own panel, top-bar bike): saved bikes, each with its weight and wheel (engine/garage.js)
// Three views: the list (tap a bike to ride it), a bike's details (read-only), and "Custom bike" (name, wheel,
// weight; it saves as a new bike). Gearing is its own panel (below). The editors work on `draft`, never on settings.
let draft = null;
let garView = { mode: 'list' };
const wheelName = (w) => WHEELS.reduce((a, b) => (Math.abs(b[0] - w) < Math.abs(a[0] - w) ? b : a))[1];
function shiftText(style, d) {
  if (d.seq) return 'Zwift virtual gears: right harder, left easier';
  if (d.rings.length === 1) { const s = style === 'left' ? 'left' : 'right'; return `1x, shifter on the ${s}: ${s} shift-up or paddle harder, ${s} shift-down easier`; }
  return style === 'shimano' ? 'Shimano 2x: right buttons rear, left buttons big / small ring' : 'SRAM 2x: right harder, left easier, both together = front shift';
}
function weightText(b) {
  if (!b.bikeSpec) return `${b.bikeKg.toFixed(1)} kg`;
  const s = cleanSpec(b.bikeSpec), t = BIKE_TYPES[s.type];
  const travel = t.fam === 'mtb' ? `, ${s.front || 'rigid'}${s.front ? ' mm' : ''} / ${s.rear || 'hardtail'}${s.rear ? ' mm' : ''}` : '';
  return `${b.bikeKg.toFixed(1)} kg, estimated: ${MATERIALS[s.material].name.toLowerCase()} ${t.name.toLowerCase()}${travel}, ${BUILDS[s.build].name.split(' (')[0].toLowerCase()} build`;
}
// Built-in bikes show Agustín's photos (cutouts, rodillo-data garage/<model>.webp). They live in the private repo
// so Canyon's photos stay off the public site: loaded with the sign-in, cached on the device, drawings meanwhile.
const garPhotos = ls.get('garagePhotos', {});
const photoLoading = new Set();
function bikePhoto(model) {
  if (!BIKE_MODELS[model]?.photo) return null;
  if (garPhotos[model]) return garPhotos[model];
  loadBikePhoto(model);
  return null;
}
async function loadBikePhoto(model) {
  const gh = syncClient();
  if (!gh || photoLoading.has(model)) return;
  photoLoading.add(model);
  try {
    const r = await gh.api(`/contents/garage/${model}.webp?ref=${gh.branch}`);
    if (!r?.content) return;
    garPhotos[model] = `data:image/webp;base64,${r.content.replace(/\s/g, '')}`;
    try { ls.set('garagePhotos', garPhotos); } catch { /* storage full: keep it for this visit */ }
    if (!$('#garage').classList.contains('hidden') && garTab === 'bikes' && garView.mode !== 'custom') renderGarage(garView);
  } catch (e) { logMsg('app', `bike photo ${model}: ${e.message}`); }
  finally { photoLoading.delete(model); }
}
const artFor = (b) => {
  const ph = bikePhoto(b.model);
  return ph ? `<img class="bike-photo" src="${ph}" alt="">` : ''; // no photo: name and gearing only, centered
};
function garListHtml() {
  const st = app.settings, g = garageOf(st), cur = currentBike(st);
  const tiles = g.map((b) => {
    const on = cur?.id === b.id;
    return `<div class="gar-tile${on ? ' on' : ''}">
      <button type="button" class="gar-pick" data-bike="${esc(b.id)}" role="radio" aria-checked="${on}" aria-label="Ride the ${esc(b.name)}">
        ${artFor(b)}<span class="gar-name">${esc(b.name)}</span><span class="gar-line">${esc(bikeLine(b))}</span>${on ? '<span class="gar-riding">Riding</span>' : ''}
      </button>
      <button type="button" class="gar-more" data-details="${esc(b.id)}">See details</button>
    </div>`;
  });
  // built-in bikes that were removed can come back
  const have = new Set(g.map((b) => b.model).filter(Boolean));
  const full = g.length >= MAX_BIKES;
  if (!full) for (const [k, m] of Object.entries(BIKE_MODELS)) if (!have.has(k)) {
    const b = bikeFromModel(k);
    tiles.push(`<div class="gar-tile gone"><button type="button" class="gar-pick" data-addmodel="${k}">${artFor(b)}<span class="gar-name">${esc(m.name)}</span><span class="gar-line">Add it back to the garage</span></button></div>`);
  }
  if (!full) tiles.push('<button type="button" class="gar-add" id="gar-custom" aria-label="Custom bike"><span class="gar-plus" aria-hidden="true">+</span><span class="gar-name">Custom bike</span><span class="gar-line">Your own weight and wheel</span></button>');
  return `<div class="gar-grid" role="radiogroup" aria-label="Bikes">${tiles.join('')}</div>
    <div class="help">${cur ? `Riding the ${esc(cur.name)}.` : 'Pick the bike you are riding.'} Slope mode uses its weight and wheel; ERG ignores them.
      Gearing is its own tab: <a href="#" data-open-gearing>${esc(gearingName(st))}</a>.</div>`;
}
function garDetailsHtml(b) {
  const on = app.settings.bike === b.id, m = BIKE_MODELS[b.model];
  const rows = [['Weight', weightText(b)], ['Wheel', wheelName(b.wheel)]];
  if (m) rows.push(['Stock gearing', `${DRIVETRAINS[m.drivetrain].name} (in Gearing as ${m.short})`]);
  if (m?.note) rows.push(['Source', m.note]);
  return `<div class="gar-head"><button type="button" class="ghost small" id="gar-back">Back</button></div>
    ${artFor(b) ? `<div class="gar-hero">${artFor(b)}</div>` : ''}
    <div class="section gar-title">${esc(b.name)}</div>
    <dl class="gar-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="gar-acts">
      ${on ? '<span class="muted">Riding this one</span>' : `<button type="button" class="primary small" data-ride="${esc(b.id)}">Ride this bike</button>`}
      <button type="button" class="small" data-copy="${esc(b.id)}">Custom bike from this one</button>
      <button type="button" class="ghost small" data-remove="${esc(b.id)}">Remove</button>
    </div>`;
}
const wheelOpts = () => WHEELS.map(([w, n]) => `<option value="${w}">${esc(n)}</option>`).join('');
function garCustomHtml() {
  return `<div class="gar-head"><button type="button" class="ghost small" id="gar-back">Cancel</button></div>
    <div class="section gar-title">Custom bike</div>
    ${fld('set-gname', 'Name', `<input id="set-gname" type="text" maxlength="40" autocomplete="off" value="${esc(draft.name)}">`, '', 'full')}
    ${fld('set-wheel', 'Wheel', `<select id="set-wheel">${wheelOpts()}</select>`, 'Bigger wheels go further per pedal turn, so every gear feels a bit harder.', 'full')}
    <div class="section">Weight</div>
    ${bikeHtml()}
    <div class="gar-acts"><button type="button" class="primary" id="gar-save">Save as new bike</button><span class="help" id="gar-err"></span></div>`;
}
function renderGarage(view = garView) {
  garView = view;
  const f = $('#garage-form');
  const b = view.id && garageOf(app.settings).find((x) => x.id === view.id);
  if (view.mode === 'details' && b) f.innerHTML = garDetailsHtml(b);
  else if (view.mode === 'custom' && draft) { f.innerHTML = garCustomHtml(); $('#set-wheel').value = closestWheel(draft.wheel); fillBike(); }
  else { garView = { mode: 'list' }; f.innerHTML = garListHtml(); }
  $('#garage').scrollTop = 0;
}
const closestWheel = (w) => WHEELS.reduce((a, b) => (Math.abs(b[0] - w) < Math.abs(a[0] - w) ? b : a))[0];
/** Opens "Custom bike", starting from a bike (or the one in use). */
function startCustom(from) {
  const g = garageOf(app.settings);
  const src = from || currentBike(app.settings) || { bikeKg: app.settings.bikeKg, bikeSpec: app.settings.bikeSpec, wheel: app.settings.wheelCirc };
  const base = 'My bike';
  draft = { name: g.some((x) => x.name === base) ? `${base} ${g.length + 1}` : base,
    bikeKg: src.bikeKg ?? DEFAULT_SETTINGS.bikeKg, bikeSpec: src.bikeSpec || null, wheel: closestWheel(src.wheel || DEFAULT_SETTINGS.wheelCirc) };
  renderGarage({ mode: 'custom' });
  $('#set-gname').focus(); $('#set-gname').select();
}
function saveCustom() {
  const name = $('#set-gname').value.trim();
  if (!name) { $('#gar-err').textContent = 'Give it a name.'; $('#set-gname').focus(); return; }
  const g = garageOf(app.settings);
  const b = cleanBike({ id: newBikeId(g), name, bikeKg: draft.bikeKg, bikeSpec: draft.bikeSpec, wheel: draft.wheel });
  if (!b) return;
  app.settings.garage = [...g, b];
  Object.assign(app.settings, selectBike(app.settings, b.id));
  draft = null;
  saveSettings();
  renderGarage({ mode: 'list' });
  toast(`${name} saved and in use`);
}
async function removeGarageBike(id) {
  const b = garageOf(app.settings).find((x) => x.id === id);
  if (!b) return;
  if (!await ask(`Remove ${b.name} from the garage?`, { title: 'Remove bike', ok: 'Remove', danger: true })) return;
  app.settings.garage = garageOf(app.settings).filter((x) => x.id !== id);
  if (app.settings.bike === id) app.settings.bike = ''; // weight and wheel stay as they are until another bike is picked
  saveSettings();
  renderGarage({ mode: 'list' });
}

// ---- gearing (the Garage's second tab, Nov 12): what the shifters shift through. Its own choice since
// Nov 12 (Agustín: "the user might want to switch gearing mid ride"), so it opens from the pause screen too and
// applies at once: mid-ride you land on the gear closest to the one you were in. Two views: the list (tiles for
// the built-ins and your own gearings, every preset in a menu, shifting for the one in use) and "New gearing".
let gearView = 'list';
/** Every choice for a select: built-in and own gearings, then the presets. v = "g:<id>" or "p:<preset id>". */
function gearOptions(st = app.settings) {
  const cur = currentGearing(st);
  const out = gearingsOf(st).map((g) => ({ v: `g:${g.id}`, label: `${g.name} (${gearingLine(g)})`, group: g.builtin ? 'Built in' : 'Yours', on: cur?.id === g.id }));
  for (const [id, d] of Object.entries(DRIVETRAINS)) if (!d.seq) out.push({ v: `p:${id}`, label: d.name, group: d.group, on: !cur && st.drivetrain === id });
  if (!out.some((o) => o.on) && st.drivetrain === CUSTOM) out.unshift({ v: 'cur', label: `${gearingName(st)} (${gearingLine(st)})`, group: 'In use', on: true });
  return out;
}
function gearOptionsHtml(opts) {
  const groups = {};
  for (const o of opts) (groups[o.group] ||= []).push(`<option value="${esc(o.v)}">${esc(o.label)}</option>`);
  return Object.entries(groups).map(([g, o]) => `<optgroup label="${esc(g)}">${o.join('')}</optgroup>`).join('');
}
/** Puts a choice from gearOptions() in use (settings only; the caller saves). */
function applyGearOption(v) {
  if (v.startsWith('g:')) Object.assign(app.settings, selectGearing(app.settings, v.slice(2)));
  else if (v.startsWith('p:')) Object.assign(app.settings, selectPreset(app.settings, v.slice(2)));
}
function useGearing(v) {
  applyGearOption(v);
  saveSettings();
  renderGearing('list');
  const s = app.session;
  if (s && !s.finished && app.screen === 'ride') toast(`${gearingName(app.settings)}: in ${s.gb.seq ? `gear ${s.gb.label}` : s.gb.label.replace('x', '\u00d7')}`);
}
function gearListHtml() {
  const st = app.settings, cur = currentGearing(st), d = dtSpec(st), mine = myGearings(st);
  const tiles = gearingsOf(st).map((g) => {
    const on = cur?.id === g.id;
    return `<div class="gar-tile gear-tile${on ? ' on' : ''}">
      <button type="button" class="gar-pick" data-gear="${esc(g.id)}" role="radio" aria-checked="${on}" aria-label="Use ${esc(g.name)}">
        <span class="gar-name">${esc(g.name)}</span><span class="gar-line">${esc(gearingLine(g))}</span>${on ? '<span class="gar-riding">In use</span>' : ''}
      </button>
      ${g.builtin ? '' : `<button type="button" class="gar-more" data-gremove="${esc(g.id)}">Remove</button>`}
    </div>`;
  });
  if (mine.length < MAX_GEARINGS) tiles.push('<button type="button" class="gar-add gear-tile" id="gear-new" aria-label="New gearing"><span class="gar-plus" aria-hidden="true">+</span><span class="gar-name">New gearing</span><span class="gar-line">Your own rings and cogs</span></button>');
  const one = !d.seq && d.rings.length === 1, style = shiftStyleFor(st.shiftStyle, one);
  return `<div class="gar-grid gear-grid" role="radiogroup" aria-label="Gearings">${tiles.join('')}</div>
    ${fld('gear-all', 'All gearings', `<select id="gear-all">${gearOptionsHtml(gearOptions(st))}</select>`, '', 'full')}
    ${d.seq ? '' : fld('gear-style', one ? 'Shifter side' : 'Shifting style', `<select id="gear-style">${one ? '<option value="right">Right</option><option value="left">Left</option>' : '<option value="sram">SRAM</option><option value="shimano">Shimano</option>'}</select>`, esc(shiftText(style, d)), 'full')}
    <div class="help">${esc(dtSummary(d))} Changes apply right away, mid-ride too: you land on the closest gear.${d.seq ? " Zwift's virtual gears feel the same on every bike." : ''}</div>`;
}
function gearNewHtml() {
  return `<div class="gar-head"><button type="button" class="ghost small" id="gear-back">Cancel</button></div>
    <div class="section gar-title">New gearing</div>
    ${fld('set-gname', 'Name', `<input id="set-gname" type="text" maxlength="40" autocomplete="off" value="${esc(draft.name)}">`, '', 'full')}
    ${gearingHtml()}
    <div class="gar-acts"><button type="button" class="primary" id="gear-save">Save and use it</button><span class="help" id="gar-err"></span></div>`;
}
function renderGearing(view = gearView) {
  gearView = view === 'new' && draft ? 'new' : 'list';
  const f = $('#gearing-form');
  if (gearView === 'new') { f.innerHTML = gearNewHtml(); fillDrivetrain(); }
  else {
    f.innerHTML = gearListHtml();
    $('#gear-all').value = gearOptions().find((o) => o.on)?.v || '';
    if ($('#gear-style')) $('#gear-style').value = shiftStyleFor(app.settings.shiftStyle, $('#gear-style').options[0].value === 'right');
  }
  $('#garage').scrollTop = 0;
}
// The Garage popup has two tabs (Agustín, Nov 12: gearing had no way in from home): Bikes and Gearing.
// The top-bar bike opens Bikes; the pause screen and [data-open-gearing] links open Gearing.
let garTab = 'bikes';
function setGarTab(id, animate = false) {
  if (!['bikes', 'gearing'].includes(id)) id = 'bikes';
  const prev = garTab;
  garTab = id;
  draft = null; // leaving a half-made bike or gearing discards it, like Cancel
  $$('#gar-tabs button').forEach((b) => { const on = b.dataset.gtab === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  $('#garage-form').classList.toggle('hidden', id !== 'bikes');
  $('#gearing-form').classList.toggle('hidden', id !== 'gearing');
  if (id === 'bikes') renderGarage({ mode: 'list' }); else renderGearing('list');
  placeInk($('#gar-tabs'), $(`#gar-tabs [data-gtab="${id}"]`));
  if (animate && prev !== id) slideIn($(id === 'bikes' ? '#garage-form' : '#gearing-form'), id === 'gearing' ? 1 : -1);
}
/** A bike picked in the Garage; during a ride it applies at once (weight and wheel), with a toast. */
function useBike(id) {
  Object.assign(app.settings, selectBike(app.settings, id));
  saveSettings();
  renderGarage({ mode: 'list' });
  const s = app.session, b = currentBike(app.settings);
  if (s && !s.finished && app.screen === 'ride' && b) toast(`Riding the ${b.name}`);
}
export function openGarage(tab = 'bikes') {
  setDevPop(false);
  $$('.panel').forEach((p) => p.classList.add('hidden'));
  $('#garage').classList.remove('hidden');
  setGarTab(tab);
}
export const openGearing = () => openGarage('gearing');
function startGearing() {
  const n = myGearings(app.settings).length;
  draft = { name: `My gearing${n ? ` ${n + 1}` : ''}`, drivetrain: app.settings.drivetrain, customDrivetrain: app.settings.customDrivetrain || null, shiftStyle: app.settings.shiftStyle || 'sram' };
  if (draft.drivetrain === 'zwift-24') draft.drivetrain = DEFAULT_SETTINGS.drivetrain; // a new gearing has real teeth
  renderGearing('new');
  $('#set-gname').focus(); $('#set-gname').select();
}
function saveGearing() {
  const name = $('#set-gname').value.trim();
  if (!name) { $('#gar-err').textContent = 'Give it a name.'; $('#set-gname').focus(); return; }
  if ($('#set-gears').value !== 'zwift' && !editDrivetrain()) { $('#gar-err').textContent = 'Fix the gearing first.'; return; }
  const mine = myGearings(app.settings);
  const g = cleanGearing({ ...draft, id: newBikeId([...gearingsOf(app.settings)], 'gearing'), name });
  if (!g) return;
  app.settings.gearings = [...mine, g];
  draft = null;
  useGearing(`g:${g.id}`);
}
async function removeGearing(id) {
  const g = myGearings(app.settings).find((x) => x.id === id);
  if (!g) return;
  if (!await ask(`Remove ${g.name}?`, { title: 'Remove gearing', ok: 'Remove', danger: true })) return;
  app.settings.gearings = myGearings(app.settings).filter((x) => x.id !== id); // if it's in use, its teeth stay until you pick another
  saveSettings();
  renderGearing('list');
}

/** Wires the Garage popup. Call once from app.js, after its helpers exist. */
export function initGarage(deps) {
  ({ app, numField, saveSettings, ask, syncClient, setDevPop } = deps);
  {
    const f = $('#garage-form');
    f.oninput = (e) => {
      const el = e.target;
      if (!draft) return;
      if (el.id === 'set-gname') draft.name = el.value;
      else if (el.id === 'set-wheel') draft.wheel = Number(el.value);
      else if (el.id === 'set-bike') pickBike(el.value);
      else if (['set-btype', 'set-bmat', 'set-bfront', 'set-brear', 'set-bbuild'].includes(el.id)) editBike(el);
      else if (el.id === 'set-bikeKg') {
        if (el.value === '' || !(Number(el.value) > 0)) return;
        draft.bikeKg = Number(el.value);
        // a typed weight that isn't the estimate replaces it
        if (draft.bikeSpec && Math.abs(estimateBikeKg(draft.bikeSpec) - draft.bikeKg) > 0.05) { draft.bikeSpec = null; fillBike(true); }
      }
      $('#gar-err') && ($('#gar-err').textContent = '');
    };
    f.onclick = (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('gar-pick') && t.dataset.bike) useBike(t.dataset.bike);
      else if (t.dataset.details) renderGarage({ mode: 'details', id: t.dataset.details });
      else if (t.id === 'gar-back') { draft = null; renderGarage({ mode: 'list' }); }
      else if (t.id === 'gar-custom') startCustom();
      else if (t.dataset.copy) startCustom(garageOf(app.settings).find((x) => x.id === t.dataset.copy));
      else if (t.id === 'gar-save') saveCustom();
      else if (t.dataset.ride) useBike(t.dataset.ride);
      else if (t.dataset.remove) removeGarageBike(t.dataset.remove);
      else if (t.dataset.addmodel) {
        const g = garageOf(app.settings), b = bikeFromModel(t.dataset.addmodel, newBikeId(g, t.dataset.addmodel));
        if (b) { app.settings.garage = [...g, b]; saveSettings(); renderGarage({ mode: 'list' }); }
      }
    };
  }
  $$('#gar-tabs button').forEach((b) => (b.onclick = () => setGarTab(b.dataset.gtab, true)));
  if (inkObserver) inkObserver.observe($('#gar-tabs'));
  {
    const f = $('#gearing-form');
    f.oninput = (e) => {
      const el = e.target;
      if (el.id === 'gear-all') return useGearing(el.value);
      if (el.id === 'gear-style') {
        app.settings.shiftStyle = el.value;
        const cur = currentGearing(app.settings); // your own gearing keeps its shifting
        if (cur && !cur.builtin) app.settings.gearings = myGearings(app.settings).map((g) => (g.id === cur.id ? { ...g, shiftStyle: el.value } : g));
        saveSettings();
        return renderGearing('list');
      }
      if (!draft) return;
      if (el.id === 'set-gname') draft.name = el.value;
      else if (['set-gears', 'set-ring1', 'set-ring2', 'set-cmin', 'set-cmax'].includes(el.id)) editDrivetrain(el);
      else if (el.id === 'set-style') { draft.shiftStyle = el.value; $('#style-help').textContent = styleHelp(dtSpec(draft)); }
      $('#gar-err') && ($('#gar-err').textContent = '');
    };
    // tidy the typed teeth once the field is left (only when they were valid)
    f.onchange = (e) => { if (draft && ['set-ring1', 'set-ring2'].includes(e.target.id) && editDrivetrain()) fillDrivetrain(); };
    f.onclick = (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.gear) useGearing(`g:${t.dataset.gear}`);
      else if (t.id === 'gear-new') startGearing();
      else if (t.id === 'gear-back') { draft = null; renderGearing('list'); }
      else if (t.id === 'gear-save') saveGearing();
      else if (t.dataset.gremove) removeGearing(t.dataset.gremove);
    };
  }
}
