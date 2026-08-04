/* COSMO SELECT — recommendation UI
   Vanilla JS, no build step. Talks to a TriplyDB SPARQL endpoint and renders
   the concern selector, the featured-product story, and the More Matches grid. */

// index.html's inline <head> script already sets history.scrollRestoration
// to 'manual' as early as possible; this covers the case that alone doesn't
// (a back/forward-cache restore, e.g. Safari/iOS swipe-back), which fires
// its own pageshow event rather than a fresh navigation.
addEventListener('pageshow', () => window.scrollTo(0, 0));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENDPOINT = 'https://api.triplydb.com/datasets/JensiGoyani/cosmo-select-skincare-/sparql';
const PREFIX = 'PREFIX : <http://www.semanticweb.org/skincare#>';

// ---------------------------------------------------------------------------
// SPARQL query construction
// ---------------------------------------------------------------------------

// Builds one query that requires a matching ingredient per selected concern
// (AND semantics) and filters out excluded allergens.
function buildQuery(condition, allergen) {
  const allowedConditions = ['Dryness', 'Acne', 'Redness', 'Dehydration'];
  const requested = Array.isArray(condition) ? condition : [condition];
  const conditions = [...new Set(requested.filter(value => allowedConditions.includes(value)))];

  // With no concerns selected the query returns the full catalogue.
  // One ingredient pattern per concern, so every concern must be covered.
  const conditionPatterns = conditions.map((value, index) => `
  ?product :containsIngredient ?ingredient${index} .
  ?ingredient${index} :helpsWithCondition :${value} .`).join('\n');

  let allergenFilter = '';
  if (allergen === 'Fragrance') {
    allergenFilter = 'FILTER NOT EXISTS { ?product :containsAllergen :Fragrance . }';
  } else if (allergen === 'Alcohol') {
    allergenFilter = 'FILTER NOT EXISTS { ?product :containsAllergen :Alcohol . }';
  } else if (allergen === 'Both') {
    allergenFilter = 'FILTER NOT EXISTS { ?product :containsAllergen :Fragrance . }\n  FILTER NOT EXISTS { ?product :containsAllergen :Alcohol . }';
  }

  return `${PREFIX}

SELECT DISTINCT ?productName ?price ?brand ?type ?url ?image WHERE {
  ${conditionPatterns}
  ?product :productName ?productName .
  ?product :price ?price .
  ?product :productURL ?url .
  ?product :manufacturedBy ?b .
  ?b :brandName ?brand .
  ?product :hasProductType ?t .
  ?t :typeName ?type .
  OPTIONAL { ?product :productImage ?image . }
  ${allergenFilter}
}
ORDER BY ?price`;
}

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

// A couple of products whose transparent renders are missing; fall back to
// local photos before trying the remote image URL.
const LOCAL_IMAGES = {
  'CeraVe Hydrating Cleanser 473ml': './images/products/CeraVe%20Hydrating%20Cleanser%20473ml.jpg',
  'La Roche-Posay Effaclar H Hydrating Cleansing Cream (200ml)': './images/products/La%20Roche-Posay%20Effaclar%20H%20Hydrating%20Cleansing%20Cream%20(200ml).jpg'
};

const SKIN_OPTS = [
  { value: 'Dryness', label: 'Dryness', description: 'Support for skin that feels rough or tight' },
  { value: 'Acne', label: 'Acne', description: 'Products associated with blemish-prone skin' },
  { value: 'Redness', label: 'Redness', description: 'Options for visibly reactive-looking skin' },
  { value: 'Dehydration', label: 'Dehydration', description: 'Hydration-focused product matches' }
];

const ALLERGEN_OPTS = [
  { value: '', label: 'Show all', description: 'Empty allergen value' },
  { value: 'Fragrance', label: 'No fragrance', description: 'Exclude fragrance' },
  { value: 'Alcohol', label: 'No alcohol', description: 'Exclude alcohol' },
  { value: 'Both', label: 'Avoid both', description: 'Exclude fragrance and alcohol' }
];

const CONCERN_ICONS = {
  Dryness: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M7 6l5 3 5-3M7 18l5-3 5 3M4 12h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  Acne: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="1.7"/></svg>',
  Redness: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-4.5 7-11a7 7 0 0 0-14 0c0 6.5 7 11 7 11Z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 11c1-2 5-2 6 0" stroke="currentColor" stroke-width="1.7"/></svg>',
  Dehydration: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2S5 10 5 15a7 7 0 0 0 14 0c0-5-7-13-7-13Z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>'
};

const CONCERN_PRESENTATION = {
  Dryness: { image: './images/concerns/dryness.jpeg', description: 'Comfort for skin that feels rough or tight.', visual: 'Dry Skin Texture' },
  Acne: { image: './images/concerns/acne.jpeg', description: 'Clear care for blemish-prone skin.', visual: 'Blemish-Prone Texture' },
  Redness: { image: './images/concerns/redness.jpeg', description: 'Calm visibly reactive-looking skin.', visual: 'Reactive Skin Tone' },
  Dehydration: { image: './images/concerns/dehydration.webp', description: 'Replenish skin with moisture-focused care.', visual: 'Dehydration Signs' }
};

const LOADING_MESSAGES = [
  'Finding products that match your preferences…',
  'Checking product ingredients…',
  'Applying your filters…',
  'Preparing your recommendations…'
];

// ---------------------------------------------------------------------------
// Ingredient knowledge (card flip, back-of-card ingredient story)
// ---------------------------------------------------------------------------

// Maps a raw ingredient name (as stored in the graph, or a common synonym) to
// a canonical key, so spelling/capitalisation/naming variants group under one
// display entry rather than appearing as duplicates.
const INGREDIENT_ALIASES = {
  'hyaluronic acid': 'hyaluronic-acid',
  'sodium hyaluronate': 'hyaluronic-acid',
  'niacinamide': 'niacinamide',
  'ceramide': 'ceramides',
  'ceramides': 'ceramides',
  'ceramide np': 'ceramides',
  'ceramide ap': 'ceramides',
  'ceramide eop': 'ceramides',
  'salicylic acid': 'salicylic-acid',
  'glycerin': 'glycerin',
  'glycerine': 'glycerin',
  'panthenol': 'panthenol',
  'pro-vitamin b5': 'panthenol',
  'provitamin b5': 'panthenol',
  'urea': 'urea',
  'vitamin e': 'vitamin-e',
  'tocopherol': 'vitamin-e',
  'tocopheryl acetate': 'vitamin-e',
  'shea butter': 'shea-butter',
  'butyrospermum parkii': 'shea-butter',
  'squalane': 'squalane',
  'retinol': 'retinol',
  'peptide': 'peptides',
  'peptides': 'peptides',
  'lactic acid': 'lactic-acid',
  'zinc': 'zinc',
  'zinc oxide': 'zinc',
  'zinc pca': 'zinc',
  'aloe vera': 'aloe-vera',
  'aloe barbadensis leaf juice': 'aloe-vera',
  'centella asiatica': 'centella-asiatica',
  'cica': 'centella-asiatica',
  'allantoin': 'allantoin',
  'vitamin c': 'vitamin-c',
  'ascorbic acid': 'vitamin-c',
  'titanium dioxide': 'sunscreen-filter',
  'avobenzone': 'sunscreen-filter',
  'octinoxate': 'sunscreen-filter'
};

// Canonical key -> display label, a short non-medical benefit and a priority
// rank used to choose which ingredients earn one of the five callout slots.
// Ranking follows the order requested for the card back; entries the graph
// happens to carry that weren't on that list (allantoin, vitamin C) are kept
// but ranked after it, so a named ingredient never crowds out one the graph
// doesn't actually have any of.
const INGREDIENT_INFO = {
  'hyaluronic-acid': { label: 'Hyaluronic acid', benefit: 'Hydration', priority: 0 },
  'niacinamide': { label: 'Niacinamide', benefit: 'Calming and tone support', priority: 1 },
  'ceramides': { label: 'Ceramides', benefit: 'Barrier support', priority: 2 },
  'salicylic-acid': { label: 'Salicylic acid', benefit: 'Pore care', priority: 3 },
  'glycerin': { label: 'Glycerin', benefit: 'Moisture retention', priority: 4 },
  'panthenol': { label: 'Panthenol', benefit: 'Soothing', priority: 5 },
  'urea': { label: 'Urea', benefit: 'Hydration and softening', priority: 6 },
  'vitamin-e': { label: 'Vitamin E', benefit: 'Antioxidant support', priority: 7 },
  'shea-butter': { label: 'Shea butter', benefit: 'Moisture retention', priority: 8 },
  'squalane': { label: 'Squalane', benefit: 'Moisture retention', priority: 9 },
  'retinol': { label: 'Retinol', benefit: 'Renewal support', priority: 10 },
  'peptides': { label: 'Peptides', benefit: 'Renewal support', priority: 11 },
  'lactic-acid': { label: 'Lactic acid', benefit: 'Gentle exfoliation', priority: 12 },
  'zinc': { label: 'Zinc', benefit: 'Calming support', priority: 13 },
  'aloe-vera': { label: 'Aloe vera', benefit: 'Soothing', priority: 14 },
  'centella-asiatica': { label: 'Centella asiatica', benefit: 'Soothing', priority: 15 },
  'sunscreen-filter': { label: 'Sunscreen filter', benefit: 'Sun protection', priority: 16 },
  'allantoin': { label: 'Allantoin', benefit: 'Soothing', priority: 17 },
  'vitamin-c': { label: 'Vitamin C', benefit: 'Antioxidant support', priority: 18 }
};

// Fallback benefit for an ingredient the alias map above doesn't recognise:
// the graph's own :hasFunction value, in plain words, never an invented one.
const FUNCTION_BENEFIT = {
  Humectant: 'Hydration',
  Occlusant: 'Barrier support',
  Emollient: 'Moisture retention',
  Exfoliant: 'Pore care',
  Brightening: 'Tone support',
  Soothing: 'Soothing',
  Anti_Aging: 'Renewal support',
  Antioxidant: 'Antioxidant support'
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const skinProblem = document.getElementById('skinProblem');
const allergen = document.getElementById('allergen');
const findBtn = document.getElementById('findBtn');
const findBtnLabel = document.getElementById('findBtnLabel');
const formMessage = document.getElementById('formMessage');
const results = document.getElementById('results');
const loading = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const emptyBox = document.getElementById('emptyBox');
const productGrid = document.getElementById('productGrid');
const resultsCount = document.getElementById('resultsCount');
const resultsMeta = document.getElementById('resultsMeta');
const story = document.getElementById('story');
const moreTitle = document.querySelector('.more-title');
const skinProblemOpts = document.getElementById('skinProblemOpts');
const allergenOpts = document.getElementById('allergenOpts');
const loadingMsg = document.getElementById('loadingMsg');
const quizForm = document.getElementById('quizForm');
const resetChoicesButton = document.getElementById('resetChoices');
const clearConcernsButton = document.getElementById('clearConcerns');
const browseAllButton = document.getElementById('browseAllBtn');
const selectionChips = document.getElementById('selectionChips');
const videoFallback = document.getElementById('videoFallback');
const matchLayout = document.querySelector('.match-layout');
const concernStage = document.getElementById('concernStage');
const concernNeutralVideos = [
  document.getElementById('concernNeutralVideo'),
  document.getElementById('concernNeutralVideoNext')
];
const concernMainImage = document.getElementById('concernMainImage');
const concernNextImage = document.getElementById('concernNextImage');
const stageBadge = document.getElementById('stageBadge');
const stageCaption = document.getElementById('stageCaption');
const activeConcernCopy = document.getElementById('activeConcernCopy');
const matchStepItems = [...document.querySelectorAll('#matchSteps li')];
const selectionConcerns = document.getElementById('selectionConcerns');
const selectionFilter = document.getElementById('selectionFilter');
const ctaHelper = document.getElementById('ctaHelper');
const concernStartHint = document.getElementById('concernStartHint');
const concernRail = document.querySelector('.concern-rail');
const resultsHeader = document.querySelector('.results-header');

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let loadingInterval;
let concernSwitchTimer;
let neutralCrossfadeTimer;
let neutralVideoIndex = 0;
let neutralCrossfading = false;
let onboardingStep = 1;
let activeConcernLayer = 0;
let activeConcern = '';
let resultStoryCleanup;
let resultStoryUpdate = null;
let pageMotionUpdate = null;
let lenis = null;
let requestController = null;
let searchRequestId = 0;
let isSearching = false;
// Result count from the last completed search, or null when no search has run
// against the current selection. Cleared whenever the selection changes so the
// summary never reports a count for a profile the user has since edited.
let lastMatchCount = null;
// The single flipped product card, if any. Opening a card closes whichever
// one this points to; both are set to null together.
let openFlipCard = null;
let ingredientModal = null;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function show(el) {
  el.style.display = 'block';
}

function hide(el) {
  el.style.display = 'none';
}

// The featured story temporarily adopts the results header; put it back
// before rendering a new result set.
function restoreResultsIntro() {
  if (resultsHeader.parentElement !== results) {
    results.insertBefore(resultsHeader, loading);
  }
  if (resultsMeta.parentElement !== results) {
    resultsHeader.after(resultsMeta);
  }
}

function safeHttp(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function valueOf(binding, key, fallback = '') {
  return binding[key]?.value || fallback;
}

function price(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? `£${number.toFixed(2)}` : 'Price unavailable';
}

// ---------------------------------------------------------------------------
// Retailer price corrections
// ---------------------------------------------------------------------------

// The graph carries a fixed Kaggle snapshot of the retailer's catalogue and the
// shop has repriced since, so most stored prices no longer match the page the
// "View product" link opens. data/prices.json holds figures verified against
// the retailer's own structured data, matched on the SKU in each product URL,
// and overrides the snapshot at render time. Products the retailer has
// discontinued or replaced are marked unavailable rather than shown at a price
// nobody can actually pay.
const PRICE_DATA_URL = './data/prices.json?v=2';
let priceDataPromise = null;

function loadPriceCorrections() {
  if (!priceDataPromise) {
    // Corrections are an enhancement, never a hard dependency: if the file is
    // missing the catalogue still renders on the graph's own figures.
    priceDataPromise = fetch(PRICE_DATA_URL)
      .then(response => (response.ok ? response.json() : null))
      .catch(() => null);
  }
  return priceDataPromise;
}

// Rewrites prices in place, then re-sorts: the SPARQL ORDER BY ran on the stale
// figures, so "lowest first" would otherwise be in the wrong order.
function applyPriceCorrections(bindings, corrections) {
  if (!corrections) return bindings;
  const prices = corrections.prices || {};
  const unavailable = corrections.unavailable || {};

  bindings.forEach(binding => {
    const url = binding.url?.value;
    if (!url) return;
    if (unavailable[url]) {
      binding.priceUnavailable = unavailable[url].reason || true;
      return;
    }
    const corrected = prices[url];
    if (corrected && binding.price) binding.price.value = String(corrected.price);
  });

  // Unavailable products sort last; they have no price to rank on.
  const rank = binding => (binding.priceUnavailable
    ? Number.POSITIVE_INFINITY
    : Number.parseFloat(binding.price?.value) || Number.POSITIVE_INFINITY);
  return bindings.sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------------------
// Ingredient data (card flip, back-of-card ingredient story)
// ---------------------------------------------------------------------------

// A separate, additive query: the recommendation query above is left exactly
// as it was, so filtering, matching and ordering cannot be affected by this.
// It asks for every :containsIngredient triple regardless of concern, which
// buildQuery() deliberately does not, since it only needs ingredients that
// match the SELECTED concern to build the WHERE clause.
const INGREDIENT_QUERY = `${PREFIX}

SELECT ?productName ?ingName ?funcUri WHERE {
  ?product :productName ?productName .
  ?product :containsIngredient ?ing .
  ?ing :ingredientName ?ingName .
  OPTIONAL { ?ing :hasFunction ?funcUri . }
}`;

let ingredientDataPromise = null;

// Returns a Map<productName, [{name, function}]>, in the order the graph
// returned them, deduplicated by name. Like loadPriceCorrections, this is an
// enhancement: on failure the cards still render, just without a back side
// worth flipping to.
function loadIngredientData() {
  if (!ingredientDataPromise) {
    ingredientDataPromise = fetch(`${ENDPOINT}?query=${encodeURIComponent(INGREDIENT_QUERY)}`, {
      headers: { Accept: 'application/sparql-results+json' }
    })
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        const bindings = Array.isArray(data?.results?.bindings) ? data.results.bindings : [];
        const map = new Map();
        bindings.forEach(row => {
          const productName = row.productName?.value;
          const ingName = row.ingName?.value;
          if (!productName || !ingName) return;
          const funcUri = row.funcUri?.value || '';
          const func = funcUri ? funcUri.split('#').pop() : null;
          if (!map.has(productName)) map.set(productName, []);
          const list = map.get(productName);
          if (!list.some(entry => entry.name.toLowerCase() === ingName.toLowerCase())) {
            list.push({ name: ingName, function: func });
          }
        });
        return map;
      })
      .catch(() => null);
  }
  return ingredientDataPromise;
}

// Resolves one raw {name, function} entry to a display label, a short
// benefit and a priority rank. Unrecognised ingredients are still shown
// under their own name — never dropped — with the graph's own function as
// their benefit when one is recorded, and no invented benefit otherwise.
function enrichIngredient(entry) {
  const key = INGREDIENT_ALIASES[entry.name.trim().toLowerCase()];
  const known = key ? INGREDIENT_INFO[key] : null;
  if (known) {
    return { label: known.label, benefit: known.benefit, priority: known.priority, raw: entry.name, function: entry.function };
  }
  return {
    label: entry.name,
    benefit: entry.function ? (FUNCTION_BENEFIT[entry.function] || null) : null,
    priority: 999,
    raw: entry.name,
    function: entry.function
  };
}

function getEnrichedIngredients(productName, ingredientsMap) {
  const raw = ingredientsMap?.get(productName) || [];
  return raw.map(enrichIngredient);
}

// A background tint the back of the card can lean on, chosen from what the
// product actually is rather than fixed per product, so it varies with real
// data instead of being hardcoded.
function pickIngredientTint(enriched, typeText) {
  const type = (typeText || '').toLowerCase();
  if (/spf|sun\s*protect/.test(type)) return 'spf';
  const has = key => enriched.some(ing => INGREDIENT_ALIASES[ing.raw.trim().toLowerCase()] === key);
  if (has('salicylic-acid')) return 'acne';
  if (has('allantoin') || has('centella-asiatica') || has('aloe-vera')) return 'soothing';
  if (has('ceramides')) return 'barrier';
  return 'hydrating';
}

// Short, dynamically generated, and phrased as a suggestion rather than a
// promise: it names the selected concerns, never the matching algorithm.
function buildMatchExplanation(conditions) {
  const list = (Array.isArray(conditions) ? conditions : [conditions]).filter(Boolean);
  if (!list.length) return 'Shown as part of the full collection, not matched to a specific concern.';
  const names = list.map(value => value.toLowerCase());
  const joined = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Recommended for ${joined} based on the product's matched ingredient data.`;
}

function filterText(value) {
  return value === 'Fragrance' ? 'Fragrance excluded'
    : value === 'Alcohol' ? 'Alcohol excluded'
    : value === 'Both' ? 'Fragrance and alcohol excluded'
    : 'No ingredient filter';
}

function selectedConditions() {
  return [...skinProblem.options].filter(option => option.selected).map(option => option.value);
}

function conditionText(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(Boolean).join(' + ');
}

// ---------------------------------------------------------------------------
// Product image handling
// ---------------------------------------------------------------------------

function createImageFallback(name) {
  const fallback = document.createElement('div');
  fallback.className = 'image-fallback';

  const mark = document.createElement('span');
  mark.className = 'fallback-mark';
  mark.textContent = (String(name).trim().match(/[A-Za-z0-9]/)?.[0] || 'C').toUpperCase();

  const text = document.createElement('small');
  text.textContent = 'Image coming soon';

  fallback.append(mark, text);
  return fallback;
}

// Transparent product renders come in wildly different crops. Sample the
// alpha channel on a small canvas, find the visible bounding box, and nudge
// scale/position via CSS variables so every bottle sits centred at a similar
// size. Only applies to our own transparent renders.
function normalizeVisibleProduct(image) {
  if (!image.src.includes('/query-products-transparent/')) return;
  try {
    const sample = 260;
    const ratio = Math.min(1, sample / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);

    // Scan every other pixel for non-transparent content.
    const pixels = context.getImageData(0, 0, width, height).data;
    let left = width, top = height, right = -1, bottom = -1;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (pixels[(y * width + x) * 4 + 3] > 24) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    }
    if (right < left || bottom < top) return;

    const visibleWidth = (right - left + 1) / width;
    const visibleHeight = (bottom - top + 1) / height;
    const centerX = (left + right + 1) / (2 * width);
    const centerY = (top + bottom + 1) / (2 * height);

    // Clamp so extreme crops can't blow the image out of its frame. The
    // ceiling matters: the CSS sizes the image at 75% of the frame, the frame
    // clips, and 75% x 1.35 overflowed, which cropped the bottom off taller
    // bottles. 1.22 keeps the worst case inside the frame with room for the
    // centring shift.
    const scale = Math.max(.88, Math.min(1.22, .84 / Math.max(visibleWidth, visibleHeight)));
    const shiftX = Math.max(-9, Math.min(9, (.5 - centerX) * 100 * scale));
    const shiftY = Math.max(-8, Math.min(8, (.5 - centerY) * 100 * scale));

    image.style.setProperty('--visible-scale', scale.toFixed(3));
    image.style.setProperty('--image-shift-x', `${shiftX.toFixed(2)}%`);
    image.style.setProperty('--image-shift-y', `${shiftY.toFixed(2)}%`);
  } catch (error) {
    console.debug('Product image normalization skipped', error);
  }
}

// Tries image sources in order: transparent render → local photo → remote
// URL, and shows a text fallback if all of them fail.
function createProductImage(name, imageValue) {
  const wrap = document.createElement('div');
  wrap.className = 'product-image-wrap';

  const candidates = [`./images/query-products-transparent/${encodeURIComponent(name)}.png`];
  if (LOCAL_IMAGES[name]) candidates.push(LOCAL_IMAGES[name]);
  if (safeHttp(imageValue)) candidates.push(imageValue);

  const image = document.createElement('img');
  image.alt = `${name} product`;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';

  let index = 0;
  const tryNext = () => {
    if (index >= candidates.length) {
      wrap.replaceChildren(createImageFallback(name));
      return;
    }
    image.src = candidates[index++];
  };
  image.addEventListener('error', tryNext);
  image.addEventListener('load', () => normalizeVisibleProduct(image));
  tryNext();

  wrap.append(image);
  return wrap;
}

// ---------------------------------------------------------------------------
// Option rendering
// ---------------------------------------------------------------------------

function makeOption(option, group) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'option-card';
  button.role = group === 'skin' ? 'checkbox' : 'radio';
  button.dataset.value = option.value;

  const check = document.createElement('span');
  check.className = 'option-check';
  check.textContent = '✓';
  check.setAttribute('aria-hidden', 'true');

  const label = document.createElement('strong');
  label.textContent = option.label;
  const description = document.createElement('small');
  description.textContent = option.description;

  if (group === 'skin') {
    // A concern card is an image tile: the photograph carries the meaning, the
    // icon and label sit on top of it. The picture is decorative (the label
    // already names the concern), so its alt stays empty.
    button.classList.add('concern-card');
    const photo = document.createElement('img');
    photo.className = 'concern-card-photo';
    photo.src = CONCERN_PRESENTATION[option.value]?.image || '';
    photo.alt = '';
    photo.loading = 'lazy';

    const icon = document.createElement('span');
    icon.className = 'option-icon';
    icon.innerHTML = CONCERN_ICONS[option.value];

    const body = document.createElement('span');
    body.className = 'concern-card-body';
    body.append(label, description);

    button.append(photo, icon, check, body);
  } else {
    button.append(check, label, description);
  }

  button.addEventListener('click', () => {
    // Clicking the active allergen again clears the filter.
    if (group === 'allergen' && button.getAttribute('aria-checked') === 'true' && option.value !== '') {
      selectAllergen('');
      return;
    }
    group === 'allergen' ? selectAllergen(option.value) : selectSkin(option.value);
  });
  button.addEventListener('keydown', event => radioKeys(event, group));
  return button;
}

function renderOptions() {
  SKIN_OPTS.forEach(option => skinProblemOpts.append(makeOption(option, 'skin')));
  ALLERGEN_OPTS.forEach(option => allergenOpts.append(makeOption(option, 'allergen')));
  syncOptions();
}

// Arrow-key navigation between option cards, per the ARIA radio pattern.
function radioKeys(event, group) {
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();

  const buttons = [...event.currentTarget.parentElement.children];
  let index = buttons.indexOf(event.currentTarget);
  if (event.key === 'Home') {
    index = 0;
  } else if (event.key === 'End') {
    index = buttons.length - 1;
  } else {
    index = (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
  }

  buttons[index].focus();
  if (group === 'allergen') selectAllergen(buttons[index].dataset.value);
}

// ---------------------------------------------------------------------------
// Concern selector
// ---------------------------------------------------------------------------

function playNeutralConcern() {
  const current = concernNeutralVideos[neutralVideoIndex];
  current.classList.add('is-visible');
  current.classList.remove('is-fading');
  current.play().catch(() => {});
}

function pauseNeutralConcern() {
  clearTimeout(neutralCrossfadeTimer);
  // If we interrupt mid-crossfade, treat the incoming video as current.
  if (neutralCrossfading) neutralVideoIndex = 1 - neutralVideoIndex;
  concernNeutralVideos.forEach((video, index) => {
    video.pause();
    if (index !== neutralVideoIndex) video.currentTime = 0;
    video.classList.toggle('is-visible', index === neutralVideoIndex);
    video.classList.remove('is-fading');
  });
  neutralCrossfading = false;
}

function showNeutralConcern() {
  activeConcern = '';
  clearTimeout(concernSwitchTimer);
  matchLayout.dataset.concern = '';
  concernStage.dataset.concern = '';
  delete document.body.dataset.concern;
  concernStage.classList.add('is-neutral');
  // The left heading is the fixed "Step 1" title now; it no longer mirrors the
  // previewed concern, which is what made the panel read as a shifting label
  // rather than a stable instruction.
  [concernMainImage, concernNextImage].forEach(layer => layer.className = '');
  stageBadge.textContent = '';
  stageBadge.classList.remove('is-visible');
  stageCaption.classList.remove('is-active');
  playNeutralConcern();
  syncOptions();
}

// Crossfades the stage image between two layers when the previewed concern
// changes; without animation it just swaps the current layer.
function updateConcernPreview(value, animate = true) {
  if (!value) {
    showNeutralConcern();
    return;
  }

  const option = SKIN_OPTS.find(item => item.value === value) || SKIN_OPTS[0];
  const presentation = CONCERN_PRESENTATION[option.value];
  const layers = [concernMainImage, concernNextImage];

  activeConcern = option.value;
  clearTimeout(concernSwitchTimer);
  concernStage.classList.remove('is-neutral');
  pauseNeutralConcern();
  matchLayout.dataset.concern = option.value;
  concernStage.dataset.concern = option.value;
  document.body.dataset.concern = option.value;
  stageBadge.textContent = `Visualizing: ${presentation.visual}`;
  stageBadge.classList.add('is-visible');
  stageCaption.classList.add('is-active');

  // Restart the copy animation by forcing a reflow between class toggles.
  activeConcernCopy.classList.remove('is-switching');
  void activeConcernCopy.offsetWidth;
  activeConcernCopy.classList.add('is-switching');
  syncOptions();

  if (!animate) {
    layers.forEach(layer => layer.className = '');
    layers[0].src = presentation.image;
    layers[0].alt = `${option.label} concern visual`;
    layers[0].className = 'is-current';
    activeConcernLayer = 0;
    return;
  }

  const outgoing = layers[activeConcernLayer];
  const incomingIndex = 1 - activeConcernLayer;
  const incoming = layers[incomingIndex];
  layers.forEach(layer => layer.className = '');
  outgoing.className = 'is-current';
  incoming.src = presentation.image;
  incoming.alt = `${option.label} concern visual`;
  requestAnimationFrame(() => {
    outgoing.className = 'is-outgoing';
    incoming.className = 'is-incoming';
  });
  activeConcernLayer = incomingIndex;
  concernSwitchTimer = setTimeout(() => {
    outgoing.className = '';
    incoming.className = 'is-current';
  }, 680);
}

function selectSkin(value) {
  const option = [...skinProblem.options].find(item => item.value === value);
  if (option) {
    option.selected = !option.selected;
    if (option.selected) {
      activeConcern = value;
    } else if (activeConcern === value) {
      // Fall back to the most recently selected concern, if any.
      activeConcern = selectedConditions().at(-1) || '';
    }
  }
  // Choosing a concern IS step 1 ("Choose concerns") — it must not jump the
  // stepper to step 2 on the very first click, while the left panel is still
  // showing "STEP 1" and the user may still be adding more concerns. Step 2
  // ("Set preferences") only activates once the user actually touches a
  // preference control (see selectAllergen), so the two stay in sync instead
  // of the stepper racing ahead of the panel the user is still looking at.
  onboardingStep = selectedConditions().length ? Math.max(onboardingStep, 1) : 1;
  lastMatchCount = null;
  formMessage.textContent = '';
  updateConcernPreview(activeConcern);
}

function selectAllergen(value) {
  allergen.value = value;
  lastMatchCount = null;
  if (selectedConditions().length) onboardingStep = 2;
  syncOptions();
}

function resetChoices() {
  if (isSearching) return;
  [...skinProblem.options].forEach(option => { option.selected = false; });
  allergen.value = '';
  onboardingStep = 1;
  lastMatchCount = null;
  formMessage.textContent = '';
  showNeutralConcern();
}

// ---------------------------------------------------------------------------
// Onboarding and form state
// ---------------------------------------------------------------------------

function updateOnboarding() {
  const conditions = selectedConditions();
  const hasConditions = conditions.length > 0;
  if (!hasConditions) onboardingStep = 1;

  matchStepItems.forEach((item, index) => {
    const step = index + 1;
    item.classList.toggle('is-active', step === onboardingStep);
    item.classList.toggle('is-complete', step < onboardingStep);
  });

  selectionConcerns.textContent = hasConditions ? conditions.join(' · ') : 'No concerns selected';
  selectionFilter.textContent = allergen.value === 'Fragrance' ? 'No fragrance'
    : allergen.value === 'Alcohol' ? 'No alcohol'
    : allergen.value === 'Both' ? 'No fragrance or alcohol'
    : 'No ingredient exclusions';

  renderSelectionChips(conditions);

  concernStartHint.classList.toggle('is-hidden', hasConditions);
  concernRail.classList.toggle('needs-guidance', !hasConditions);
  // The helper doubles as the recommendation summary. Once a search has run it
  // reports the count instead, so the panel answers "what will I get?".
  ctaHelper.textContent = !hasConditions
    ? 'Choose at least one concern to view personalised matches.'
    : lastMatchCount === null
      ? 'We’ll find products matching all selected concerns.'
      : `${lastMatchCount} product${lastMatchCount === 1 ? '' : 's'} match this profile.`;
  // The primary action stays inert until there is something to match on; the
  // "browse all" link below it covers the no-selection case.
  findBtn.disabled = isSearching || !hasConditions;
}

// Renders the selected concerns as removable chips. Removal reuses selectSkin,
// so a chip and a card toggle through exactly the same path.
function renderSelectionChips(conditions) {
  if (!selectionChips) return;
  selectionChips.replaceChildren();

  if (!conditions.length) {
    const empty = document.createElement('span');
    empty.className = 'chip-empty';
    empty.textContent = 'No concerns selected';
    selectionChips.append(empty);
    if (clearConcernsButton) clearConcernsButton.hidden = true;
    return;
  }

  conditions.forEach(value => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.value = value;
    chip.setAttribute('aria-label', `Remove ${value}`);
    const text = document.createElement('span');
    text.textContent = value;
    const cross = document.createElement('span');
    cross.className = 'chip-x';
    cross.textContent = '×';
    cross.setAttribute('aria-hidden', 'true');
    chip.append(text, cross);
    chip.addEventListener('click', () => {
      if (isSearching) return;
      selectSkin(value);
      syncOptions();
    });
    selectionChips.append(chip);
  });

  if (clearConcernsButton) clearConcernsButton.hidden = false;
}

// Mirrors the hidden form state onto the visual option cards.
function syncOptions() {
  const chosen = new Set(selectedConditions());
  [...skinProblemOpts.children].forEach(button => {
    const selected = chosen.has(button.dataset.value);
    button.setAttribute('aria-checked', String(selected));
    button.classList.toggle('is-preview', button.dataset.value === activeConcern);
    button.tabIndex = 0;
  });
  [...allergenOpts.children].forEach(button => {
    const selected = button.dataset.value === allergen.value;
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  findBtn.disabled = isSearching;
  updateOnboarding();
}

// ---------------------------------------------------------------------------
// Recommendation rendering
// ---------------------------------------------------------------------------

// Small line-art cues for the spotlight panel — droplet (hydration/moisture),
// molecule (actives: exfoliants, antioxidants, renewal), cream (barrier,
// soothing, texture). Single currentColor stroke so CSS controls the tone.
const SPOTLIGHT_ICONS = {
  droplet: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5s6.5 7.02 6.5 11.2A6.5 6.5 0 0 1 5.5 14.7C5.5 10.52 12 3.5 12 3.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 15.2a3 3 0 0 0 3 2.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  molecule: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2.1" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="18" cy="8.5" r="2.1" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10.5" cy="17.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7.8 8.2 9 15.6M16.2 9.6l-4.4 6.4M8 6.6l8-.4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  cream: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11c0-3.6 3.1-7 7-7s7 3.4 7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4.5 11h15c.5 0 .8.5.6 1L18 20.5a1 1 0 0 1-.9.6H6.9a1 1 0 0 1-.9-.6L3.9 12c-.2-.5.1-1 .6-1Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'
};

// Benefit label -> spotlight icon + a short, condition-aware "why it suits
// you" line. Only fires for benefits the ingredient pipeline actually
// produces (see FUNCTION_BENEFIT / INGREDIENT_INFO above), so nothing here
// invents a claim the data doesn't support.
const SPOTLIGHT_BY_BENEFIT = {
  'Hydration': { icon: 'droplet', why: condition => `Draws moisture into the skin, helping ease ${condition}.` },
  'Moisture retention': { icon: 'droplet', why: condition => `Locks in moisture through the day, supporting ${condition}.` },
  'Hydration and softening': { icon: 'droplet', why: condition => `Softens and hydrates, calming ${condition}.` },
  'Barrier support': { icon: 'cream', why: condition => `Reinforces the skin barrier, easing sensitivity linked to ${condition}.` },
  'Calming and tone support': { icon: 'molecule', why: condition => `Calms visible redness and evens tone associated with ${condition}.` },
  'Pore care': { icon: 'molecule', why: condition => `Helps clear congestion that contributes to ${condition}.` },
  'Soothing': { icon: 'cream', why: condition => `Soothes irritation and visible discomfort from ${condition}.` },
  'Antioxidant support': { icon: 'molecule', why: condition => `Protects skin from daily stressors while supporting ${condition}.` },
  'Renewal support': { icon: 'molecule', why: condition => `Encourages skin renewal, helping resurface concerns tied to ${condition}.` },
  'Gentle exfoliation': { icon: 'molecule', why: condition => `Gently lifts away dulling buildup that worsens ${condition}.` },
  'Tone support': { icon: 'molecule', why: condition => `Helps even out tone affected by ${condition}.` },
  'Sun protection': { icon: 'cream', why: () => 'Shields skin from UV exposure, a daily essential for every routine.' }
};
const DEFAULT_SPOTLIGHT = { icon: 'droplet', why: condition => `Chosen as part of a formula suited to ${condition}.` };

// Interactive "ingredient spotlight": 3-5 gold-anchored callouts the shopper
// can hover or click, each updating a detail panel with the ingredient's
// name, benefit, a condition-aware "why it suits you" line and a small icon
// cue — in place of a flat, static ingredient list.
function buildStoryIngredients(binding, name, ingredientsMap, condition) {
  const enriched = getEnrichedIngredients(name, ingredientsMap);
  if (!enriched.length) return null;
  const keyIngredients = [...enriched].sort((a, b) => a.priority - b.priority).slice(0, 5);
  const conditionLabel = (condition && condition.length ? conditionText(condition) : 'your skin').toLowerCase();

  const wrap = document.createElement('div');
  wrap.className = 'story-ingredients';
  const kicker = document.createElement('span');
  kicker.className = 'back-kicker';
  kicker.textContent = 'Ingredient spotlight';
  wrap.append(kicker);

  const rail = document.createElement('div');
  rail.className = 'spotlight-rail';
  const panel = document.createElement('div');
  panel.className = 'spotlight-panel';
  const panelIcon = document.createElement('span');
  panelIcon.className = 'spotlight-icon';
  const panelName = document.createElement('strong');
  panelName.className = 'spotlight-name';
  const panelBenefit = document.createElement('span');
  panelBenefit.className = 'spotlight-benefit';
  const panelWhy = document.createElement('p');
  panelWhy.className = 'spotlight-why';
  panel.append(panelIcon, panelName, panelBenefit, panelWhy);

  const anchors = keyIngredients.map(ing => {
    const meta = (ing.benefit && SPOTLIGHT_BY_BENEFIT[ing.benefit]) || DEFAULT_SPOTLIGHT;
    const anchor = document.createElement('button');
    anchor.type = 'button';
    anchor.className = 'spotlight-anchor';
    const dot = document.createElement('span');
    dot.className = 'spotlight-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'spotlight-label';
    label.textContent = ing.label;
    anchor.append(dot, label);

    const setActive = () => {
      anchors.forEach(a => a.el.classList.toggle('is-active', a.el === anchor));
      panelIcon.innerHTML = SPOTLIGHT_ICONS[meta.icon];
      panelName.textContent = ing.label;
      panelBenefit.textContent = ing.benefit || 'Key ingredient';
      panelWhy.textContent = meta.why(conditionLabel);
    };
    anchor.addEventListener('mouseenter', setActive);
    anchor.addEventListener('focus', setActive);
    anchor.addEventListener('click', setActive);
    rail.append(anchor);
    return { el: anchor, setActive };
  });

  anchors[0].setActive();
  wrap.append(rail, panel);
  return wrap;
}

function addProductInfo(parent, binding, condition, allergenValue, headingClass = '') {
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.textContent = valueOf(binding, 'brand', 'Brand unavailable');

  const name = document.createElement('h3');
  const productName = valueOf(binding, 'productName', 'Product name unavailable');
  name.className = headingClass;
  // Keep the size suffix ("50 ml") glued to the last word with a nbsp.
  name.textContent = productName.replace(/\s+(\d+(?:\.\d+)?\s?(?:ml|g)\b)$/i, '\u00a0$1');
  if (!headingClass && productName.length > 46) name.classList.add('is-long-title');

  const type = document.createElement('div');
  type.className = 'product-type';
  type.textContent = valueOf(binding, 'type', 'Product');

  const badges = document.createElement('div');
  badges.className = 'badges';
  const match = document.createElement('span');
  match.className = 'badge';
  match.textContent = condition.length ? `Matches ${conditionText(condition)}` : 'Full collection';
  const filter = document.createElement('span');
  filter.className = 'badge filter';
  filter.textContent = filterText(allergenValue);
  badges.append(match, filter);

  const footer = document.createElement('div');
  footer.className = 'product-footer';
  const priceEl = document.createElement('span');
  priceEl.className = 'price';
  if (binding.priceUnavailable) {
    // The retailer has discontinued or replaced this product, so the stored
    // figure is not a price anyone can pay. Say so instead of showing it.
    priceEl.classList.add('price-unavailable');
    priceEl.textContent = 'Price unavailable';
    if (typeof binding.priceUnavailable === 'string') priceEl.title = binding.priceUnavailable;
  } else {
    priceEl.textContent = price(valueOf(binding, 'price'));
  }
  footer.append(priceEl);

  const url = valueOf(binding, 'url');
  if (safeHttp(url)) {
    const link = document.createElement('a');
    link.className = 'product-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View product →';
    footer.append(link);
  }

  parent.append(brand, name, type, badges, footer);
}

const FLIP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.5-5.8M20 12a8 8 0 0 1-13.5 5.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18 3v4h-4M6 21v-4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function createCard(binding, condition, allergenValue, ingredientsMap) {
  const card = document.createElement('article');
  card.className = 'product-card flip-card';
  const name = valueOf(binding, 'productName', 'Product');

  // FRONT — unchanged from the plain card: same image, same product info.
  const front = document.createElement('div');
  front.className = 'flip-face flip-face-front';
  front.append(createProductImage(name, valueOf(binding, 'image')));

  const body = document.createElement('div');
  body.className = 'product-body';
  addProductInfo(body, binding, condition, allergenValue, 'product-name');
  front.append(body);

  const flipTrigger = document.createElement('button');
  flipTrigger.type = 'button';
  flipTrigger.className = 'flip-trigger';
  flipTrigger.setAttribute('aria-label', `View ingredients for ${name}`);
  flipTrigger.setAttribute('aria-expanded', 'false');
  flipTrigger.title = 'View ingredients';
  flipTrigger.innerHTML = FLIP_ICON;
  front.append(flipTrigger);

  const flipHint = document.createElement('span');
  flipHint.className = 'flip-hint';
  flipHint.textContent = 'Flip for ingredients';
  flipHint.setAttribute('aria-hidden', 'true');
  front.append(flipHint);

  // BACK — the ingredient story.
  const back = buildIngredientBack(binding, name, ingredientsMap, condition, allergenValue);

  const inner = document.createElement('div');
  inner.className = 'flip-card-inner';
  inner.append(front, back);
  card.append(inner);

  setupCardFlip(card, flipTrigger, back, name);
  return card;
}

// Builds the reverse face: brand, name, an ingredient composition centred on
// the product's own photo, a one-line match explanation, and the back's
// actions. Ingredient content comes only from ingredientsMap; nothing here is
// invented when data is missing.
function buildIngredientBack(binding, name, ingredientsMap, condition, allergenValue) {
  const back = document.createElement('div');
  back.className = 'flip-face flip-face-back';
  back.setAttribute('aria-hidden', 'true');

  const brandText = valueOf(binding, 'brand', '');
  const typeText = valueOf(binding, 'type', '');
  const enriched = getEnrichedIngredients(name, ingredientsMap);
  back.dataset.tint = pickIngredientTint(enriched, typeText);

  const backToFront = document.createElement('button');
  backToFront.type = 'button';
  backToFront.className = 'flip-back-btn';
  backToFront.setAttribute('aria-label', 'Back to product');
  backToFront.title = 'Back to product';
  backToFront.innerHTML = FLIP_ICON;

  const header = document.createElement('div');
  header.className = 'back-header';
  const brand = document.createElement('span');
  brand.className = 'back-brand';
  brand.textContent = brandText;
  const heading = document.createElement('h4');
  heading.className = 'back-name';
  heading.textContent = name.replace(/\s+(\d+(?:\.\d+)?\s?(?:ml|g)\b)$/i, ' $1');
  header.append(brand, heading);

  const kicker = document.createElement('span');
  kicker.className = 'back-kicker';
  kicker.textContent = 'Key ingredients';

  const ranked = [...enriched].sort((a, b) => a.priority - b.priority);
  const keyIngredients = ranked.slice(0, 5);
  const composition = buildIngredientComposition(keyIngredients, binding, name);

  const matchNote = document.createElement('p');
  matchNote.className = 'back-match-note';
  matchNote.textContent = buildMatchExplanation(condition);

  const actions = document.createElement('div');
  actions.className = 'back-actions';

  if (enriched.length > keyIngredients.length) {
    const viewFull = document.createElement('button');
    viewFull.type = 'button';
    viewFull.className = 'back-view-full';
    viewFull.textContent = 'View full ingredients';
    viewFull.addEventListener('click', event => {
      event.stopPropagation();
      const keySet = new Set(keyIngredients.map(ing => ing.raw.toLowerCase()));
      const modal = ensureIngredientModal();
      modal.open({
        name,
        brand: brandText,
        matchExplanation: buildMatchExplanation(condition),
        filterStatus: `Ingredient filter: ${filterText(allergenValue)}`,
        ingredients: enriched.map(ing => ({ ...ing, isKey: keySet.has(ing.raw.toLowerCase()) }))
      }, viewFull);
    });
    actions.append(viewFull);
  }

  const url = valueOf(binding, 'url');
  if (safeHttp(url)) {
    const visit = document.createElement('a');
    visit.className = 'back-visit';
    visit.href = url;
    visit.target = '_blank';
    visit.rel = 'noopener noreferrer';
    visit.textContent = 'Visit product site ↗';
    visit.addEventListener('click', event => event.stopPropagation());
    actions.append(visit);
  }

  // Three zones, matching how the card is meant to read: a fixed-height
  // header, a flexible centre that claims whatever space a taller grid row
  // adds and centres the ingredient composition within it (so leftover
  // height becomes breathing room around the hero circle rather than a dead
  // gap under it), and a bottom block at its own natural size.
  const top = document.createElement('div');
  top.className = 'back-top';
  top.append(header, kicker);

  const centre = document.createElement('div');
  centre.className = 'back-centre';
  centre.append(composition);

  const bottom = document.createElement('div');
  bottom.className = 'back-bottom';
  bottom.append(matchNote, actions);

  back.append(backToFront, top, centre, bottom);
  return back;
}

// Product image centred, key ingredients flanking it as callouts (label,
// thin connector line, small anchor dot) split roughly evenly left/right, in
// the spirit of the ingredient-reference composition without depending on
// pixel-measured lines to the image, which would not survive the card's own
// responsive resizing.
function buildIngredientComposition(keyIngredients, binding, name) {
  const stage = document.createElement('div');
  stage.className = 'ingredient-stage';

  if (!keyIngredients.length) {
    // Still gets the hero circle treatment (grid-column: 2, via the shared
    // .ingredient-image class) so a product with no ingredient data doesn't
    // read as a broken/unfinished card next to ones that do.
    const imageWrap = document.createElement('div');
    imageWrap.className = 'ingredient-image';
    imageWrap.append(createProductImage(name, valueOf(binding, 'image')));
    const empty = document.createElement('p');
    empty.className = 'ingredient-empty';
    empty.textContent = 'Ingredient details are not currently available.';
    stage.append(imageWrap, empty);
    return stage;
  }

  const left = document.createElement('div');
  left.className = 'ingredient-callouts side-left';
  const right = document.createElement('div');
  right.className = 'ingredient-callouts side-right';
  const splitAt = Math.ceil(keyIngredients.length / 2);

  keyIngredients.forEach((ing, index) => {
    const callout = document.createElement('div');
    callout.className = 'callout';
    const dot = document.createElement('span');
    dot.className = 'callout-dot';
    dot.setAttribute('aria-hidden', 'true');
    const line = document.createElement('span');
    line.className = 'callout-line';
    line.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'callout-text';
    const label = document.createElement('strong');
    label.textContent = ing.label;
    text.append(label);
    if (ing.benefit) {
      const benefit = document.createElement('small');
      benefit.textContent = ing.benefit;
      text.append(benefit);
    }

    if (index < splitAt) {
      callout.append(text, line, dot);
      left.append(callout);
    } else {
      callout.append(dot, line, text);
      right.append(callout);
    }
  });

  const imageWrap = document.createElement('div');
  imageWrap.className = 'ingredient-image';
  imageWrap.append(createProductImage(name, valueOf(binding, 'image')));

  stage.append(left, imageWrap, right);
  return stage;
}

// Flip mechanics: click anywhere on the card toggles it, except on a link or
// button, which handles its own click and leaves the card as it is. Only one
// card is open at a time; opening a new one closes whichever was open.
function setupCardFlip(card, flipTrigger, back, name) {
  const backToFront = back.querySelector('.flip-back-btn');
  const inner = card.querySelector('.flip-card-inner');
  let open = false;

  // The front carries two purely decorative pseudo-elements (a gold corner
  // accent, a hover shine sweep). They only make sense on a card sitting
  // flat facing the viewer; mid-rotation their absolutely-positioned box
  // shadows can render at odd angles against the 3D-transformed face and
  // read as a stray line poking out of the card. .is-flipped only covers
  // the OPEN half of that (JS applies it before the opening animation
  // starts, but removes it before the closing one does), so a is-turning
  // class - live for both directions - is what actually needs to gate them.
  inner?.addEventListener('transitionstart', event => {
    if (event.propertyName === 'transform') card.classList.add('is-turning');
  });
  inner?.addEventListener('transitionend', event => {
    if (event.propertyName === 'transform') card.classList.remove('is-turning');
  });

  const focusableBackControls = () => [...back.querySelectorAll('a,button')];

  const setOpen = next => {
    if (next === open) return;
    open = next;
    card.classList.toggle('is-flipped', open);
    flipTrigger.setAttribute('aria-expanded', String(open));
    back.setAttribute('aria-hidden', String(!open));
    // Keep the hidden face out of the tab order so its content is never
    // announced or reachable while turned away from the viewer.
    focusableBackControls().forEach(el => { el.tabIndex = open ? 0 : -1; });
    flipTrigger.tabIndex = open ? -1 : 0;

    if (open) {
      if (openFlipCard && openFlipCard !== controller) openFlipCard.close();
      openFlipCard = controller;
      // Move focus into the revealed face so a keyboard user lands somewhere
      // reachable, rather than staying on a trigger that backface-visibility
      // has just turned away from the viewer.
      backToFront?.focus();
    } else if (openFlipCard === controller) {
      openFlipCard = null;
    }
  };

  const controller = {
    card,
    close: () => setOpen(false),
    isOpen: () => open
  };

  flipTrigger.addEventListener('click', event => {
    event.stopPropagation();
    setOpen(true);
  });
  backToFront?.addEventListener('click', event => {
    event.stopPropagation();
    setOpen(false);
    flipTrigger.focus();
  });
  card.addEventListener('click', event => {
    if (event.target.closest('a,button')) return;
    setOpen(!open);
  });
  card.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
      flipTrigger.focus();
    }
  });

  // Start every back face fully out of the tab order.
  focusableBackControls().forEach(el => { el.tabIndex = -1; });
}

// One modal, created on first use and reused for every card, so opening the
// full ingredient list never adds more than a handful of nodes to the page.
function ensureIngredientModal() {
  if (ingredientModal) return ingredientModal;

  const overlay = document.createElement('div');
  overlay.className = 'ingredient-modal-overlay';
  overlay.hidden = true;

  const modal = document.createElement('div');
  modal.className = 'ingredient-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.tabIndex = -1;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ingredient-modal-close';
  closeBtn.setAttribute('aria-label', 'Close ingredient list');
  closeBtn.innerHTML = CLOSE_ICON;

  const brand = document.createElement('p');
  brand.className = 'ingredient-modal-brand';
  const title = document.createElement('h4');
  title.className = 'ingredient-modal-title';
  const matchNote = document.createElement('p');
  matchNote.className = 'ingredient-modal-match';
  const filterNote = document.createElement('p');
  filterNote.className = 'ingredient-modal-filter';
  const list = document.createElement('ul');
  list.className = 'ingredient-modal-list';

  modal.append(closeBtn, brand, title, matchNote, filterNote, list);
  overlay.append(modal);
  document.body.append(overlay);

  let returnFocus = null;
  const close = () => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove('ingredient-modal-open');
    // Lenis drives scrolling from its own rAF loop, so it needs telling
    // explicitly to resume — see the identical note on cosmoLockScroll.
    window.cosmoLockScroll?.(false);
    returnFocus?.focus();
  };
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !overlay.hidden) close();
  });

  ingredientModal = {
    open(data, trigger) {
      returnFocus = trigger || null;
      brand.textContent = data.brand || '';
      title.textContent = data.name;
      matchNote.textContent = data.matchExplanation;
      filterNote.textContent = data.filterStatus;
      list.replaceChildren();
      data.ingredients.forEach(ing => {
        const item = document.createElement('li');
        item.className = 'ingredient-modal-item';
        item.classList.toggle('is-key', Boolean(ing.isKey));
        const label = document.createElement('span');
        label.className = 'ingredient-modal-item-name';
        label.textContent = ing.label;
        item.append(label);
        if (ing.benefit) {
          const benefit = document.createElement('span');
          benefit.className = 'ingredient-modal-item-benefit';
          benefit.textContent = ing.benefit;
          item.append(benefit);
        }
        list.append(item);
      });
      overlay.hidden = false;
      document.body.classList.add('ingredient-modal-open');
      window.cosmoLockScroll?.(true);
      requestAnimationFrame(() => modal.focus());
    },
    close
  };
  return ingredientModal;
}

// Clicking anywhere outside the open card closes it; this is one listener
// for every card, not one per card.
document.addEventListener('click', event => {
  if (openFlipCard && !openFlipCard.card.contains(event.target)) openFlipCard.close();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && openFlipCard) openFlipCard.close();
});

// ---------------------------------------------------------------------------
// Featured product story
// ---------------------------------------------------------------------------

// Renders up to four featured products as a sticky, scroll-driven sequence
// (01/04 → 04/04) with the rest in the More Matches grid. On mobile or with
// reduced motion everything goes straight to the grid.
function renderResults(bindings, condition, allergenValue, ingredientsMap) {
  if (resultStoryCleanup) resultStoryCleanup();
  restoreResultsIntro();
  story.replaceChildren();
  productGrid.replaceChildren();
  moreTitle.classList.remove('visible');

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = matchMedia('(max-width: 850px)').matches;
  const featured = bindings.slice(0, Math.min(4, bindings.length));
  const remaining = bindings.slice(featured.length);

  if (mobile || reduced || featured.length < 2) {
    bindings.forEach(item => productGrid.append(createCard(item, condition, allergenValue, ingredientsMap)));
    moreTitle.classList.add('visible');
    return;
  }

  // Build the sticky story shell: stage (left), details (right), arc + controls.
  const shell = document.createElement('div');
  shell.className = 'story-shell';
  const stickyFrame = document.createElement('div');
  stickyFrame.className = 'results-story-frame';
  const sticky = document.createElement('div');
  sticky.className = 'featured-layout story-sticky';
  const stage = document.createElement('div');
  stage.className = 'story-stage';
  const details = document.createElement('div');
  details.className = 'story-details';
  const progress = document.createElement('div');
  progress.className = 'story-progress';

  const products = [];
  const detailItems = [];
  const arcPoints = [];
  const arc = document.createElement('div');
  const arcTrack = document.createElement('div');
  const arcIndicator = document.createElement('span');
  const controls = document.createElement('div');
  const previous = document.createElement('button');
  const next = document.createElement('button');

  arc.className = 'story-arc';
  arcTrack.className = 'story-arc-track';
  arcIndicator.className = 'story-arc-indicator';
  arc.append(arcTrack, arcIndicator);

  controls.className = 'story-controls';
  previous.className = 'story-control';
  next.className = 'story-control';
  previous.type = next.type = 'button';
  previous.setAttribute('aria-label', 'Previous featured match');
  next.setAttribute('aria-label', 'Next featured match');
  previous.textContent = '←';
  next.textContent = '→';
  controls.append(previous, next);

  featured.forEach((item, index) => {
    const product = document.createElement('div');
    product.className = 'story-product';
    product.append(createProductImage(valueOf(item, 'productName', 'Product'), valueOf(item, 'image')));
    stage.append(product);
    products.push(product);

    const detail = document.createElement('article');
    detail.className = 'story-detail';
    addProductInfo(detail, item, condition, allergenValue);
    const ingredientsBlock = buildStoryIngredients(item, valueOf(item, 'productName', 'Product'), ingredientsMap, condition);
    if (ingredientsBlock) detail.insertBefore(ingredientsBlock, detail.querySelector('.product-footer'));
    details.append(detail);
    detailItems.push(detail);

    // Place numbered points along a semicircular arc over the stage.
    const point = document.createElement('button');
    const ratio = index / (featured.length - 1);
    const angle = Math.PI - ratio * Math.PI;
    point.type = 'button';
    point.className = 'story-arc-point';
    point.textContent = String(index + 1).padStart(2, '0');
    point.setAttribute('aria-label', `Show featured match ${index + 1}`);
    point.style.left = `${50 + 42 * Math.cos(angle)}%`;
    point.style.top = `${50 - 39 * Math.sin(angle)}%`;
    arc.append(point);
    arcPoints.push(point);
  });

  stage.append(arc, controls, progress);
  sticky.append(stage, details);
  stickyFrame.append(resultsHeader, resultsMeta, sticky);
  shell.append(stickyFrame);
  story.append(shell);
  remaining.forEach(item => productGrid.append(createCard(item, condition, allergenValue, ingredientsMap)));
  moreTitle.classList.toggle('visible', remaining.length > 0);

  // Give the shell enough height to scroll through every featured product,
  // plus a short hold at the end.
  const sizeStory = () => {
    const transitionDistance = Math.min(window.innerHeight * .24, 240);
    const finalHoldDistance = Math.min(window.innerHeight * .12, 110);
    const storyHeight = stickyFrame.offsetHeight + (featured.length - 1) * transitionDistance + finalHoldDistance;
    shell.style.height = `${Math.round(storyHeight)}px`;
  };
  const scheduleStorySize = () => requestAnimationFrame(() => {
    sizeStory();
    update();
  });
  sizeStory();
  addEventListener('resize', scheduleStorySize, { passive: true });
  stage.querySelectorAll('img').forEach(image => {
    if (image.complete) {
      scheduleStorySize();
    } else {
      image.addEventListener('load', scheduleStorySize, { once: true });
      image.addEventListener('error', scheduleStorySize, { once: true });
    }
  });

  let activeIndex = 0;
  let lastActive = -1;

  const getStickyStart = () => (document.querySelector('.nav')?.offsetHeight || 0) + 12;

  // Scrolls the page to the position where the requested product is active.
  const goTo = index => {
    const targetIndex = Math.max(0, Math.min(featured.length - 1, index));
    const travel = Math.max(1, shell.offsetHeight - stickyFrame.offsetHeight);
    const targetProgress = Math.min(.98, targetIndex / featured.length + .01);
    const target = scrollY + shell.getBoundingClientRect().top - getStickyStart() + travel * targetProgress;
    if (lenis) lenis.scrollTo(target, { duration: .72 });
    else scrollTo({ top: target, behavior: 'smooth' });
  };
  previous.addEventListener('click', () => goTo(activeIndex - 1));
  next.addEventListener('click', () => goTo(activeIndex + 1));
  arcPoints.forEach((point, index) => point.addEventListener('click', () => goTo(index)));

  // Refined skincare scenes: [center, edge, glow] — 01 sage/ivory · 02 blush/sand · 03 eucalyptus/champagne · 04 lavender-grey/pearl
  const scenePalettes = [
    ['#f6f3e8', '#d4ddc9', '#cdd8bd'],
    ['#f8efe6', '#e4c7b6', '#e7c4b1'],
    ['#f3f1e3', '#ccd9cc', '#cfdccb'],
    ['#f3f1f4', '#cfccdc', '#d1ccdf']
  ];
  const hexToRgb = hex => {
    const value = parseInt(hex.slice(1), 16);
    return [value >> 16 & 255, value >> 8 & 255, value & 255];
  };
  const paletteRgb = scenePalettes.map(scene => scene.map(hexToRgb));
  const mixRgb = (a, b, t) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`;
  const smoothstep = (edge0, edge1, x) => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  const lastIndex = featured.length - 1;

  // Driven every frame from the animation loop while the story is on screen.
  const update = () => {
    const stickyStart = getStickyStart();
    const rect = shell.getBoundingClientRect();
    const travel = Math.max(1, shell.offsetHeight - stickyFrame.offsetHeight);
    const progressValue = Math.min(1, Math.max(0, (stickyStart - rect.top) / travel));
    const position = progressValue * lastIndex;
    const base = Math.min(lastIndex - 1, Math.max(0, Math.floor(position)));
    const frac = position - base;
    const blend = smoothstep(.05, .95, frac);
    const active = progressValue >= .94 ? lastIndex : Math.min(lastIndex, Math.floor(progressValue * featured.length));
    activeIndex = active;

    products.forEach((item, index) => {
      const selected = index === active;
      item.classList.toggle('is-active', selected);
      item.style.setProperty('--opacity', selected ? '1' : '0');
      item.style.setProperty('--product-y', selected ? '0px' : index < active ? '-24px' : '24px');
      item.style.setProperty('--product-x', '0px');
      item.style.setProperty('--product-scale', selected ? '1' : '.96');
      item.style.setProperty('--visibility', selected ? 'visible' : 'hidden');
      item.style.zIndex = selected ? '3' : '1';
    });

    detailItems.forEach((item, index) => {
      const selected = index === active;
      item.classList.toggle('is-active', selected);
      item.style.setProperty('--opacity', selected ? '1' : '0');
      item.style.setProperty('--detail-x', selected ? '0px' : index < active ? '-22px' : '22px');
      item.style.setProperty('--detail-y', '0px');
      item.style.setProperty('--visibility', selected ? 'visible' : 'hidden');
      item.style.zIndex = selected ? '3' : '1';
    });

    arcPoints.forEach((point, index) => point.classList.toggle('is-active', index === active));
    const pathAngle = Math.PI - (position / lastIndex) * Math.PI;
    arcIndicator.style.left = `${50 + 42 * Math.cos(pathAngle)}%`;
    arcIndicator.style.top = `${50 - 39 * Math.sin(pathAngle)}%`;

    // Blend the stage backdrop between neighbouring scene palettes.
    const from = paletteRgb[base % paletteRgb.length];
    const to = paletteRgb[(base + 1) % paletteRgb.length];
    stage.style.setProperty('--scene-a', mixRgb(from[0], to[0], blend));
    stage.style.setProperty('--scene-b', mixRgb(from[1], to[1], blend));
    stage.style.setProperty('--scene-glow', mixRgb(from[2], to[2], blend));

    previous.disabled = active === 0;
    next.disabled = active === lastIndex;

    progress.textContent = `MATCH ${String(active + 1).padStart(2, '0')} / ${String(featured.length).padStart(2, '0')}`;
    if (active !== lastActive) {
      // Restart the pop animation on the progress pill.
      progress.classList.remove('is-changing');
      void progress.offsetWidth;
      progress.classList.add('is-changing');
      setTimeout(() => progress.classList.remove('is-changing'), 300);
      lastActive = active;
    }
  };

  resultStoryUpdate = () => {
    sizeStory();
    update();
  };
  update();
  resultStoryCleanup = () => {
    removeEventListener('resize', scheduleStorySize);
    if (resultStoryUpdate) resultStoryUpdate = null;
  };
}

// ---------------------------------------------------------------------------
// Loading and error states
// ---------------------------------------------------------------------------

function startLoading() {
  let index = 0;
  loadingMsg.textContent = LOADING_MESSAGES[0];
  clearInterval(loadingInterval);
  loadingInterval = setInterval(() => {
    index = (index + 1) % LOADING_MESSAGES.length;
    loadingMsg.textContent = LOADING_MESSAGES[index];
  }, 1800);
}

function setSearchBusy(busy) {
  isSearching = busy;
  quizForm.setAttribute('aria-busy', String(busy));
  results.setAttribute('aria-busy', String(busy));
  [
    ...skinProblemOpts.querySelectorAll('button'),
    ...allergenOpts.querySelectorAll('button'),
    ...selectionChips.querySelectorAll('button'),
    clearConcernsButton,
    browseAllButton,
    resetChoicesButton
  ].filter(Boolean).forEach(button => { button.disabled = busy; });
  findBtn.classList.toggle('is-loading', busy);
  // Only the label text changes: rewriting textContent would delete the arrow.
  if (findBtnLabel) findBtnLabel.textContent = busy ? 'Finding matches…' : 'View my matches';
  findBtn.disabled = busy || !selectedConditions().length;
  // Once the search finishes, refresh the panel so its summary line picks up
  // the result count that findProducts just recorded.
  if (!busy) updateOnboarding();
}

function scrollToResults() {
  const navHeight = document.querySelector('.nav')?.offsetHeight || 0;
  const targetTop = window.scrollY + results.getBoundingClientRect().top - navHeight - 12;
  if (lenis) {
    lenis.resize();
    lenis.scrollTo(targetTop, { duration: .9 });
  } else {
    window.scrollTo({ top: targetTop, behavior: 'smooth' });
  }
}

// Resolves once the featured images have loaded, capped at 1.4s so a slow
// image can't hold up the scroll.
function waitForFeaturedImages() {
  const images = [...story.querySelectorAll('.story-stage img')];
  if (!images.length) return Promise.resolve();
  const pending = images.map(image => image.complete
    ? Promise.resolve()
    : new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      }));
  return Promise.race([Promise.all(pending), new Promise(resolve => setTimeout(resolve, 1400))]);
}

// Wait for the layout to stabilise before scrolling to the results.
async function settleResultsAndScroll() {
  await waitForFeaturedImages();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (lenis) lenis.resize();
  if (resultStoryUpdate) resultStoryUpdate();
  results.classList.remove('is-settling');
  results.classList.add('is-ready');
  requestAnimationFrame(() => requestAnimationFrame(scrollToResults));
}

// ---------------------------------------------------------------------------
// Product search
// ---------------------------------------------------------------------------

async function findProducts() {
  const conditions = selectedConditions();
  const allergenValue = allergen.value;

  // Track this request so a newer search can invalidate stale responses.
  const requestId = ++searchRequestId;
  if (requestController) requestController.abort();
  requestController = new AbortController();
  setSearchBusy(true);

  onboardingStep = 3;
  updateOnboarding();

  const concernsLabel = conditions.length ? conditionText(conditions) : 'All products';
  document.getElementById('results-title').textContent = conditions.length ? 'Your matches.' : 'The full collection.';
  restoreResultsIntro();
  formMessage.textContent = '';
  results.classList.remove('is-ready');
  results.classList.add('is-settling');
  show(results);
  show(loading);
  hide(errorBox);
  hide(emptyBox);
  story.replaceChildren();
  productGrid.replaceChildren();
  moreTitle.classList.remove('visible');
  resultsCount.textContent = 'Loading…';
  resultsMeta.textContent = `${concernsLabel} · ${filterText(allergenValue)} · Lowest price first`;
  startLoading();

  try {
    const response = await fetch(`${ENDPOINT}?query=${encodeURIComponent(buildQuery(conditions, allergenValue))}`, {
      headers: { Accept: 'application/sparql-results+json' },
      signal: requestController.signal
    });
    if (!response.ok) throw new Error(`Recommendation service returned ${response.status}`);

    const data = await response.json();
    if (requestId !== searchRequestId) return;

    // Deduplicate by product URL (falling back to name) while keeping order.
    const bindings = Array.isArray(data?.results?.bindings) ? data.results.bindings : [];
    const uniqueBindings = [...new Map(bindings.map(item => [item.url?.value || item.productName?.value, item])).values()];

    // Overlay verified retailer prices before anything is measured or drawn,
    // so the count, the ordering and the cards all agree on one set of figures.
    // Ingredient data loads alongside it; the two queries are independent.
    const [corrections, ingredientsMap] = await Promise.all([loadPriceCorrections(), loadIngredientData()]);
    if (requestId !== searchRequestId) return;
    applyPriceCorrections(uniqueBindings, corrections);

    clearInterval(loadingInterval);
    hide(loading);

    if (!uniqueBindings.length) {
      emptyBox.querySelector('p').textContent = allergenValue === 'Both'
        ? 'No products match every selected concern while excluding both fragrance and alcohol. Try fewer concerns or one exclusion.'
        : 'No products matched every selected concern. Try removing one concern or changing the ingredient filter.';
      show(emptyBox);
      resultsCount.textContent = '0 products';
      lastMatchCount = 0;
      await settleResultsAndScroll();
      return;
    }

    resultsCount.textContent = `${uniqueBindings.length} product${uniqueBindings.length === 1 ? '' : 's'}`;
    // Feed the count back into the profile panel's summary line.
    lastMatchCount = uniqueBindings.length;
    renderResults(uniqueBindings, conditions, allergenValue, ingredientsMap);
    await settleResultsAndScroll();
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== searchRequestId) return;
    console.error('COSMO SELECT recommendation error', error);
    clearInterval(loadingInterval);
    hide(loading);

    errorBox.replaceChildren();
    const message = document.createElement('p');
    message.textContent = 'We couldn’t load the recommendations. Please check your connection and try again.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-primary';
    retry.textContent = 'Try again';
    retry.addEventListener('click', findProducts);
    errorBox.append(message, retry);
    show(errorBox);
    resultsCount.textContent = 'Unavailable';
    results.classList.remove('is-settling');
    results.classList.add('is-ready');
  } finally {
    if (requestId === searchRequestId) {
      clearInterval(loadingInterval);
      setSearchBusy(false);
      requestController = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Scroll and motion setup
// ---------------------------------------------------------------------------

// Prepares the per-frame scroll handler: nav state, hero parallax, and the
// scroll-driven video sequence. The handler itself runs from the animation
// loop in setupScrolling().
function setupMotion() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = matchMedia('(max-width: 768px)').matches;

  const home = document.getElementById('home');
  const displayWord = home.querySelector('.hero-display-word');
  const section = document.getElementById('video-scroll');
  const frame = document.getElementById('videoFrame');
  const videos = [...section.querySelectorAll('video')];
  const transition = document.querySelector('.video-transition');
  const moments = [...document.querySelectorAll('.video-moment')];
  const nav = document.querySelector('.nav');
  const navAnchors = [...document.querySelectorAll('.nav-links a')];
  // Footer holds the #contact anchor, so it joins the scroll-spy list.
  const sections = [...document.querySelectorAll('main>section'), document.getElementById('contact')].filter(Boolean);

  const playVideos = () => {
    if (!reduced) videos.forEach(video => {
      if (video.paused) video.play().catch(() => {});
    });
  };
  videos.forEach(video => {
    video.addEventListener('canplay', playVideos);
    video.addEventListener('error', () => { videoFallback.style.display = 'block'; });
    if (reduced) {
      video.removeAttribute('autoplay');
      video.pause();
    }
  });

  const clamp = value => Math.min(1, Math.max(0, value));

  pageMotionUpdate = () => {
    const y = scrollY;
    nav.classList.toggle('scrolled', y > 24);

    // Highlight the nav link for the section under the upper-middle of the viewport.
    const marker = y + innerHeight * .42;
    let activeId = 'home';
    sections.forEach(item => {
      if (marker >= item.offsetTop) activeId = item.id;
    });
    // The footer is short, so treat reaching the page bottom as Contact.
    if (y + innerHeight >= document.documentElement.scrollHeight - 40) activeId = 'contact';
    navAnchors.forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${activeId}`));

    if (!reduced && !mobile) {
      const heroProgress = clamp(y / Math.max(1, home.offsetHeight));
      home.style.setProperty('--hero-bg-y', `${heroProgress * 20}px`);
      displayWord.style.setProperty('--display-parallax', `${(heroProgress * 14).toFixed(1)}px`);
    }
    if (reduced || mobile) return;

    // Progress through the tall video section drives the frame expansion,
    // caption fades, and the closing curtain.
    const rect = section.getBoundingClientRect();
    const available = Math.max(1, section.offsetHeight - innerHeight);
    const raw = clamp(-rect.top / available);

    if (rect.bottom > 0 && rect.top < innerHeight) playVideos();
    else videos.forEach(video => { if (!video.paused) video.pause(); });

    const expansion = clamp(raw / .68);
    frame.style.setProperty('--video-inset', `${12 * (1 - expansion)}%`);
    frame.style.setProperty('--video-radius', `${28 * (1 - expansion)}px`);

    moments.forEach(moment => {
      const start = Number(moment.dataset.start);
      const end = Number(moment.dataset.end);
      const fade = .075;
      const opacity = Math.min(clamp((raw - start) / fade), clamp((end - raw) / fade));
      moment.style.opacity = opacity;
      moment.style.transform = `translate3d(-50%,${(1 - opacity) * 22}px,0)`;
    });

    transition.style.setProperty('--transition-y', `${100 - clamp((raw - .82) / .18) * 100}%`);
  };
}

function setupScrolling() {
  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const mobileQuery = matchMedia('(max-width: 768px)');
  const coarseInput = () => reducedQuery.matches || mobileQuery.matches;

  // Smooth scrolling is re-decided whenever the viewport or the motion
  // preference changes, not just once on load. Deciding once meant a page
  // opened in a narrow window — or a tablet held in portrait, or a browser
  // restored small and then maximised — never created Lenis at all, and since
  // the magnetic recentre below runs through Lenis, the pull stayed dead for
  // the whole session however wide the window later became. That is what made
  // it look like it worked only sometimes.
  const syncSmoothScrolling = () => {
    const wanted = !coarseInput() && !!window.Lenis;
    if (wanted && !lenis) {
      try {
        lenis = new Lenis({
          duration: 1.25,
          easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
          smoothWheel: true,
          wheelMultiplier: .9,
          touchMultiplier: 1,
          syncTouch: false
        });
      } catch (error) {
        console.warn('Lenis unavailable; using native scrolling.', error);
        lenis = null;
      }
    } else if (!wanted && lenis) {
      lenis.destroy();
      lenis = null;
    }
  };
  syncSmoothScrolling();
  reducedQuery.addEventListener('change', syncSmoothScrolling);
  mobileQuery.addEventListener('change', syncSmoothScrolling);

  // Anchor links route through Lenis when it's active.
  document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', event => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    event.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: -82, duration: 1.4 });
    else target.scrollIntoView({ behavior: reducedQuery.matches ? 'auto' : 'smooth', block: 'start' });
  }));

  // Magnetic snap: when scrolling settles with the consultation section
  // nearby, glide its top edge to the viewport so the frame is never half-cut.
  {
    const matchSection = document.getElementById('find-your-match');
    let settleTimer = null;
    let snapping = false;
    // Direction of the gesture that is currently settling.
    let gestureStartY = window.scrollY;
    let gestureActive = false;

    const sectionDelta = () => {
      const navHeight = document.querySelector('.nav')?.offsetHeight || 0;
      return matchSection.getBoundingClientRect().top - navHeight - 12;
    };

    // WHY DIRECTION RATHER THAN AN ARMED LATCH
    // ----------------------------------------
    // The magnet used to disarm after each capture and only re-arm once the
    // reader moved 0.85 x viewport away. That distance is larger than the
    // capture band itself, so backing off by less — which is the normal way
    // anyone re-approaches a section — left it disarmed and the pull simply
    // never came. It worked on the first approach and looked broken after
    // that.
    //
    // The latch was really there to stop the magnet yanking a reader back
    // while they scroll down through the section. Direction says that
    // directly: pull only when the section's top edge is travelling TOWARD
    // the capture line, never when it is moving away. Approaching from either
    // side still captures, and scrolling on through is left alone.
    const CAPTURE_LOW = () => -innerHeight * 0.45;
    const CAPTURE_HIGH = () => innerHeight * 0.66;
    const MIN_GESTURE = 2;   // ignore sub-pixel jitter

    window.addEventListener('scroll', () => {
      // Checked live rather than captured at start-up, so the magnet becomes
      // available the moment smooth scrolling does.
      if (!lenis || coarseInput()) return;
      if (snapping || isSearching) return;
      if (!gestureActive) {
        gestureStartY = window.scrollY;
        gestureActive = true;
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        gestureActive = false;
        const delta = sectionDelta();

        if (Math.abs(delta) <= 8) return;                              // already centred
        if (delta <= CAPTURE_LOW() || delta >= CAPTURE_HIGH()) return; // out of range

        const moved = window.scrollY - gestureStartY;
        if (Math.abs(moved) < MIN_GESTURE) return;
        // delta > 0: the section sits below the line, so scrolling down closes
        // the gap. delta < 0: it sits above, so scrolling up closes it.
        const approaching = delta > 0 ? moved > 0 : moved < 0;
        if (!approaching) return;

        snapping = true;
        lenis.scrollTo(window.scrollY + delta, {
          duration: 0.9,
          onComplete: () => { snapping = false; }
        });
        setTimeout(() => { snapping = false; }, 1400);
      }, 120);
    }, { passive: true });
  }

  // Single rAF loop drives Lenis, the page motion handler, and the story.
  const animationLoop = time => {
    if (lenis) lenis.raf(time);
    if (pageMotionUpdate) pageMotionUpdate();
    if (resultStoryUpdate) resultStoryUpdate();
    requestAnimationFrame(animationLoop);
  };
  requestAnimationFrame(animationLoop);
}

// The neutral stage video isn't a seamless loop, so near the end we crossfade
// into a second copy of the same clip and swap roles.
function setupNeutralVideoLoop() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    concernNeutralVideos.forEach(video => video.pause());
    return;
  }
  concernNeutralVideos.forEach(video => { video.playbackRate = .82; });

  const monitor = () => {
    const current = concernNeutralVideos[neutralVideoIndex];
    if (
      concernStage.classList.contains('is-neutral') &&
      !neutralCrossfading &&
      Number.isFinite(current.duration) &&
      current.duration > 1 &&
      current.currentTime >= current.duration - .82
    ) {
      neutralCrossfading = true;
      const nextIndex = 1 - neutralVideoIndex;
      const next = concernNeutralVideos[nextIndex];
      next.currentTime = 0;
      next.classList.add('is-visible');
      next.classList.remove('is-fading');
      next.play().catch(() => {});
      current.classList.add('is-fading');
      neutralCrossfadeTimer = setTimeout(() => {
        current.pause();
        current.currentTime = 0;
        current.classList.remove('is-visible', 'is-fading');
        neutralVideoIndex = nextIndex;
        neutralCrossfading = false;
      }, 760);
    }
    requestAnimationFrame(monitor);
  };
  playNeutralConcern();
  requestAnimationFrame(monitor);
}

// Reveal-on-scroll, hero word animation, and pointer parallax. Skipped
// entirely under reduced motion.
function setupPremiumMotion() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.documentElement.classList.add('motion-ready');

  // Split the hero title into per-word spans for the staggered reveal.
  const title = document.getElementById('hero-title');
  const titleText = title.textContent.trim();
  // Words inside <em> keep their italic accent styling after the split.
  const accentWords = new Set((title.querySelector('em')?.textContent.trim().split(/\s+/)) || []);
  const words = titleText.split(/\s+/);
  title.setAttribute('aria-label', titleText);
  title.replaceChildren(...words.map((word, index) => {
    const span = document.createElement('span');
    span.className = accentWords.has(word) ? 'hero-word hero-word-accent' : 'hero-word';
    span.style.setProperty('--word-index', index);
    span.setAttribute('aria-hidden', 'true');
    span.textContent = word;
    return span;
  }));

  const revealGroups = [
    ['.match-intro', ''],
    ['.match-steps', ''],
    ['.filter-panel', 'reveal-left'],
    ['.concern-stage', ''],
    ['.concern-rail', 'reveal-right'],
    ['.results-header', ''],
    ['.more-title', ''],
    ['footer .footer-inner', '']
  ];
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }), { threshold: .14, rootMargin: '0px 0px -7% 0px' });
  revealGroups.forEach(([selector, direction]) => document.querySelectorAll(selector).forEach(element => {
    element.classList.add('reveal-on-scroll');
    if (direction) element.classList.add(direction);
    observer.observe(element);
  }));

  const videoSection = document.getElementById('video-scroll');
  const sectionObserver = new IntersectionObserver(
    entries => entries.forEach(entry => videoSection.classList.toggle('is-visible', entry.isIntersecting)),
    { threshold: .08 }
  );
  sectionObserver.observe(videoSection);

  // Subtle pointer parallax on the hero and the concern stage (mouse only).
  const home = document.getElementById('home');
  const copy = home.querySelector('.hero-copy');
  home.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    const rect = home.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - .5;
    const y = (event.clientY - rect.top) / rect.height - .5;
    home.style.setProperty('--hero-depth-x', `${(x * -12).toFixed(1)}px`);
    home.style.setProperty('--hero-depth-y', `${(y * -9).toFixed(1)}px`);
    copy.style.setProperty('--copy-depth-x', `${(x * 5).toFixed(1)}px`);
    copy.style.setProperty('--copy-depth-y', `${(y * 4).toFixed(1)}px`);
  }, { passive: true });
  home.addEventListener('pointerleave', () => {
    home.style.setProperty('--hero-depth-x', '0px');
    home.style.setProperty('--hero-depth-y', '0px');
    copy.style.setProperty('--copy-depth-x', '0px');
    copy.style.setProperty('--copy-depth-y', '0px');
  }, { passive: true });

  concernStage.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    const rect = concernStage.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - .5;
    const y = (event.clientY - rect.top) / rect.height - .5;
    concernStage.style.setProperty('--concern-x', `${(x * 9).toFixed(1)}px`);
    concernStage.style.setProperty('--concern-y', `${(y * 7).toFixed(1)}px`);
  }, { passive: true });
  concernStage.addEventListener('pointerleave', () => {
    concernStage.style.setProperty('--concern-x', '0px');
    concernStage.style.setProperty('--concern-y', '0px');
  }, { passive: true });
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

quizForm.addEventListener('submit', event => {
  event.preventDefault();
  findProducts();
});
resetChoicesButton.addEventListener('click', resetChoices);

// "Clear all" drops every concern but leaves the ingredient preference alone;
// "Reset profile" is the one action that clears everything.
clearConcernsButton?.addEventListener('click', () => {
  if (isSearching) return;
  [...skinProblem.options].forEach(option => { option.selected = false; });
  activeConcern = '';
  onboardingStep = 1;
  lastMatchCount = null;
  formMessage.textContent = '';
  showNeutralConcern();
});

// "Browse all products" is the old no-concerns submit: the full catalogue is
// what the query returns when nothing is selected, so clear and search.
browseAllButton?.addEventListener('click', () => {
  if (isSearching) return;
  [...skinProblem.options].forEach(option => { option.selected = false; });
  activeConcern = '';
  lastMatchCount = null;
  formMessage.textContent = '';
  showNeutralConcern();
  findProducts();
});

// Mobile navigation drawer.
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
navToggle.addEventListener('click', () => {
  const open = navLinks.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('menu-open', open);
});
navLinks.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
  navLinks.classList.remove('open');
  navToggle.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
}));

// ---------------------------------------------------------------------------
// Application initialization
// ---------------------------------------------------------------------------

renderOptions();
showNeutralConcern();
setupNeutralVideoLoop();
setupPremiumMotion();
setupMotion();
setupScrolling();

// ---------------------------------------------------------------------------
// Bridge for the visual skin-screening module (js/skin-scan.js)
// ---------------------------------------------------------------------------

// Selects the given concern values through the existing form state. The
// screening only suggests and preselects; the user still reviews, edits and
// submits through the normal buildQuery()/findProducts() flow.
window.cosmoApplyConcerns = values => {
  const allowed = new Set([...skinProblem.options].map(option => option.value));
  const wanted = values.filter(value => allowed.has(value));
  if (!wanted.length) return false;
  [...skinProblem.options].forEach(option => {
    option.selected = wanted.includes(option.value);
  });
  activeConcern = wanted[wanted.length - 1];
  onboardingStep = 2;
  formMessage.textContent = '';
  updateConcernPreview(activeConcern);
  return true;
};

// Lenis drives scrolling from its own rAF loop, so `overflow: hidden` on the
// body does not stop it. Modal overlays must pause it explicitly, otherwise
// the page keeps scrolling behind the dialog.
window.cosmoLockScroll = locked => {
  if (!lenis) return;
  if (locked) lenis.stop();
  else lenis.start();
};
