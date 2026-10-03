#!/usr/bin/env node

/**
 * Melbourne Phone Hub source-level regression checks.
 *
 * These checks are deliberately DOM-independent so they can run without a
 * browser, Supabase, TouchDesigner or the gallery network. They are not a
 * substitute for device, assistive-technology or TD integration testing.
 *
 * Run from the repository root:
 *   node tests/melbourne_static_checks.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const source = {
  app: read('app.js'),
  config: read('config.js'),
  content: read('melbourne-content.js'),
  db: read('db.js'),
  measure: read('measure.js'),
  html: read('index.html'),
  css: read('styles.css'),
  notice: read('MELBOURNE_ONSITE_ACCESS_NOTICE.md'),
  migration: read('supabase_migration_20260927_melbourne_td_station_lifecycle.sql'),
  rollback: read('supabase_rollback_20260927_melbourne_claim_wrapper.sql'),
};

function functionSource(text, name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const match = signature.exec(text);
  if (!match) return '';
  // Application functions are top-level declarations. Stopping at the next
  // top-level function avoids pretending to parse JavaScript templates here,
  // while still giving every source assertion the complete function body.
  const tail = text.slice(match.index + match[0].length);
  const nextFunction = /\n(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/m.exec(tail);
  const end = nextFunction
    ? match.index + match[0].length + nextFunction.index
    : text.length;
  return text.slice(match.index, end);
}

function sliceBetween(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start < 0) return '';
  const tail = text.slice(start);
  const end = tail.search(endPattern);
  return end < 0 ? tail : tail.slice(0, end);
}

function lastCssProperty(css, selector, property) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...css.matchAll(new RegExp(`(?:^|})\\s*${escapedSelector}\\s*\\{([^}]*)}`, 'gm'))];
  let value = null;
  for (const block of blocks) {
    const properties = [...block[1].matchAll(new RegExp(`${property}\\s*:\\s*([^;]+)`, 'g'))];
    if (properties.length) value = properties.at(-1)[1].trim();
  }
  return value;
}

const results = [];
function check(name, predicate, hint, { required = true } = {}) {
  let passed = false;
  let error = null;
  try {
    passed = Boolean(typeof predicate === 'function' ? predicate() : predicate);
  } catch (caught) {
    error = caught;
  }
  results.push({ name, passed, hint, required, error });
}

const finalSpecimen = functionSource(source.app, 'screenFinalSpecimen');
const screenArrival = functionSource(source.app, 'screenArrival');
const screenPersonalSetup = functionSource(source.app, 'screenPersonalSetup');
const screenHome = functionSource(source.app, 'screenHome');
const screenModule = functionSource(source.app, 'screenModule');
const globalHeader = functionSource(source.app, 'globalHeader');
const languageChooser = functionSource(source.app, 'openLanguageChooser');
const roseMenu = functionSource(source.app, 'openRoseMenu');
const updateDocumentContext = functionSource(source.app, 'updateDocumentContext');
const largeTextEnabled = functionSource(source.app, 'largeTextEnabled');
const toggleLargeText = functionSource(source.app, 'toggleLargeText');
const stationConnectionPanel = functionSource(source.app, 'stationConnectionPanel');
const requestStationConnection = functionSource(source.app, 'requestStationConnection');
const visibleStationRevalidation = functionSource(source.app, 'revalidateVisibleModuleConnection');
const provisionalFloorplan = functionSource(source.app, 'melbourneProvisionalFloorplan');
const floorplanRouteOrder = functionSource(source.app, 'floorplanRouteOrder');
const assetFrameSource = functionSource(source.app, 'assetFrame');
const moduleHeroSource = functionSource(source.app, 'moduleHero');
const accessGuide = functionSource(source.app, 'screenAccessGuide');
const capturePanel = functionSource(source.app, 'captureResultPanel');
const capturePolling = functionSource(source.app, 'startModuleCapturePolling');
const isRegistered = functionSource(source.app, 'isRegistered');
const displayNameSource = functionSource(source.app, 'displayName');
const visitorRoseNameSource = functionSource(source.app, 'visitorRoseName');
const seedTestSession = functionSource(source.app, 'seedTestSession');
const boot = functionSource(source.app, 'boot');
const routeAfterRoseSetup = functionSource(source.app, 'routeAfterRoseSetup');
const resultRouter = functionSource(source.app, 'renderCurrentView');
const activeTabDialog = functionSource(source.app, 'activeTabOverlay');
const tabRuntime = functionSource(source.app, 'setTabRuntimeActive');
const closeLanguageChooser = functionSource(source.app, 'closeLanguageChooser');
const closeRoseMenu = functionSource(source.app, 'closeRoseMenu');
const goHome = functionSource(source.app, 'goHome');
const releaseStation = functionSource(source.app, 'releaseCurrentStation');
const resetBrowserSession = functionSource(source.app, 'resetCurrentBrowserSession');
const syncSession = functionSource(source.app, 'syncSessionToDb');
const connectWithDeadline = functionSource(source.app, 'createRemoteSessionWithDeadline');
const beginPhoneHub = functionSource(source.app, 'beginPhoneHub');
const rotateLocalOnly = functionSource(source.app, 'rotateLocalOnlySessionForRemoteOptIn');
const resumeAfterTakeover = functionSource(source.app, 'resumeCurrentViewAfterTabTakeover');
const appEventLogger = functionSource(source.app, 'logEvent');
const entranceRoute = functionSource(source.app, 'handleEntranceRoute');
const remoteSessionStatus = functionSource(source.db, 'verifyRemoteSessionStatus');
const stationEntry = functionSource(source.db, 'enterStation');
const performStationEntry = functionSource(source.db, 'performStationEntry');
const stationClaim = functionSource(source.db, 'claimExclusiveStation');
const stationRevalidation = functionSource(source.db, 'revalidateStationConnection');
const cancelledStationEntry = functionSource(source.db, 'queueCancelledStationAttempt');
const venueLayoutConfig = sliceBetween(source.config, /VENUE_LAYOUT\s*:\s*\{/, /RESULT_OBSERVATION_MINUTES\s*:/);
const moduleDefinitions = sliceBetween(source.app, /const MODULES\s*=\s*\{/, /const ROSE_PATTERN_IDS/);
const main1Base = sliceBetween(moduleDefinitions, /['"]01['"]\s*:/, /['"]02['"]\s*:/);
const sub1Base = sliceBetween(moduleDefinitions, /['"]02['"]\s*:/, /['"]03['"]\s*:/);
const sub2Base = sliceBetween(moduleDefinitions, /['"]03['"]\s*:/, /['"]04['"]\s*:/);
const work04Base = sliceBetween(moduleDefinitions, /['"]04['"]\s*:/, /\n\s*}\s*;/);
const main1Override = sliceBetween(moduleDefinitions, /Object\.assign\(MODULES\[['"]01['"]\]/, /Object\.assign\(MODULES\[['"]02['"]\]/);
const sub1Override = sliceBetween(moduleDefinitions, /Object\.assign\(MODULES\[['"]02['"]\]/, /Object\.assign\(MODULES\[['"]03['"]\]/);
const sub2Override = sliceBetween(moduleDefinitions, /Object\.assign\(MODULES\[['"]03['"]\]/, /Object\.assign\(MODULES\[['"]04['"]\]/);
const work04Override = sliceBetween(moduleDefinitions, /Object\.assign\(MODULES\[['"]04['"]\]/, /const ROSE_PATTERN_IDS/);
const main1 = main1Override || main1Base;
const sub1 = `${sub1Base}\n${sub1Override}`;
const sub2 = `${sub2Base}\n${sub2Override}`;
const work04 = `${work04Base}\n${work04Override}`;
const main1ReadMoreBase = sliceBetween(source.content, /id:\s*['"]about-work-01['"]/, /id:\s*['"]about-work-02['"]/);
const main1ReadMoreExpansion = sliceBetween(source.content, /['"]about-work-01['"]\s*:\s*\{/, /['"]about-work-02['"]\s*:\s*\{/);
const main1ReadMore = `${main1ReadMoreBase}\n${main1ReadMoreExpansion}`;

for (const file of ['app.js', 'config.js', 'db.js', 'measure.js', 'melbourne-content.js']) {
  check(`JavaScript parses: ${file}`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      encoding: 'utf8',
      input: read(file),
    });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
    return true;
  }, 'Fix the syntax error before any browser or TD test.');
}

check('English is the document default', /<html\s+lang=["']en-AU["']/i.test(source.html),
  'Use lang="en-AU" on the root document.');
check('English is the application default', /defaultLanguage\s*:\s*['"]en['"]/.test(source.config),
  'CONFIG.EXHIBITION.defaultLanguage must be en.');
check('Melbourne time zone is configured', /timeZone\s*:\s*['"]Australia\/Melbourne['"]/.test(source.config),
  'Use Australia/Melbourne for visitor-facing dates and times.');
check('Viewport does not cap or disable browser zoom', !/(maximum-scale|minimum-scale|user-scalable\s*=\s*no)/i.test(source.html),
  'Leave pinch and browser zoom unrestricted in the viewport declaration.');
check('Interactive Melbourne floorplan preserves pinch zoom', () => {
  const touchAction = lastCssProperty(source.css, '.melbourne-floorplan-stage', 'touch-action');
  return touchAction !== null
    && /pinch-zoom/.test(touchAction)
    && !/\bnone\b/.test(touchAction);
}, 'Override the legacy floorplan touch rule with pan-y pinch-zoom on the live Melbourne stage.');
check('Melbourne has a separate browser-storage namespace', () => {
  const appKeys = [
    'meta_rose_phone_hub_melbourne_v1',
    'meta_rose_phone_hub_melbourne_events_v1',
    'meta_rose_phone_hub_melbourne_active_tab_v1',
    'meta_rose_phone_hub_melbourne_reduce_motion_v1',
    'meta_rose_phone_hub_melbourne_large_text_v1',
  ];
  const dbKeys = [...source.db.matchAll(/['"](meta_rose_melbourne26\.[^'"]+)['"]/g)].map((entry) => entry[1]);
  return appKeys.every((key) => source.app.includes(key))
    && new Set(dbKeys).size >= 7;
}, 'Keep Melbourne browser state separate so Seoul sessions and queued data are untouched.');
check('Test mode has isolated session, event and active-tab keys', () => (
  /const\s+TEST_MODE\s*=/.test(source.app)
  && /meta_rose_phone_hub_melbourne_test_v1/.test(source.app)
  && /meta_rose_phone_hub_melbourne_test_events_v1/.test(source.app)
  && /meta_rose_phone_hub_melbourne_test_active_tab_v1/.test(source.app)
  && source.app.indexOf('const TEST_MODE') < source.app.indexOf('const STORAGE_KEY')
), 'A ?test=1 preview must never read or overwrite a live visitor browser session.');
check('Melbourne and test tabs use distinct BroadcastChannels', () => (
  /meta_rose_phone_hub_melbourne_tabs_v1/.test(source.app)
  && /meta_rose_phone_hub_melbourne_test_tabs_v1/.test(source.app)
  && !/BroadcastChannel\(['"]meta_rose_phone_hub_tabs_v1['"]\)/.test(source.app)
), 'Do not let Melbourne, Seoul and preview tabs pause one another.');
check('Current public title is centralised', () => (
  /PUBLIC_TITLE\s*=\s*['"]The Meta Rose: Shared Resonance['"]/.test(source.config)
  && /title\s*:\s*PUBLIC_TITLE/.test(source.config)
  && /title\s*:\s*PUBLIC_TITLE/.test(source.content)
  && /import\s*\{\s*MELBOURNE[^}]*\}\s*from\s*['"]\.\/melbourne-content\.js(?:\?[^'"]+)?['"]/.test(source.app)
), 'Keep the review-stage title in config/content so it can be changed once.');
check('Static page metadata uses the current Melbourne title', () => (
  /<title>The Meta Rose: Shared Resonance · Melbourne 2026<\/title>/.test(source.html)
  && /og:title["'][^>]+The Meta Rose: Shared Resonance · Melbourne 2026/.test(source.html)
), 'Social previews do not execute app.js; keep static title metadata current too.');
check('Measurement layer shares the versioned DB module instance', () => (
  /\.\/config\.js\?v=melbourne-onsite-v15-20261003/.test(source.measure)
  && /\.\/db\.js\?v=melbourne-onsite-v15-20261003/.test(source.measure)
  && /\.\/db\.js\?v=melbourne-onsite-v15-20261003/.test(source.app)
), 'Unversioned imports can create a second DB instance that bypasses active-tab state.');
check('Server rows carry a Melbourne edition marker', () => (
  /MELBOURNE_SCHEMA_VERSION\s*=\s*['"]meta_rose_melbourne2026\.1['"]/.test(source.db)
  && /MELBOURNE_EXHIBITION_ID/.test(source.db)
  && /schema_version:\s*MELBOURNE_SCHEMA_VERSION/.test(source.db)
  && /exhibition_id:\s*MELBOURNE_EXHIBITION_ID/.test(source.db)
), 'Melbourne rows must remain analytically separable from preserved Seoul data.');
check('Melbourne browser claims use the physical-run-aware RPC', () => (
  /sb\.rpc\(['"]claim_melbourne_station['"]/.test(source.db)
  && !/sb\.rpc\(['"]claim_station['"]/.test(functionSource(source.db, 'claimExclusiveStation'))
), 'The web must not bypass the Melbourne physical-run guard.');
check('Melbourne migration separates phone presence from physical TD runs', () => (
  /create table if not exists public\.melbourne_station_runs/i.test(source.migration)
  && /create or replace function public\.td_start_melbourne_run/i.test(source.migration)
  && /create or replace function public\.td_heartbeat_melbourne_run/i.test(source.migration)
  && /create or replace function public\.td_end_melbourne_run/i.test(source.migration)
  && /session_id uuid null/.test(source.migration)
), 'Do not reuse the short Phone Hub lease as the physical artwork lifecycle.');
check('Anonymous TD start cannot overtake a live phone presence', () => (
  /if p_session_id is null and exists\s*\(/i.test(source.migration)
  && /join public\.station_locks l/i.test(source.migration)
  && /l\.expires_at > v_now/i.test(source.migration)
  && /p\.left_at is null/i.test(source.migration)
), 'Reject an anonymous run when an exact unexpired phone presence already owns that station.');
check('Cached legacy claims cannot bypass an active Melbourne run', () => (
  /rename to claim_station_core/i.test(source.migration)
  && /create or replace function public\.claim_station\(/i.test(source.migration)
  && /from public\.claim_melbourne_station\(/i.test(source.migration)
  && /revoke all on function public\.claim_station_core/i.test(source.migration)
), 'Old cached clients must pass through the same physical-run guard.');
check('Melbourne migration fails closed without the full unlimited-session baseline', () => {
  const preflight = sliceBetween(source.migration, /do \$preflight\$/i, /\$preflight\$;/i);
  return /renew_station\(text,uuid,uuid,integer\)/i.test(preflight)
    && /close_stale_sessions\(integer\)/i.test(preflight)
    && /v_active_at_station/i.test(preflight)
    && /180 minutes/i.test(preflight)
    && /90 minutes/i.test(preflight)
    && /round_timeout/i.test(preflight)
    && /unlimited_session_lifecycle\.sql/i.test(preflight)
    && /from public\.claim_station_core\(/i.test(source.migration);
}, 'Do not fork the lock algorithm or apply Melbourne on top of an age-limited claim, renewal, cleanup or TD view.');
check('Prepared rollback preserves callable claim-core dependencies', () => (
  /create or replace function public\.claim_station\(/i.test(source.rollback)
  && /create or replace function public\.claim_melbourne_station\(/i.test(source.rollback)
  && (source.rollback.match(/from public\.claim_station_core\(/gi) || []).length === 2
  && !/rename to claim_station\b/i.test(source.rollback)
), 'Rollback must replace public wrappers without renaming away the private core they still call.');
check('Expired physical runs close only their exact stale phone lock', () => (
  /create or replace function public\.expire_melbourne_station_runs/i.test(source.migration)
  && /p\.entered_at = r\.presence_entered_at/.test(source.migration)
  && /l\.client_ref = p\.client_ref/.test(source.migration)
  && /perform public\.expire_melbourne_station_runs\(v_now\)/.test(source.migration)
), 'A missed TD heartbeat must not leave an orphaned renewable phone lock.');
check('Inactive DB runtime cannot reconnect itself on an online event', () => {
  const onlineHandler = sliceBetween(source.db, /window\.addEventListener\(['"]online['"]/, /window\.addEventListener\(['"]offline['"]/);
  return /if\s*\(!runtimeActive\)\s*return/.test(onlineHandler);
}, 'Test and inactive duplicate tabs must not initialise Supabase after reconnect.');
check('All visitor image assets use the Melbourne cache marker', () => (
  /ASSET_CACHE_KEY\s*=\s*['"]melbourne-onsite-v15-20261003['"]/.test(source.app)
  && /const requestPath = versionedAssetUrl\(path\)/.test(source.app)
  && /ROSE_SPECIMEN_IMAGE = versionedAssetUrl/.test(source.app)
  && !/melbourne-onsite-v14-20261002/.test(source.app + source.css + source.html + source.measure)
), 'Keep scripts, styles and runtime image assets on the same Melbourne cache marker.');

check('Header rose and META ROSE wordmark share one HOME control', () => (
  /class:\s*['"]wordmark['"]/.test(globalHeader)
  && /roseMark\(['"]wordmark-rose['"]\)/.test(globalHeader)
  && /class:\s*['"]wordmark-copy['"]/.test(globalHeader)
  && /['"]META ROSE 26['"]/.test(globalHeader)
  && /['"]MELB FRINGE['"]/.test(globalHeader)
  && !/el\(['"]span['"],\s*\{\},\s*['"]2026['"]\)/.test(globalHeader)
  && /onclick:\s*\(\)\s*=>\s*\{\s*void goHome\(\);\s*\}/.test(globalHeader)
), 'Keep the rose image and the two-line META ROSE 26 / MELB FRINGE mark inside the same HOME button.');
check('Arrival uses the requested festival, warning and collapsed data structure', () => (
  /MELBOURNE\.festival/.test(screenArrival)
  && /MELBOURNE\.artistCredit/.test(screenArrival)
  && /artistCredit:\s*['"]BY MINNIE · JIMIN PARK · 박지민['"]/.test(source.content)
  && !/BY MINNIE PARK · JIMIN PARK 박지민/.test(screenArrival)
  && /mild flashes and changes in brightness or sound/.test(screenArrival)
  && /tr\(['"]자세히 보기['"],\s*['"]READ DETAILS['"]\)/.test(screenArrival)
  && /PHONE HUB & DATA/.test(screenArrival)
  && !/Choose your rose colour or let the Phone Hub choose one/.test(screenArrival)
  && !/ACCESS & SENSORY INFORMATION ABOUT THE PROJECT/.test(screenArrival)
  && !/You may take part with or without the Phone Hub/.test(screenArrival)
), 'Keep the short entry screen; detailed camera/storage copy belongs inside the single READ DETAILS disclosure.');
check('Arrival primary action is a two-line Phone Hub and colour choice', () => (
  /primaryButton\(stackedActionLabel\(/.test(screenArrival)
  && /USE PHONE HUB/.test(screenArrival)
  && /CHOOSE A COLOUR/.test(screenArrival)
  && !/CHOOSE FOR ME/.test(screenArrival)
), 'The main Arrival action should read USE PHONE HUB on one line and CHOOSE A COLOUR on the next.');
check('Colour setup opens with a random usable selection and one Continue action', () => (
  /if\s*\(chooseColor\)[\s\S]*randomRoseColor\(current\.color\)[\s\S]*color_locked:\s*false/.test(beginPhoneHub)
  && /palette\.filter\(\(item\)\s*=>[\s\S]*normalizedExclude/.test(source.app)
  && /CONTINUE/.test(screenPersonalSetup)
  && !/CHOOSE FOR ME AND ENTER/.test(screenPersonalSetup)
), 'Preselect a random colour, then let visitors continue immediately or refine it with the picker.');
check('Rose setup locks colour and keeps optional naming in the colour section', () => (
  /You cannot change it after entering/.test(screenPersonalSetup)
  && /Name your rose during your journey if you wish/.test(screenPersonalSetup)
  && /el\(['"]span['"]/.test(screenPersonalSetup)
  && /rose-setup-guidance/.test(screenPersonalSetup)
  && !/rose-name-journey-note/.test(screenPersonalSetup)
  && !/You can change it before entering/.test(screenPersonalSetup)
), 'State the post-entry colour lock and keep naming as one optional note, not a separate required section.');
check('Cached and local hero images cannot remain hidden after loading', () => (
  /onload:\s*\(\)\s*=>/.test(assetFrameSource)
  && assetFrameSource.indexOf('onload:') < assetFrameSource.indexOf('image.src = requestPath')
  && /image\.complete\s*&&\s*image\.naturalWidth\s*>\s*0/.test(assetFrameSource)
  && /loading:\s*['"]eager['"]/.test(moduleHeroSource)
), 'Attach image handlers before src and eagerly load work heroes so cached assets remain visible.');
check('Home floorplan restores route, colour states and an alternate work-list tab', () => (
  /['"]00['"]/.test(floorplanRouteOrder)
  && /['"]ENTRY['"]/.test(floorplanRouteOrder)
  && /routeStep\(['"]01['"]\)/.test(floorplanRouteOrder)
  && /routeStep\(['"]04['"]\)/.test(floorplanRouteOrder)
  && /['"]→['"]/.test(floorplanRouteOrder)
  && /['"]↔['"]/.test(floorplanRouteOrder)
  && /role:\s*['"]tablist['"]/.test(provisionalFloorplan)
  && /['"]FLOOR PLAN['"]/.test(provisionalFloorplan)
  && /['"]WORK LIST['"]/.test(provisionalFloorplan)
  && /is-visited/.test(provisionalFloorplan)
  && /\.route-order-arrow\s*\{[^}]*display:\s*block/s.test(source.css)
  && !/class:\s*['"]route-step-status['"]/.test(floorplanRouteOrder)
  && /route-step-check/.test(floorplanRouteOrder)
), 'Show 00 ENTRY as visited and keep a clearly named Work List alternative to the map.');
check('Work List shows one prominent title per work', () => (
  /class:\s*['"]module-index-row module-index-key work-list-row['"]/.test(provisionalFloorplan)
  && /class:\s*['"]work-list-title['"]/.test(provisionalFloorplan)
  && !/class:\s*['"]module-code['"]/.test(provisionalFloorplan)
  && /\.work-list-tab-panel\s+\.work-list-row\s+\.work-list-title\s*\{[^}]*font-size:\s*clamp\(1\.35rem,\s*5\.6vw,\s*1\.7rem\)/s.test(source.css)
), 'Do not repeat NAMING, INTERVENTION, WITNESS or RECORD in a second small label.');
check('Route work numbers locate a floorplan marker without opening the work', () => (
  /onSelectTarget\?\.\(stationId\)/.test(floorplanRouteOrder)
  && /aria-pressed/.test(floorplanRouteOrder)
  && !/openModuleFromNavigation/.test(floorplanRouteOrder)
  && /mapTargets\.set\(stationId,\s*button\)/.test(provisionalFloorplan)
  && /highlightFloorplanTarget/.test(provisionalFloorplan)
  && /is-route-highlighted/.test(provisionalFloorplan + source.css)
), '01–04 route numbers should act as a map locator; the highlighted map marker remains the work link.');
check('Floorplan reset is clickable and mobile copy describes dragging', () => (
  /floorplan-reset-icon floorplan-reset-corner/.test(provisionalFloorplan)
  && /DRAG TO ROTATE VIEW/.test(provisionalFloorplan)
  && !/DRAG · ARROW KEYS/.test(provisionalFloorplan)
  && /ArrowLeft/.test(provisionalFloorplan)
  && /ArrowRight/.test(provisionalFloorplan)
  && /floorplan-reset-corner\s*\{[^}]*pointer-events:\s*auto/s.test(source.css)
), 'Keep keyboard support, but move the reset control out of the pointer-events-none footer and use mobile-facing drag copy.');
check('Access preview reveals only the selected layer', () => (
  /aria-pressed/.test(provisionalFloorplan)
  && /show-access-entry-exit/.test(provisionalFloorplan)
  && /show-access-route/.test(provisionalFloorplan)
  && /show-access-toilet/.test(provisionalFloorplan)
  && /show-access-other-room/.test(provisionalFloorplan)
  && !/show-access-overlay/.test(provisionalFloorplan)
  && /show-access-entry-exit/.test(source.css)
  && /show-access-route/.test(source.css)
  && /show-access-toilet/.test(source.css)
  && /show-access-other-room/.test(source.css)
  && !/VENUE ACCESS DETAILS · TO BE CONFIRMED/.test(provisionalFloorplan)
  && !/ENTRY \/ EXIT · TBC/.test(provisionalFloorplan)
  && !/class:\s*['"]venue-access-tbc['"]/.test(provisionalFloorplan)
  && !/class:\s*['"]access-preview-warning['"]/.test(provisionalFloorplan)
  && /access-layer-status\s*\{[^}]*clip-path:\s*inset\(50%\)/s.test(source.css)
), 'Entry, route, toilet and other-room overlays must be mutually exclusive and keyboard operable.');
check('Unconfirmed physical facts stay null while neutral preview coordinates remain editable', () => (
  /positionsConfirmed\s*:\s*false/.test(venueLayoutConfig)
  && /entryExit\s*:\s*null/.test(venueLayoutConfig)
  && /accessibleRoute\s*:\s*null/.test(venueLayoutConfig)
  && /accessibleToilet\s*:\s*null/.test(venueLayoutConfig)
  && /provisionalWorks\s*:\s*\{/.test(venueLayoutConfig)
  && /is-provisional/.test(provisionalFloorplan)
  && /provisionalAccessPreview/.test(venueLayoutConfig)
  && /['"]ROUTE['"]/.test(provisionalFloorplan)
  && !/TBC/.test(provisionalFloorplan)
), 'Keep venue facts nullable internally while the review map uses neutral, editable labels without visitor-facing TBC copy.');
check('The Melbourne rectangular plan has no decorative gradient', () => (
  !/gradient/i.test(lastCssProperty(source.css, '.melbourne-floorplan-stage', 'background') || '')
  && !/gradient/i.test(lastCssProperty(source.css, '.melbourne-room-floor', 'background') || '')
  && !/gradient/i.test(lastCssProperty(source.css, '.melbourne-room-wall', 'background') || '')
), 'Keep the floorplan in solid black, grey and visitor-colour accents.');
check('Work pages put hero and short description before Read More and connection', () => {
  const heroAt = screenModule.indexOf('moduleHero(stationId, module)');
  const introAt = screenModule.indexOf('module-quick-intro');
  const storyAt = screenModule.indexOf('module-full-story');
  const connectionAt = screenModule.indexOf('stationConnectionPanel(stationId, entryStatus)');
  return heroAt >= 0 && heroAt < introAt && introAt < storyAt && storyAt < connectionAt;
}, 'Use title → hero → short description → READ MORE → connection.');
check('Connected work banners keep a complete four-sided frame', () => (
  /\.station-connection-panel\s*>\s*\.connected-banner\s*\{[^}]*border-top:\s*1px\s+dotted\s+#ffffff/s.test(source.css)
), 'The CONNECTED / START THE WORK banner must not lose its top edge.');
check('No-phone guidance is consolidated inside Troubleshooting', () => (
  /troubleshooting-no-phone/.test(screenModule)
  && /WHEN THE PHONE IS NOT CONNECTED/.test(screenModule)
  && screenModule.indexOf('troubleshooting-no-phone') > screenModule.indexOf('troubleshooting-block')
  && !/module-anonymous-start/.test(screenModule)
), 'Do not show a second no-phone section outside the Troubleshooting disclosure.');
check('Menu restores Survey as a direct destination', () => (
  /menuAction\(tr\(['"]설문['"],\s*['"]SURVEY['"]\),\s*\(\)\s*=>\s*guardedNavigation\(screenSurvey\)\)/.test(roseMenu)
), 'Survey must remain directly reachable from the menu.');
check('Every About section receives additional approved Read Deeper copy', () => (
  (source.content.match(/^\s{2}['"]about-[^'"]+['"]:\s*\{/gm) || []).length >= 12
  && /section\.deeperKo\s*=\s*\[\.\.\.\(section\.deeperKo\s*\|\|\s*\[\]\),\s*\.\.\.expansion\.ko\]/.test(source.content)
  && /section\.deeperEn\s*=\s*\[\.\.\.\(section\.deeperEn\s*\|\|\s*\[\]\),\s*\.\.\.expansion\.en\]/.test(source.content)
  && !/(vanished versions|broken devices|사라진 버전|고장 난 장치)/.test(source.content)
), 'Read Deeper must add approved depth to all 12 sections without inventing unverified video content.');
check('Core Read Deeper sections use the approved bilingual source expansions', () => (
  /A funeral for the self I have killed/.test(source.content)
  && /The roses also change through handling, drying and decay/.test(source.content)
  && /The rose remains both a physical material and a recurring figure/.test(source.content)
  && /Camera-based gesture tracking and a responsive controller/.test(source.content)
  && /A connected phone interface offers a place to retain selected images/.test(source.content)
  && /A silent, looping film returns attention to the making of the exhibition/.test(source.content)
  && /내가 죽여 온 나를 위한 장례식/.test(source.content)
  && /소리 없이 반복되는 영상은 전시를 만드는 과정으로 시선을 되돌립니다/.test(source.content)
), 'Use only the previously approved bilingual source copy when expanding the six core curatorial sections.');

check('Optional naming does not gate registration', () => (
  isRegistered
  && /intro_seen/.test(isRegistered)
  && /color_locked/.test(isRegistered)
  && !/(emotional_name|nickname|name_source)/.test(isRegistered)
), 'Registration may depend on the entry choice and colour, never on a name.');
check('Opening or rerendering a work page does not auto-claim it', () => (
  /screenModule\(station,\s*\{\s*enter:\s*false/.test(boot)
  && !/screenModule\(station,\s*\{\s*enter:\s*true/.test(boot)
  && /screenModule\(pendingStation,\s*\{\s*enter:\s*false/.test(routeAfterRoseSetup)
  && !/screenModule\(pendingStation,\s*\{\s*enter:\s*true/.test(routeAfterRoseSetup)
  && /rememberView\(['"]module['"],\s*\{\s*stationId,\s*options:\s*\{\s*\.\.\.options,\s*enter:\s*false/.test(screenModule)
), 'Page load, registration return and view replay must only show the work; only its explicit Connect control may claim it.');
check('Station entry never falls back to a non-exclusive insert', () => (
  /setup_required/.test(performStationEntry)
  && !/enterLegacyStation\s*\(/.test(`${stationEntry}\n${performStationEntry}`)
), 'A missing lock RPC must fail safe instead of binding two visitors to one work.');
check('Phone connection has a deadline and cancels late state', () => {
  const connect = functionSource(source.app, 'createRemoteSessionWithDeadline');
  return /navigator\.onLine/.test(connect)
    && /Promise\.race/.test(connect)
    && /resetDbSession\(['"]phone_connect_timeout['"]\)/.test(connect);
}, 'Offline or timed-out requests must not activate later after the visitor has moved on.');
check('Station entry has one deadline and exact late-claim cleanup', () => (
  /STATION_ENTRY_TIMEOUT_MS\s*=\s*10\s*\*\s*1000/.test(source.db)
  && /Promise\.race/.test(stationEntry)
  && /connection_timeout/.test(stationEntry)
  && /queueCancelledStationAttempt\(attempt\)/.test(stationEntry)
  && /clientRef\s*=\s*attempt\?\.clientRef/.test(cancelledStationEntry)
  && /queueCancelledStationAttempt\(attempt,\s*requestedClientRef\)/.test(stationClaim)
), 'A half-open venue network must return usable retry guidance and close any late exact claim.');
check('Foreground station revalidation is read-only', () => (
  /\.from\(['"]station_presence['"]\)/.test(stationRevalidation)
  && /\.select\(/.test(stationRevalidation)
  && /\.is\(['"]left_at['"],\s*null\)/.test(stationRevalidation)
  && !/\.rpc\(/.test(stationRevalidation)
  && !/\.(?:insert|update|delete)\(/.test(stationRevalidation)
), 'Screen return may verify the exact presence, but must not claim, end or create a run.');
check('BUSY and CONNECTED expose a real CONNECT AGAIN claim', () => (
  /\['busy',\s*'connected'\]/.test(stationConnectionPanel)
  && /CONNECT AGAIN/.test(stationConnectionPanel)
  && /screenModule\(stationId,\s*\{\s*enter:\s*true,\s*via\s*\}\)/.test(requestStationConnection)
  && /CONNECTING/.test(requestStationConnection)
), 'CONNECT AGAIN must issue a fresh claim instead of only clearing local copy.');
check('Station status refresh handles foreground and stale response order', () => (
  /pageshow/.test(source.app)
  && /visibilitychange/.test(source.app)
  && /requestGeneration\s*!==\s*stationStatusRevalidationGeneration/.test(visibleStationRevalidation)
  && /viewGeneration\s*!==\s*viewGenerationAtStart/.test(visibleStationRevalidation)
  && /stationStatusRevalidationGeneration\s*\+=\s*1/.test(requestStationConnection)
  && /stationRevalidationGeneration\s*\+=\s*1/.test(stationEntry)
), 'A late BUSY/readback must never overwrite a newer manual retry or another screen.');
check('Network status is distinct from a real BUSY response', () => (
  /status_unavailable/.test(stationRevalidation)
  && /THE CONNECTION COULD NOT BE CHECKED/.test(source.app)
  && /ANOTHER ROSE IS EXPERIENCING/.test(source.app)
), 'Offline, timeout and read errors must not be presented as another visitor holding the work.');
check('Local-only opt-in rotates to a fresh unconsented UUID', () => (
  beginPhoneHub.indexOf('rotateLocalOnlySessionForRemoteOptIn()') >= 0
  && beginPhoneHub.indexOf('rotateLocalOnlySessionForRemoteOptIn()') < beginPhoneHub.indexOf('createRemoteSessionWithDeadline()')
  && /if\s*\(!current\.local_only\)\s*return current/.test(rotateLocalOnly)
  && /const id = makeId\(\)/.test(rotateLocalOnly)
  && /display_record_no:\s*id\.slice/.test(rotateLocalOnly)
  && /pending_station:\s*current\.pending_station/.test(rotateLocalOnly)
  && /completed_stations:\s*\[\]/.test(rotateLocalOnly)
  && /survey:\s*\{\}/.test(rotateLocalOnly)
  && /if\s*\(!TEST_MODE\)\s*resetDbSession\(['"]local_only_remote_opt_in['"]\)/.test(rotateLocalOnly)
), 'Never reuse an ended remote primary key when a no-phone visitor later opts in.');
check('Entry controls recover if tab ownership changes during connection', () => (
  /restoreEntryControls\(\)/.test(beginPhoneHub)
  && /!ownsActiveTab\(sessionIdAtStart\)/.test(beginPhoneHub)
  && /button\.removeAttribute\(['"]aria-busy['"]\)/.test(beginPhoneHub)
), 'A superseded tab must not leave Arrival controls disabled or aria-busy forever.');
check('Test mode keeps the DB runtime inactive and skips DB initialization', () => (
  /setDbRuntimeActive\(TEST_MODE\s*\?\s*false\s*:\s*next\)/.test(tabRuntime)
  && /if\s*\(TEST_MODE\)\s*setDbRuntimeActive\(false\)/.test(boot)
  && /if\s*\(!TEST_MODE\)\s*\{[\s\S]*?initDB\(\)[\s\S]*?startIdleTracking\(\)/.test(boot)
), 'Preview URLs must not initialise Auth/PostgREST or reactivate db.js.');
check('Test mode simulates connection without creating a remote session', () => (
  /if\s*\(TEST_MODE\)[\s\S]*?test_simulated/.test(connectWithDeadline)
  && /if\s*\(TEST_MODE\)\s*return;/.test(syncSession)
  && /if\s*\(TEST_MODE\)\s*return\s+existing\.at\(-1\)/.test(appEventLogger)
  && /options\.enter\s*&&\s*TEST_MODE/.test(screenModule)
), 'Entry and station connection previews must remain local simulations.');
check('Test reset, release and entrance verification never call the DB', () => (
  /if\s*\(!TEST_MODE\)\s*resetDbSession\(\)/.test(resetBrowserSession)
  && /if\s*\(TEST_MODE\)[\s\S]*?return true;[\s\S]*?leaveDbStation/.test(releaseStation)
  && /if\s*\(!TEST_MODE\s*&&[\s\S]*?verifyRemoteSessionStatus/.test(entranceRoute)
), 'Resetting or navigating a preview must not end, verify or release a live Supabase session.');
check('Test mode guards capture, survey, artifact, snapshot and queue operations', () => (
  /TEST_MODE\s*\?\s*\[\]\s*:\s*await fetchMyCaptureArtifacts/.test(source.app)
  && /if\s*\(!TEST_MODE\)\s*saveDbSurvey/.test(source.app)
  && /if\s*\(!TEST_MODE\)\s*\{[\s\S]*?saveDbArtifact/.test(source.app)
  && /if\s*\(!TEST_MODE\)\s*\{[\s\S]*?saveDbSessionSnapshot/.test(source.app)
  && /if\s*\(!TEST_MODE\)\s*void flushDbQueue/.test(source.app)
), 'No test preview may read captures or write survey, artifact, snapshot or queued data.');
check('HOME releases phone station presence', () => (
  /releaseCurrentStation\(['"]home['"]\)/.test(goHome)
), 'Leaving a work for HOME must stop phone lease renewal so the next visitor is not blocked.');
check('Entrance server reconciliation is bounded and server-confirmed', () => (
  /verifyRemoteSessionStatus/.test(entranceRoute)
  && /Promise\.race/.test(entranceRoute)
  && /4000/.test(entranceRoute)
  && /\.from\(['"]sessions['"]\)/.test(remoteSessionStatus)
  && /data\.status\s*!==\s*['"]active['"]/.test(remoteSessionStatus)
), 'Do not revive a server-ended Rose, but never leave entry blank on a stalled network.');
check('Phone inactivity does not release the physical work', () => (
  !/Date\.now\(\)\s*-\s*lastPhoneActivityAt/.test(source.db)
  && !/phone_idle/.test(source.db)
), 'Only a verified module end/reset or explicit release may end an artwork.');
check('Result viewing does not end or finalise the session', () => (
  finalSpecimen
  && !/endDbSession\s*\(/.test(finalSpecimen)
  && !/finalization_completed\s*:\s*true/.test(finalSpecimen)
), 'Results are a reusable view, not a lifecycle boundary.');
check('Result access is not conditioned on every work, Exit or survey', () => (
  finalSpecimen
  && !/(surveyCompleted|screenExitJourney|allStations|requiredStations|every\s*\()/i.test(finalSpecimen)
  && !/if\s*\([^)]*(?:completed_stations|visited)/i.test(finalSpecimen)
), 'A visitor with one work or no survey must still open results.');
check('Home links directly to results/captures and survey', () => (
  /screenFinalSpecimen\s*\(/.test(screenHome)
  && /(?:screenSurvey\s*\(|,\s*screenSurvey\s*,)/.test(screenHome)
), 'Home needs one-tap access to My Captures / Result and the optional survey.');
check('Unconfirmed Melbourne venue facts remain null in config', () => {
  const nullFields = [
    'entryExit',
    'stepFreeEntrance',
    'accessibleRoute',
    'accessibleToilet',
    'quietSpace',
  ];
  return /footprint\s*:\s*['"]rectangle['"]/.test(venueLayoutConfig)
    && /positionsConfirmed\s*:\s*false/.test(venueLayoutConfig)
    && ['01', '02', '03', '04'].every((stationId) => (
      new RegExp(`['"]${stationId}['"]\\s*:\\s*null`).test(venueLayoutConfig)
    ))
    && nullFields.every((field) => (
      new RegExp(`${field}\\s*:\\s*null`).test(venueLayoutConfig)
    ));
}, 'Keep positions, entry/exit, step-free route, accessible toilet and quiet space unconfirmed until the on-site check.');
check('Preview copy does not publish the previously assumed room name', () => (
  !/Celia Little Room/i.test(source.config + source.content + source.app)
  && /The Mission to Seafarers Victoria/.test(source.config + source.content)
), 'Use only the confirmed venue name until the exact room is verified on site.');
check('Home uses the config-backed provisional rectangle, not the Seoul plan image', () => (
  /const\s+layout\s*=\s*CONFIG\.VENUE_LAYOUT\s*\|\|\s*\{\}/.test(provisionalFloorplan)
  && /layout\.provisionalWorks\s*\|\|\s*\{\}/.test(provisionalFloorplan)
  && /Object\.entries\(displayedPositions\)/.test(provisionalFloorplan)
  && /layout\.positionsConfirmed/.test(provisionalFloorplan)
  && /melbourne-rectangular-(?:rotor|walls)/.test(provisionalFloorplan)
  && /Floor plan for Mission to Seafarers/i.test(provisionalFloorplan)
  && /melbourneProvisionalFloorplan\(session\)/.test(screenHome)
  && !/floorplanViewer\(session\)/.test(screenHome)
  && !/(gallery-room-1-plan|actual-floorplan-image|floorplan-turntable-image)/.test(provisionalFloorplan)
), 'The live home view must read CONFIG.VENUE_LAYOUT and draw a provisional rectangle without reusing the Seoul image.');
check('Venue access coordinates remain centralised for a one-place site update', () => (
  /const\s+accessPreview\s*=\s*layout\.provisionalAccessPreview\s*\|\|\s*\{\}/.test(provisionalFloorplan)
  && /accessPreview\.entry/.test(provisionalFloorplan)
  && /accessPreview\.exit/.test(provisionalFloorplan)
  && /accessPreview\.toilet/.test(provisionalFloorplan)
  && /accessPreview\.otherRoom/.test(provisionalFloorplan)
), 'Keep every visible access point sourced from CONFIG.VENUE_LAYOUT so site coordinates change in one place.');
check('Survey is its own optional route', () => (
  /function\s+screenSurvey\s*\(/.test(source.app)
  && /name\s*===\s*['"]survey['"]/.test(resultRouter)
  && !/screenFinalReflection\s*\(\s*\{\s*exitFlow:\s*true/.test(finalSpecimen)
), 'Do not couple survey completion to naming, Exit or result access.');

check('Work 04 is handled as a non-exclusive visit', () => (
  /options\.enter\s*&&\s*stationId\s*===\s*['"]04['"]/.test(screenModule)
  && /markStationComplete\s*\(\s*(?:stationId|['"]04['"])\s*\)/.test(screenModule)
  && /else\s+if\s*\(\s*options\.enter/.test(screenModule)
), '04 should record an optional visit without acquiring the exclusive station lock.');
check('Work 04 has no personal capture panel', () => (
  /\[['"]01['"],\s*['"]02['"],\s*['"]03['"]\]\.includes\(stationId\)/.test(capturePanel)
  && !/['"]04['"]/.test(capturePanel)
), 'Only Works 01–03 may appear in the personal capture list.');
check('Work 04 never renders a connection control', () => (
  /stationId\s*===\s*['"]04['"]\s*\?\s*null\s*:\s*freshSession\.local_only/.test(screenModule)
  && /options\.enter\s*&&\s*stationId\s*===\s*['"]04['"]/.test(screenModule)
), 'Keep the non-exclusive 04 visit contract but never show a CONNECT button for the shared film.');
check('Explicit Work 04 navigation records a non-exclusive visit', () => {
  const navigation = functionSource(source.app, 'openModuleFromNavigation');
  return /enter:\s*stationId\s*===\s*['"]04['"]/.test(navigation)
    && /openModuleFromNavigation\(stationId,\s*['"]home_list_tab['"]\)/.test(source.app)
    && /openModuleFromNavigation\(stationId,\s*positionsAreConfirmed/.test(source.app);
}, 'Opening RECORD from an explicit Home navigation must mark the shared visit without a connection panel.');
check('Capture polling covers 01–03 and not 04', () => (
  /\[['"]01['"],\s*['"]02['"],\s*['"]03['"]\]\.includes\(normalizedStationId\)/.test(capturePolling)
  && !/['"]04['"]/.test(capturePolling)
  && /schedule\(4000\)/.test(capturePolling)
  && /window\.addEventListener\(['"]focus['"]/.test(capturePolling)
  && /window\.addEventListener\(['"]online['"]/.test(capturePolling)
), 'Revalidate 01–03 by persistent session UUID on entry, interval, focus and reconnect.');
check('Capture UI exposes state and retry controls', () => (
  /getArtifactFetchStatus\s*\(/.test(source.app)
  && /(UPLOAD|LOADING|CHECKING|WAITING)/i.test(capturePanel + functionSource(source.app, 'refreshCaptureResultPanel') + functionSource(source.app, 'setCapturePanelStatus'))
  && /(RETRY|TRY AGAIN)/i.test(capturePanel + functionSource(source.app, 'refreshCaptureResultPanel') + functionSource(source.app, 'setCapturePanelStatus'))
), 'Show checking/upload pending/failure state and a manual retry action.');
check('Capture polling does not repeat live-region announcements', () => {
  const refresh = functionSource(source.app, 'refreshCaptureResultPanel');
  const finalRefresh = functionSource(source.app, 'refreshResultCaptureGallery');
  return (capturePanel.match(/aria-live/g) || []).length === 1
    && /capture-fetch-status-copy/.test(capturePanel)
    && /capture-poll-announcement/.test(capturePanel)
    && !/setCapturePanelStatus\([^)]*['"]loading['"]/.test(refresh)
    && !/statusNode\.textContent\s*=\s*tr\(['"]\uc0c8 \ucea1\ucc98\ub97c \ud655\uc778/.test(finalRefresh)
    && /fingerprintChanged\s*&&\s*resolved\.length/.test(finalRefresh)
    && /announceCaptureStatus\(announcement/.test(finalRefresh)
    && /options\.announce\s*\|\|\s*state\s*===\s*['"]error['"]\s*\|\|\s*state\s*===\s*['"]offline['"]/.test(source.app);
}, 'Background polling must remain visually current without announcing checking/ready every four seconds.');
check('Capture carousel announces only user navigation and updates image alternatives', () => {
  const refresh = functionSource(source.app, 'refreshCaptureResultPanel');
  return /capture-carousel-announcement/.test(refresh)
    && /announce:\s*true/.test(refresh)
    && /image\.alt\s*=\s*tr/.test(refresh)
    && /Capture \$\{index \+ 1\} of \$\{resolved\.length\}/.test(refresh);
}, 'Previous/Next must expose the new index and image alternative without poll chatter.');
check('Final results can render every 01–03 capture', () => (
  /function\s+(?:refreshResultCaptureGallery|resultCaptureGallery)\s*\(/.test(source.app)
  && /fetchMyCaptureArtifacts\s*\(/.test(source.app)
), 'Do not reduce final results to only the latest image per station.');
check('Result capture kicker and title have a deliberate visual gap', () => (
  /\.result-capture-gallery\s*>\s*\.micro-label\s*\+\s*h2\s*\{[^}]*margin:\s*14px\s+auto\s+18px/s.test(source.css)
), 'Separate CAPTURES / 01–03 from MY CAPTURED MOMENTS so they do not read as one crowded line.');

check('MAIN1 copy excludes superseded skeleton and ground-rose controls', () => (
  main1
  && !/skeleton|skull|ground rose|해골|스켈레톤|그라운드 로즈/i.test(main1)
), 'Melbourne MAIN1 has ribbons and hanging roses, not skeleton hands or a ground rose.');
check('MAIN1 how-to-play uses the black ribbon and a rose', () => (
  /hold the black ribbon/i.test(main1)
  && /touch (?:a|one or several|the living) rose/i.test(main1)
  && /검은 리본/.test(main1)
  && /장미를 만/.test(main1)
), 'Tell visitors to keep hold of the black ribbon while touching a rose.');
check('MAIN1 capture uses the white and black ribbons together', () => (
  /white and black ribbons/i.test(main1)
  && /(at the same time|together)/i.test(main1)
  && /capture/i.test(main1)
  && /흰 리본과 검은 리본을 동시에/.test(main1)
  && /캡처/.test(main1)
), 'The confirmed capture request is holding the white and black ribbons at the same time.');
check('MAIN1 no-phone and troubleshooting copy repeats the physical controls', () => (
  /without a phone, hold the black ribbon and touch a rose/i.test(main1)
  && /if nothing responds[^.]*black ribbon[^.]*touch the rose again/i.test(main1)
  && /if a capture is not requested[^.]*release both ribbons/i.test(main1)
  && /휴대폰 없이도 검은 리본을 잡고 장미를 만지면/.test(main1)
), 'Phone-free and recovery guidance must be usable without guessing the installed controls.');
check('MAIN1 Read More matches the installed ribbon controls', () => (
  /hold the black ribbon/i.test(main1ReadMore)
  && /white and black ribbons/i.test(main1ReadMore)
  && /검은 리본/.test(main1ReadMore)
  && /흰 리본과 검은 리본을 동시에/.test(main1ReadMore)
  && !/skeleton|ground rose|스켈레톤|그라운드 로즈/i.test(main1ReadMore)
), 'Keep the Work 01 Read More section aligned with the black-ribbon play and two-ribbon capture inputs.');
check('SUB1 instructions match the verified gestures and capture', () => (
  /(thumb).*(index)/is.test(sub1)
  && /(five fingers|five-finger)/i.test(sub1)
  && /(two buttons|any two)/i.test(sub1)
  && /(two seconds|2 seconds)/i.test(sub1)
  && /(not.*(?:eye|closing)|눈.*아니)/i.test(sub1)
), 'Use rectangle/five-finger masks; capture is two controller buttons for two seconds, not eye closing.');
check('SUB1 gives the confirmed one-button phone-free start', () => (
  /press any one button on the Rose Human Controller/i.test(sub1)
  && !/only after on-site verification/i.test(sub1)
), 'The public instructions should state the installed one-button phone-free start without planning copy.');
check('SUB2 instructions match the verified work', () => (
  /speaker/i.test(sub2)
  && /vertical/i.test(sub2)
  && /slow/i.test(sub2)
  && /rose button/i.test(sub2)
  && /(no headphones|not headphones|rather than headphones|헤드폰.*아니)/i.test(sub2)
), 'Use speakers, vertical hand time control, slow witness and the rose button.');
check('SUB2 stillness is not treated as departure', () => (
  /(stillness|sustained looking|hand still|가만히|정지)/i.test(sub2)
  && /(does not end|not end|종료.*않)/i.test(sub2)
  && !/(45|60)\s*(?:seconds|초).*?(?:end|reset|종료|초기화)/i.test(sub2)
), 'Sustained looking is participation; do not copy Seoul hand-absence timeouts.');
check('Work 04 is silent, shared and capture-free', () => (
  /(silent|무음)/i.test(work04)
  && /(multiple|shared|anyone|여러|누구나)/i.test(work04)
  && /(no personal capture|does not.*capture|캡처.*없)/i.test(work04)
), '04 is non-exclusive video viewing and must not imply a missing capture error.');

check('Live station entry no longer contains the rose-pattern gate', () => (
  !/function\s+patternEntryPanel\s*\(/.test(source.app)
  && !/patternEntryPanel\s*\(/.test(screenModule)
  && !/(pattern-choice-grid|rose-pattern-button|stablePatternOrder|playPatternSuccessTransition)/.test(stationConnectionPanel)
), 'Work pages should present the direct connection control without asking visitors to match a pattern.');
check('One explicit work-number control starts the existing station entry flow', () => {
  const panelRenders = screenModule.match(/stationConnectionPanel\(stationId,\s*entryStatus\)/g) || [];
  const entryCalls = requestStationConnection.match(/screenModule\(stationId,\s*\{\s*enter:\s*true,\s*via\s*\}\)/g) || [];
  return panelRenders.length === 1
    && entryCalls.length === 1
    && /class:\s*['"]primary-action direct-station-entry['"]/.test(stationConnectionPanel)
    && !/Simply viewing this page does not reserve the work/.test(stationConnectionPanel);
}, 'Render one clear Connect button and enter through screenModule(..., { enter: true, via: work_number }).');

check('Header exposes visible MENU text', () => (
  /class:\s*['"]menu-trigger-label['"]/.test(globalHeader)
  && /tr\(['"]메뉴['"],\s*['"]MENU['"]\)/.test(globalHeader)
  && /openRoseMenu\(event\.currentTarget\)/.test(globalHeader)
), 'The persistent header control needs a visible MENU label in addition to its icon and accessible name.');
check('Globe button opens an English and Korean language chooser', () => {
  const choices = languageChooser.match(/class:\s*['"]language-choice['"]/g) || [];
  return /class:\s*['"]language-globe['"]/.test(globalHeader)
    && /aria-haspopup['"]?:\s*['"]dialog['"]/.test(globalHeader)
    && /openLanguageChooser\(event\.currentTarget\)/.test(globalHeader)
    && choices.length === 2
    && /choose\(['"]en['"]\)/.test(languageChooser)
    && /choose\(['"]ko['"]\)/.test(languageChooser)
    && /['"]English['"]/.test(languageChooser)
    && /['"]한국어['"]/.test(languageChooser);
}, 'Use a globe-labelled dialog with separate, plainly named English and 한국어 choices.');
check('Larger-text preference persists and changes live typography', () => (
  /LARGE_TEXT_KEY\s*=\s*['"]meta_rose_phone_hub_melbourne_large_text_v1['"]/.test(source.app)
  && /localStorage\.getItem\(LARGE_TEXT_KEY\)\s*===\s*['"]1['"]/.test(largeTextEnabled)
  && /localStorage\.setItem\(LARGE_TEXT_KEY/.test(toggleLargeText)
  && /classList\.toggle\(['"]large-text['"],\s*largeTextEnabled\(\)\)/.test(updateDocumentContext)
  && /large-text-menu/.test(roseMenu)
  && /largeTextControlAttributes\(\)/.test(roseMenu)
  && /body\.large-text/.test(source.css)
), 'Store the preference in Melbourne local storage, reflect it with aria-pressed, and apply a real large-text CSS mode.');
check('Larger-text mode covers essential Arrival copy', () => (
  /body\.large-text\s+\.arrival-cover/.test(source.css)
  && /body\.large-text\s+:is\(\.arrival-auto-note,\s*\.arrival-summary\s*>\s*p,[\s\S]*\.arrival-access-summary\s+p,[\s\S]*\.phone-data-notice\s+p\)/.test(source.css)
), 'Arrival does not use .screen, so its summary, optional-entry, allergy and data text need explicit large-text coverage.');
check('Small screens show the full route without horizontal swiping', () => (
  /\.floorplan-route-order\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*space-between[^}]*overflow:\s*visible/s.test(source.css)
  && /\.route-order-step\s*\{[^}]*min-width:\s*36px[^}]*min-height:\s*44px[^}]*flex:\s*1\s+1\s+40px/s.test(source.css)
  && /['"]05['"]/.test(floorplanRouteOrder)
), 'Keep 01 → 02 ↔ 03 → 04 → 05 on one compact line without requiring a horizontal swipe.');
check('Journey controls use the rectangular Phone Hub button language', () => (
  lastCssProperty(source.css, '.floorplan-route-order .route-order-step', 'border-radius') === '0'
  && lastCssProperty(source.css, '.floorplan-route-order .route-order-step', 'border') === '1px solid rgba(255,255,255,.76)'
), '00–05 should remain rectangular; only the small completion check may be circular.');
check('Floorplan work names and visit states remain readable without colour alone', () => (
  /melbourne-map-name/.test(provisionalFloorplan)
  && /melbourne-map-check/.test(provisionalFloorplan)
  && /moduleStatus\(session,\s*stationId\)/.test(provisionalFloorplan)
  && /route-step-check/.test(floorplanRouteOrder)
), 'Keep work names and a visible check plus an accessible text state; colour may reinforce but never replace status.');
check('Work hero images are uncropped and embedded text has a visible translation', () => (
  /\.module-asset\s+\.asset-image:not\(\[hidden\]\)\s*\{[^}]*object-fit:\s*contain/s.test(source.css)
  && /module-image-translation/.test(moduleHeroSource)
  && /Text in image:/.test(moduleHeroSource)
), 'Show the complete Seoul hero image and visibly translate embedded Korean text in Work 03.');
check('Menu footer credit and copyright stay readable', () => (
  /\.rose-menu-foot\s*>\s*span,[\s\S]*?\.rose-menu-foot\s+\.menu-copyright\s*\{[^}]*font-size:\s*12px/s.test(source.css)
), 'Do not reduce support credit or copyright to 7–8px.');
check('Menu has one MY ROSE destination and no separate naming row', () => {
  const myRoseLabels = roseMenu.match(/['"]MY ROSE['"]/g) || [];
  return myRoseLabels.length === 1
    && /menuAction\(tr\(['"]나의 장미['"],\s*['"]MY ROSE['"]\),\s*\(\)\s*=>\s*guardedNavigation\(screenFinalSpecimen\)\)/.test(roseMenu)
    && !/CAPTURES & RESULT/.test(roseMenu)
    && !/screenFinalReflection/.test(roseMenu)
    && !/(NAME OF MY ROSE|NAME MY ROSE)/.test(roseMenu);
}, 'Keep naming inside MY ROSE instead of exposing a second standalone name destination.');
check('My Rose places the naming action directly below the current name', () => (
  /result-summary[\s\S]*?el\(['"]h1['"][\s\S]*?result-name-inline[\s\S]*?el\(['"]dl['"]/.test(finalSpecimen)
  && (finalSpecimen.match(/result-name-inline/g) || []).length === 1
  && /el\(['"]h1['"],\s*\{\},\s*displayName\(session\)\)/.test(finalSpecimen)
), 'The current Phone Rose identity should be followed immediately by NAME MY ROSE, without a duplicate action at the bottom.');
check('Unnamed Phone Hub visitors use their Rose number instead of a TD-only anonymous label', () => (
  /name_source\s*!==\s*['"]visitor['"]/.test(visitorRoseNameSource)
  && /phoneRoseLabel/.test(displayNameSource)
  && /PHONE ROSE/.test(source.app)
  && /session\?\.consent\s*&&\s*!session\?\.local_only/.test(displayNameSource)
  && !/(겁이 많지만 계속 가는 나|겁이 많은 나|그래도 계속 가는 나)/.test(seedTestSession)
), 'Phone sessions must be distinguishable from TD-only anonymous runs without reviving the old sample name.');
check('Station control fields synchronously send a stable Phone Rose pseudonym', () => (
  /pseudonym:\s*phoneRoseLabel\(ensureSession\(\)\)/.test(screenModule)
  && /['"]pseudonym['"]/.test(source.db)
  && /dbPatch\.pseudonym\s*=\s*patch\.nickname/.test(source.app)
), 'SUB1 and SUB2 must not reject an unnamed Phone Hub visitor before the chosen final name exists.');
check('Naming stays skippable without repeating OPTIONAL in its title', () => (
  !/NAME MY ROSE \(OPTIONAL\)/.test(source.app)
  && !/NAME OF THE ROSE \/ OPTIONAL/.test(source.app)
  && /CONTINUE WITHOUT A NAME/.test(source.app)
), 'The skip action already communicates that naming may be omitted.');
check('Work capture heading avoids repeating MY CAPTURE', () => (
  /tr\(`작품 \$\{stationId\}`,\s*`WORK \$\{stationId\}`\)/.test(capturePanel)
  && /MY CAPTURED MOMENT/.test(capturePanel)
  && !/['"]MY CAPTURE['"]/.test(capturePanel)
), 'Use WORK 01–03 as context above MY CAPTURED MOMENT.');
check('Visitor-facing copy contains no long dash characters', () => (
  !/[—–―]/.test(source.app + source.content)
), 'Use commas or explicit work numbers in rendered copy instead of em or en dashes.');

check('Access Fringe credit is present verbatim', () => (
  source.content.includes('This project has been made more accessible with support from Access Fringe.')
  && /MELBOURNE\.accessCredit/.test(source.app)
), 'Show the exact support credit in the live interface.');
check('Access guide explicitly covers live-flower allergy or sensitivity', () => (
  /(?:allerg|sensitivit)/i.test(accessGuide)
  && /(?:live|real) (?:flowers?|roses?)/i.test(accessGuide)
), 'Name the allergy/sensitivity risk directly; scent, pollen, thorns and water alone are not an allergy warning.');
check('Access guide says the artist is available for on-site support', () => (
  /(?:artist[\s\S]{0,180}(?:on[- ]site|present|available|support|help)|(?:on[- ]site|present|available|support|help)[\s\S]{0,180}artist)/i.test(accessGuide)
), 'Tell visitors that the artist is on site and available to help with participation or access needs.');
check('Quiet space remains explicitly to be confirmed on site', () => (
  /quietSpace\s*:\s*null/.test(venueLayoutConfig)
  && /quiet rest space is still being confirmed/i.test(accessGuide)
  && !/layoutFact\(layout\.quietSpace\)/.test(provisionalFloorplan)
), 'Do not place an unconfirmed quiet space on the floor plan; keep the guide explicit about its status.');
check('Skip link has visible-focus styling', () => (
  /class=["']skip-link["']/.test(source.html)
  && /\.skip-link\s*\{/.test(source.css)
  && /\.skip-link(?::focus|:focus-visible)/.test(source.css)
), 'The keyboard skip link must be hidden only until it receives focus.');
check('Focus styles cover links, selects and text areas', () => (
  /a:focus-visible/.test(source.css)
  && /select:focus-visible/.test(source.css)
  && /textarea:focus-visible/.test(source.css)
), 'All interactive elements need a strong visible keyboard focus indicator.');
check('Inactive-tab safety dialog moves and traps focus', () => (
  /aria-modal/.test(activeTabDialog)
  && /\$app\.inert\s*=\s*true/.test(activeTabDialog)
  && /event\.key\s*!==\s*['"]Tab['"]/.test(activeTabDialog)
  && /\.focus\(\)/.test(activeTabDialog)
), 'The duplicate-tab guard must not leave actionable controls exposed behind it.');
check('Only one modal layer can remain active at a time', () => (
  /closeRoseMenu\(\{\s*restoreFocus:\s*false\s*\}\)/.test(activeTabDialog)
  && /closeLanguageChooser\(\{\s*restoreFocus:\s*false\s*\}\)/.test(activeTabDialog)
  && /language-dialog-overlay/.test(closeRoseMenu)
  && /rose-menu-overlay/.test(closeLanguageChooser)
  && /inactive-tab-overlay/.test(closeRoseMenu + closeLanguageChooser)
), 'Close menu/language layers before the duplicate-tab guard and never return focus behind another modal.');
check('Skip link language follows the current interface language', () => (
  /skipLink\.textContent\s*=\s*tr\(/.test(updateDocumentContext)
  && /본문으로 바로가기/.test(updateDocumentContext)
  && /Skip to main content/.test(updateDocumentContext)
), 'Localise the keyboard skip link when visitors switch language.');
check('Station connection failures are announced immediately', () => (
  /role:\s*entryStatus\?\.code\s*\?\s*['"]alert['"]\s*:\s*['"]status['"]/.test(stationConnectionPanel)
  && /aria-live['"]?:\s*entryStatus\?\.code\s*\?\s*['"]assertive['"]\s*:\s*['"]polite['"]/.test(stationConnectionPanel)
  && /aria-describedby['"]?:\s*feedbackId/.test(stationConnectionPanel)
), 'Connect errors must be both visibly associated with the button and announced by assistive technology.');
check('Inactive-tab reset claims ownership before server cleanup', () => {
  const resetHandler = sliceBetween(activeTabDialog, /inactive-tab-reset/, /overlay\.addEventListener\(['"]keydown/);
  return resetHandler.indexOf('claimActiveTab()') >= 0
    && resetHandler.indexOf('claimActiveTab()') < resetHandler.indexOf('resetCurrentBrowserSession()');
}, 'DB runtime must be active before the previous server session is reset.');
check('Explicit tab takeover resumes capture polling without replaying view side effects', () => (
  /resumeCurrentViewAfterTabTakeover\(\)/.test(activeTabDialog)
  && /startModuleCapturePolling/.test(resumeAfterTakeover)
  && /startResultCapturePolling/.test(resumeAfterTakeover)
  && /startPageRead/.test(resumeAfterTakeover)
  && !/renderCurrentView\(\)/.test(resumeAfterTakeover)
), 'Taking over a paused tab must restart capture/read services without duplicating result snapshots.');
check('Reduced Motion works for OS and Phone Hub preference', () => (
  /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(source.css)
  && /body\.reduce-motion/.test(source.css)
), 'Support both the OS setting and the in-app preference toggle.');
check('Reduced Motion control exposes the effective OS state', () => {
  const attributes = functionSource(source.app, 'reduceMotionControlAttributes');
  const label = functionSource(source.app, 'reduceMotionControlLabel');
  const scroll = functionSource(source.app, 'scrollToAboutSection');
  return /reduceMotionEnabled\(\)/.test(attributes)
    && /aria-disabled/.test(attributes)
    && /DEVICE SETTING/.test(label)
    && /!reduceMotionEnabled\(\)/.test(scroll);
}, 'aria-pressed, visible text and smooth scrolling must all respect the effective OS/app preference.');
check('Chosen-colour text uses the higher-contrast black or white ink', () => {
  const contrast = functionSource(source.app, 'sessionContrastInk');
  return /blackContrast/.test(contrast)
    && /whiteContrast/.test(contrast)
    && /blackContrast\s*>=\s*whiteContrast/.test(contrast)
    && !/luminance\s*>\s*0\.42/.test(contrast);
}, 'Choose the higher WCAG contrast ratio; the old .42 cutoff fails several built-in colours.');
check('Body does not hide horizontally clipped content at zoom', () => (
  lastCssProperty(source.css, 'body', 'overflow-x') !== 'hidden'
), 'Avoid overflow-x:hidden as the final body rule; it can hide content at 200% zoom.');
check('Touch target baseline is at least 44px', () => (
  /--tap\s*:\s*(?:4[4-9]|[5-9]\d)px/.test(source.css)
), 'Keep interactive targets at least 44×44 CSS pixels.');
check('Essential actions and instructions are not forced to 12px', () => (
  /\.primary-action,\s*\n\.secondary-action\s*\{[\s\S]*?font-size:\s*16px\s*!important/.test(source.css)
  && /\.module-quick-note,[\s\S]*?font-size:\s*14px\s*!important/.test(source.css)
  && /\.input-group label,[\s\S]*?font-size:\s*14px\s*!important/.test(source.css)
), 'Keep 12px for metadata only; visitor actions, status and form labels need readable type.');
check('Colour choice includes a text name and selected state', () => (
  /SHOW_COLOR_NAMES\s*:\s*true/.test(source.config)
  && /selectedColourText/.test(functionSource(source.app, 'screenPersonalSetup'))
  && /aria-live/.test(functionSource(source.app, 'screenPersonalSetup'))
), 'Do not communicate colour choice with hue alone.');
check('Survey has a button/radio alternative to dragging', () => {
  const survey = functionSource(source.app, 'screenSurvey');
  return survey
    && /(type:\s*['"]radio['"]|survey-scale-button)/.test(survey)
    && /(Array\.from\(\{\s*length:\s*10\s*\}|length:\s*10)/.test(survey);
}, 'Provide ten tappable values; a range slider may remain only as an additional option.');
check('Survey questions are separated as independent visual groups', () => {
  const survey = functionSource(source.app, 'screenSurvey');
  return /survey-question-list/.test(survey)
    && /survey-question-section/.test(survey)
    && /\.survey-question-section\s*\{[^}]*margin:\s*0\s+0\s+52px[^}]*padding:\s*0\s+0\s+48px[^}]*border-bottom:/s.test(source.css)
    && /survey-number-option input:checked \+ span\s*\{[^}]*border:\s*1px solid #ffffff[^}]*box-shadow:\s*none/s.test(source.css);
}, 'Give every numbered question substantial space on both sides of a thin divider, while keeping the selected border thin.');
check('Access and no-phone routes survive rerender', () => (
  /name\s*===\s*['"]access['"]/.test(resultRouter)
  && /name\s*===\s*['"]no-phone['"]/.test(resultRouter)
), 'Register both support views in renderCurrentView.');
check('Live camera processing and requested capture are distinguished', () => (
  /Live processing is different from saving a capture/.test(source.app)
  && /stored only (?:after|when) (?:a separate )?visitor request/i.test(source.app + source.content)
), 'The data notice must not imply that live tracking and stored captures are the same thing.');
check('Pre-entry disclosure names the recorded interaction summaries', () => (
  /optional survey and free-text responses/.test(source.app)
  && /reading and scroll progress and time/.test(source.app)
  && /input timing and edit or delete counts/.test(source.app)
  && /Raw keystrokes are not recorded/.test(source.app)
), 'Consent copy must cover the actual summarized UI/read/scroll/visibility/input telemetry without implying raw key logging.');
check('Public data notice states the actual storage, retention and deletion route', () => {
  const arrival = functionSource(source.app, 'screenArrival');
  return /stored in a Supabase project controlled by the artist/i.test(arrival)
    && /kept in private storage/i.test(arrival)
    && /time-limited links/i.test(arrival)
    && /No automatic deletion date is configured/i.test(arrival)
    && /provide your Rose number and approximate visit time/i.test(arrival)
    && !/still being verified/i.test(arrival)
    && !/must not be used to collect visitor data/i.test(arrival);
}, 'The live release must disclose the real remote and local storage, manual retention and workable deletion-request path.');
check('Printed no-phone routes stay conditional until installed controls pass', () => (
  /planned to have an on-site start route/i.test(source.notice)
  && /confirm the final installed control/i.test(source.notice)
), 'The draft notice must not state an untested physical input as an installed fact.');
check('Korean mode localises live artwork image alternatives and key metadata', () => {
  const hero = functionSource(source.app, 'moduleHero');
  const setup = functionSource(source.app, 'screenPersonalSetup');
  return /const\s+heroLabel\s*=\s*\{[\s\S]*?tr\(/.test(hero)
    && /label:\s*heroLabel/.test(hero)
    && /roseVisual\(['"]registration['"],\s*tr\(/.test(setup)
    && /tr\('\uc791\ub3d9\ubc95',\s*'HOW TO PLAY'\)/.test(source.app)
    && /tr\('\ucea1\ucc98 \/ \uc791\ud488 01, 02, 03',\s*'CAPTURES \/ WORKS 01, 02, 03'\)/.test(source.app);
}, 'Visible and screen-reader labels must not remain unmarked English under html[lang=ko].');
check('Consent is not true by default', () => (
  /consent\s*:\s*false/.test(functionSource(source.app, 'ensureSession'))
  && /if\s*\(!session\?\.consent\s*\|\|\s*session\.local_only\)\s*return null/.test(functionSource(source.app, 'logEvent'))
), 'Do not upload analytics before an explicit Phone Hub choice.');
check('No-phone route does not silently convert to remote consent', () => (
  /REVIEW PHONE HUB & CONNECT[\s\S]{0,500}screenArrival\(\)/.test(screenModule)
), 'Return to the full data notice before creating a remote session from the no-phone route.');
check('Every live work has English troubleshooting copy', () => (
  (moduleDefinitions.match(/troubleshootEn\s*:/g) || []).length >= 4
  && /module\.troubleshootEn\s*\|\|/.test(screenModule)
), 'English visitors need recovery steps, not a duplicate of the play instructions.');
check('Requested captures have individual save controls', () => (
  /function\s+saveCaptureFromUrl\s*\(/.test(source.app)
  && /capture-result-save/.test(source.app)
  && /result-capture-card-actions/.test(source.app)
), 'Separate artwork capture from phone-side image viewing and saving.');

const requiredFailures = results.filter((result) => result.required && !result.passed);
const warnings = results.filter((result) => !result.required && !result.passed);

for (const result of results) {
  const marker = result.passed ? 'PASS' : (result.required ? 'FAIL' : 'WARN');
  console.log(`${marker.padEnd(4)}  ${result.name}`);
  if (!result.passed) {
    console.log(`      ${result.hint}`);
    if (result.error) console.log(`      ${result.error.message}`);
  }
}

console.log('\nStatic Melbourne checks');
console.log(`  Passed: ${results.filter((result) => result.passed).length}`);
console.log(`  Failed: ${requiredFailures.length}`);
console.log(`  Warnings: ${warnings.length}`);
console.log('\nNot covered here: actual TD capture triggers and end/reset signals, Supabase RLS,');
console.log('capture attribution during visitor turnover, Safari/Chrome device behaviour,');
console.log('screen-reader announcements, 200% visual reflow, and physical venue access.');

if (requiredFailures.length) process.exitCode = 1;
