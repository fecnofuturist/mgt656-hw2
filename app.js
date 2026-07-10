/* Travel-time (isochrone) map for a set of Bay Area home addresses.
 * Isochrones: Valhalla (FOSSGIS/OpenStreetMap) — free, no API key.
 * Geocoding: Nominatim (Photon fallback). Basemap: CARTO / OpenStreetMap.
 * Everything is fetched client-side and cached in localStorage.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ config

  // Each origin carries its own geocode validation (tight bounding box + a
  // street-name pattern so a ZIP/city centroid can't sneak through) and its
  // own commute geometry for the directional rush-hour model.
  var ORIGINS = {
    marinwood: {
      key: 'marinwood',
      label: '29 Windstone Dr, Marinwood',
      short: 'Marinwood',
      street: '29 Windstone Drive', city: 'San Rafael', postalcode: '94903',
      freeQuery: '29 Windstone Drive San Rafael',
      match: /windstone/i,
      box: { south: 37.99, north: 38.09, west: -122.63, east: -122.47 },
      fallback: { lat: 38.0316, lon: -122.5477 },
      // AM crush: 101 south toward SF + Richmond Bridge. PM: homeward north
      // through Marin + bridge outbound.
      sectors: {
        am: { from: 90, to: 270, label: 'toward SF / East Bay' },
        pm: { from: 250, to: 110, label: 'toward Novato / East Bay' }
      }
    },
    piedmont: {
      key: 'piedmont',
      label: '911 Moraga Ave, Piedmont',
      short: 'Piedmont',
      street: '911 Moraga Avenue', city: 'Piedmont', postalcode: '94611',
      freeQuery: '911 Moraga Avenue Piedmont California',
      match: /moraga/i,
      box: { south: 37.79, north: 37.86, west: -122.29, east: -122.19 },
      fallback: { lat: 37.8255, lon: -122.2354 },
      // AM crush: Bay Bridge toward SF + 880 toward the South Bay. PM: the
      // outbound flood — 24 east through the tunnel and 80/580 north.
      sectors: {
        am: { from: 170, to: 300, label: 'toward SF / South Bay' },
        pm: { from: 300, to: 120, label: 'toward Walnut Creek / north & east' }
      }
    },
    berkeley: {
      key: 'berkeley',
      label: '1601 Lincoln St, Berkeley',
      short: 'Berkeley',
      street: '1601 Lincoln Street', city: 'Berkeley', postalcode: '94703',
      freeQuery: '1601 Lincoln Street Berkeley California',
      match: /lincoln/i,
      box: { south: 37.84, north: 37.91, west: -122.32, east: -122.22 },
      fallback: { lat: 37.8775, lon: -122.2760 },
      // AM crush: 80 south + Bay Bridge toward SF and 880 toward Oakland.
      // PM: outbound — 80 north toward Richmond and east through the hills.
      sectors: {
        am: { from: 160, to: 290, label: 'toward SF / Oakland' },
        pm: { from: 290, to: 120, label: 'toward Richmond / north & east' }
      }
    }
  };
  var DEFAULT_ORIGIN = 'marinwood';

  var VALHALLA_URL = 'https://valhalla1.openstreetmap.de/isochrone';
  var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

  var MODES = {
    drive: { costing: 'auto',       bands: [15, 30, 60, 90], noun: 'by car',  legend: 'Travel time by car' },
    bike:  { costing: 'bicycle',    bands: [15, 30, 60, 90], noun: 'by bike', legend: 'Travel time by bike' },
    walk:  { costing: 'pedestrian', bands: [15, 30, 45, 60], noun: 'on foot', legend: 'Travel time on foot' }
  };

  // Typical SF Bay Area weekday congestion by departure hour, split by
  // direction: h = multiplier in the peak commute direction, l = in the
  // counter-commute direction. An estimate — the free Valhalla server has no
  // traffic data — but directionally shaped per origin (see ORIGINS.sectors).
  var TRAFFIC = {
    4:  { h: 1.0,  l: 1.0 },  5:  { h: 1.0,  l: 1.0 },
    6:  { h: 1.35, l: 1.1 },  7:  { h: 1.6,  l: 1.15 },
    8:  { h: 1.7,  l: 1.2 },  9:  { h: 1.55, l: 1.15 },
    10: { h: 1.3,  l: 1.1 },  11: { h: 1.25, l: 1.15 },
    12: { h: 1.25, l: 1.15 }, 13: { h: 1.25, l: 1.15 },
    14: { h: 1.35, l: 1.2 },  15: { h: 1.5,  l: 1.25 },
    16: { h: 1.65, l: 1.3 },  17: { h: 1.75, l: 1.35 },
    18: { h: 1.65, l: 1.3 },  19: { h: 1.35, l: 1.15 },
    20: { h: 1.15, l: 1.05 }, 21: { h: 1.05, l: 1.0 },
    22: { h: 1.0,  l: 1.0 }
  };

  function factorsFor(hour) { return TRAFFIC[hour] || { h: 1.0, l: 1.0 }; }

  // Peak-flow compass wedge for an origin at a given departure hour.
  // Before 2 PM the crush is job-center-bound; after, homeward/outbound.
  function sectorFor(def, hour) {
    return hour < 14 ? def.sectors.am : def.sectors.pm;
  }

  function trafficWord(f) {
    if (f >= 1.6) return 'heavy traffic';
    if (f >= 1.4) return 'busy traffic';
    if (f >= 1.15) return 'moderate traffic';
    return 'light traffic';
  }

  // Ordinal blue ramps (validated): index 0 = shortest band = most salient.
  var PALETTES = {
    light: ['#0d366b', '#1c5cab', '#3987e5', '#86b6ef'],
    dark:  ['#9ec5f4', '#5598e7', '#2a78d6', '#184f95']
  };

  // Voyager basemap: parks/green space, water, colored roads. Labels come
  // from a separate tile layer drawn ABOVE the isochrone fills so road and
  // place names stay readable.
  var TILES = {
    light: {
      base:   'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png',
      labels: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png'
    },
    dark: {
      base:   'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
      labels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'
    }
  };
  var TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
    ' &copy; <a href="https://carto.com/attributions">CARTO</a>' +
    ' &middot; isochrones <a href="https://valhalla.openstreetmap.de">Valhalla/FOSSGIS</a>';

  var CACHE_VERSION = 'v1';
  var CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // one week

  // ------------------------------------------------------------------ state

  var state = {
    mode: null,               // 'drive' | 'bike' | 'walk'
    originKey: null,          // key into ORIGINS
    theme: null,              // 'light' | 'dark'
    departHour: 5,            // drive tab departure hour (5 AM = free-flow)
    origin: null,             // resolved {lat, lon, approximate, custom}
    currentGeo: null,         // last rendered isochrone FeatureCollection
    fitted: {},               // originKey:mode -> bool (auto-zoom once each)
    renderToken: 0            // guards against out-of-order async renders
  };

  function activeOrigin() { return ORIGINS[state.originKey] || ORIGINS[DEFAULT_ORIGIN]; }

  var map, tileLayer, labelLayer, isoLayerGroup, homeMarker;

  // fetch() with a hard timeout so a stalled server can't hang the app.
  function fetchWithTimeout(url, options, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    var opts = Object.assign({}, options, { signal: ctrl.signal });
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  // ------------------------------------------------------------------ cache

  function cacheGet(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry.ts || Date.now() - entry.ts > CACHE_TTL_MS) {
        localStorage.removeItem(key);
        return null;
      }
      return entry.data;
    } catch (e) { return null; }
  }

  function cacheSet(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) { /* storage full or disabled — just skip caching */ }
  }

  // ---------------------------------------------------- polite request queue
  // The FOSSGIS server asks for ~1 request/second, so space requests out.

  var queue = Promise.resolve();
  function enqueue(fn) {
    var run = queue.then(function () { return fn(); });
    // Keep the chain alive on failure and pause between requests.
    queue = run.catch(function () {}).then(function () {
      return new Promise(function (r) { setTimeout(r, 1100); });
    });
    return run;
  }

  // ------------------------------------------------------------------ status

  var statusEl = document.getElementById('status');
  var statusText = document.getElementById('status-text');
  var retryBtn = document.getElementById('retry-btn');

  function showStatus(msg, isError) {
    statusEl.hidden = false;
    statusEl.classList.toggle('error', !!isError);
    statusText.textContent = msg;
    retryBtn.hidden = !isError;
  }
  function hideStatus() { statusEl.hidden = true; }

  retryBtn.addEventListener('click', function () {
    hideStatus();
    renderActiveMode();
  });

  // ---------------------------------------------------------------- geocode

  function usableHit(def, lat, lon, name) {
    return isFinite(lat) && isFinite(lon) &&
      lat > def.box.south && lat < def.box.north &&
      lon > def.box.west && lon < def.box.east &&
      def.match.test(name || '');
  }

  function geocodeNominatim(def) {
    var url = NOMINATIM_URL + '?format=jsonv2&limit=3&countrycodes=us' +
      '&street=' + encodeURIComponent(def.street) +
      '&city=' + encodeURIComponent(def.city) +
      '&state=California&postalcode=' + def.postalcode;
    return fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, 8000)
      .then(function (res) { return res.json(); })
      .then(function (results) {
        var hit = (results || []).filter(function (r) {
          return usableHit(def, parseFloat(r.lat), parseFloat(r.lon), r.display_name);
        })[0];
        if (!hit) throw new Error('no usable Nominatim result');
        return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), approximate: false };
      });
  }

  function geocodePhoton(def) {
    var url = 'https://photon.komoot.io/api/?limit=5' +
      '&lat=' + def.fallback.lat + '&lon=' + def.fallback.lon +
      '&q=' + encodeURIComponent(def.freeQuery);
    return fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, 8000)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var hit = ((data && data.features) || []).filter(function (f) {
          var p = f.properties || {};
          var c = (f.geometry || {}).coordinates || [];
          return usableHit(def, c[1], c[0], [p.name, p.street].join(' '));
        })[0];
        if (!hit) throw new Error('no usable Photon result');
        var coords = hit.geometry.coordinates;
        return { lat: coords[1], lon: coords[0], approximate: false };
      });
  }

  function overrideKey(def) { return 'origin-override:v2:' + def.key; }

  function geocodeOrigin(def) {
    // A hand-corrected pin (dragged marker) always wins. (v1 was the single
    // Marinwood-only key from before multiple origins existed.)
    try {
      var raw = localStorage.getItem(overrideKey(def)) ||
        (def.key === 'marinwood' ? localStorage.getItem('origin-override:v1') : null);
      var override = JSON.parse(raw);
      if (override && isFinite(override.lat)) return Promise.resolve(override);
    } catch (e) {}

    var cacheKey = 'geo:v3:' + def.key;
    var cached = cacheGet(cacheKey);
    if (cached) return Promise.resolve(cached);

    return geocodeNominatim(def)
      .catch(function () { return geocodePhoton(def); })
      .then(function (loc) {
        cacheSet(cacheKey, loc);
        return loc;
      })
      .catch(function () {
        return { lat: def.fallback.lat, lon: def.fallback.lon, approximate: true };
      });
  }

  // -------------------------------------------------------------- isochrones

  // Scale the nominal band times down by the congestion factor: in 30 minutes
  // of rush-hour driving you cover roughly what 30/factor minutes covers in
  // free-flow, which is what the routing engine can actually compute.
  function contourTimes(bands, factor) {
    var used = {};
    return bands.map(function (t) {
      var scaled = Math.max(3, Math.round(t / factor));
      while (used[scaled]) scaled += 1; // contours must be strictly increasing
      used[scaled] = true;
      return scaled;
    });
  }

  function fetchIsochrones(modeKey, factor) {
    var mode = MODES[modeKey];
    var o = state.origin;
    var f = Math.round(factor * 100) / 100;
    var cacheKey = ['iso', CACHE_VERSION, mode.costing, f,
      o.lat.toFixed(5), o.lon.toFixed(5)].join(':');

    var cached = cacheGet(cacheKey);
    if (cached) return Promise.resolve(cached);

    var times = contourTimes(mode.bands, f);
    var body = {
      locations: [{ lat: o.lat, lon: o.lon }],
      costing: mode.costing,
      contours: times.map(function (t) { return { time: t }; }),
      polygons: true,
      denoise: 0.3,
      generalize: 100
    };

    return enqueue(function () {
      return fetchWithTimeout(VALHALLA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, 60000).then(function (res) {
        if (!res.ok) throw new Error('Valhalla HTTP ' + res.status);
        return res.json();
      }).then(function (geojson) {
        if (!geojson.features || !geojson.features.length) {
          throw new Error(geojson.error || 'empty isochrone response');
        }
        // Tag each feature with the *nominal* band minutes it represents.
        geojson.features.forEach(function (feat) {
          var idx = times.indexOf(Math.round(feat.properties.contour));
          feat.properties.band = idx >= 0 ? mode.bands[idx] : feat.properties.contour;
        });
        cacheSet(cacheKey, geojson);
        return geojson;
      });
    });
  }

  // --------------------------------------------------------------- rendering

  function bandLabel(bands, i) {
    return i === 0 ? '≤ ' + bands[0] + ' min'
                   : bands[i - 1] + '–' + bands[i] + ' min';
  }

  // Convert nested polygons into non-overlapping rings so each band shows its
  // own color. Falls back to plain stacked polygons if turf is unavailable.
  function toRings(features) {
    var sorted = features.slice().sort(function (a, b) {
      return a.properties.band - b.properties.band; // small → large
    });
    var rings = [];
    for (var i = sorted.length - 1; i >= 0; i--) {
      var outer = sorted[i];
      var ring = outer;
      if (i > 0 && window.turf) {
        try {
          var diff = turf.difference(outer, sorted[i - 1]);
          if (diff) {
            diff.properties = outer.properties;
            ring = diff;
          }
        } catch (e) { /* keep the full polygon */ }
      }
      rings.push(ring); // largest first, so smaller bands draw on top
    }
    return { rings: rings, sorted: sorted };
  }

  function renderIsochrones(modeKey, geojson) {
    var mode = MODES[modeKey];
    var palette = PALETTES[state.theme];
    var result = toRings(geojson.features);

    isoLayerGroup.clearLayers();

    result.rings.forEach(function (feat) {
      var band = feat.properties.band;
      var i = mode.bands.indexOf(band);
      if (i < 0) i = mode.bands.length - 1;
      var color = palette[i];
      var label = bandLabel(mode.bands, i) + ' ' + mode.noun;
      var tf = currentTraffic();
      if (modeKey === 'drive' && tf.h > 1.01) {
        label += ' (rush-hour estimate)';
      }
      L.geoJSON(feat, {
        style: {
          color: color,
          weight: 1.8,
          opacity: 0.9,
          fillColor: color,
          fillOpacity: 0.3
        }
      }).bindTooltip(label, { sticky: true, className: 'band-tip' })
        .addTo(isoLayerGroup);
    });

    homeMarker.bringToFront && homeMarker.bringToFront();

    var fitKey = state.originKey + ':' + modeKey;
    if (!state.fitted[fitKey]) {
      // Start focused on the 30-min band (outermost for walking) — fitting
      // the 90-min drive blob zooms out to the whole Bay Area.
      var fitBand = modeKey === 'walk'
        ? mode.bands[mode.bands.length - 1]
        : mode.bands[1];
      var fitFeat = result.sorted.filter(function (f) {
        return f.properties.band === fitBand;
      })[0] || result.sorted[result.sorted.length - 1];
      var bounds = L.geoJSON(fitFeat).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
      state.fitted[fitKey] = true;
    }

    renderLegend(modeKey);
  }

  function renderLegend(modeKey) {
    var mode = MODES[modeKey];
    var palette = PALETTES[state.theme];
    document.getElementById('legend-title').textContent = mode.legend;

    var rows = document.getElementById('legend-rows');
    rows.innerHTML = '';
    mode.bands.forEach(function (b, i) {
      var row = document.createElement('div');
      row.className = 'legend-row';
      var chip = document.createElement('span');
      chip.className = 'legend-chip';
      chip.style.background = palette[i];
      var text = document.createElement('span');
      text.textContent = bandLabel(mode.bands, i);
      row.appendChild(chip);
      row.appendChild(text);
      rows.appendChild(row);
    });

    var note = document.getElementById('legend-note');
    if (modeKey === 'drive') {
      var f = currentTraffic();
      note.textContent = f.h > 1.01
        ? 'Departing ' + hourLabel(state.departHour) + ' · ≈' + f.h + '× ' +
          sectorFor(activeOrigin(), state.departHour).label + ', ≈' + f.l +
          '× other directions (estimated)'
        : 'Free-flow (no congestion)';
    } else {
      note.textContent = '';
    }
  }

  // -------------------------------------------------------------- mode logic

  function currentTraffic() {
    return state.mode === 'drive' ? factorsFor(state.departHour) : { h: 1.0, l: 1.0 };
  }

  // A wedge polygon from the origin covering bearings [from → to] clockwise,
  // big enough (300 km) to cover any isochrone.
  function sectorPolygon(o, fromB, toB) {
    var center = turf.point([o.lon, o.lat]);
    var end = toB <= fromB ? toB + 360 : toB;
    var coords = [[o.lon, o.lat]];
    for (var b = fromB; b < end; b += 6) {
      coords.push(turf.destination(center, 300, b).geometry.coordinates);
    }
    coords.push(turf.destination(center, 300, end).geometry.coordinates);
    coords.push([o.lon, o.lat]);
    return turf.polygon([coords]);
  }

  // Stitch a directional rush-hour isochrone: the heavy-factor polygon in the
  // peak-flow wedge, the light-factor polygon everywhere else.
  function combineDirectional(heavyGeo, lightGeo, hour) {
    if (!window.turf) return heavyGeo;
    try {
      var sector = sectorFor(activeOrigin(), hour);
      var wedge = sectorPolygon(state.origin, sector.from, sector.to);
      var features = heavyGeo.features.map(function (hFeat) {
        var band = hFeat.properties.band;
        var lFeat = lightGeo.features.filter(function (f) {
          return f.properties.band === band;
        })[0];
        if (!lFeat) return hFeat;
        var heavyPart = turf.intersect(hFeat, wedge);
        var lightPart = turf.difference(lFeat, wedge);
        var merged = heavyPart && lightPart ? turf.union(heavyPart, lightPart)
                                            : (heavyPart || lightPart || hFeat);
        merged.properties = { band: band };
        return merged;
      });
      return { type: 'FeatureCollection', features: features };
    } catch (e) {
      // Geometry hiccup — fall back to the conservative uniform-heavy shape.
      return heavyGeo;
    }
  }

  function renderActiveMode() {
    var modeKey = state.mode;
    var token = ++state.renderToken;
    showStatus('Computing ' + modeKey + ' travel times… (first time can take ~20 s)');

    var tf = modeKey === 'drive' ? factorsFor(state.departHour) : { h: 1.0, l: 1.0 };
    var pending = tf.h > 1.01
      ? Promise.all([fetchIsochrones(modeKey, tf.h), fetchIsochrones(modeKey, tf.l)])
          .then(function (both) {
            return combineDirectional(both[0], both[1], state.departHour);
          })
      : fetchIsochrones(modeKey, 1.0);

    pending
      .then(function (geojson) {
        if (token !== state.renderToken) return; // a newer render superseded us
        state.currentGeo = geojson;
        renderIsochrones(modeKey, geojson);
        hideStatus();
        prefetchOtherModes();
      })
      .catch(function (err) {
        if (token !== state.renderToken) return;
        console.error(err);
        showStatus('Could not reach the routing server. It may be busy — try again.', true);
      });
  }

  var prefetchedOrigins = {};
  function prefetchOtherModes() {
    if (prefetchedOrigins[state.originKey]) return;
    prefetchedOrigins[state.originKey] = true;
    Object.keys(MODES).forEach(function (m) {
      if (m !== state.mode) fetchIsochrones(m, 1.0).catch(function () {});
    });
  }

  // ------------------------------------------------------------- navigation

  function updateHash() {
    if (!state.originKey || !state.mode) return;
    history.replaceState(null, '', '#' + state.originKey + '/' + state.mode);
  }

  function urlSegments() {
    return location.hash.replace(/^#/, '').split('/')
      .concat(location.pathname.split('/'))
      .filter(Boolean);
  }

  function modeFromUrl() {
    var seg = urlSegments().filter(function (s) { return MODES[s]; })[0];
    return seg || 'drive';
  }

  function originFromUrl() {
    var seg = urlSegments().filter(function (s) { return ORIGINS[s]; })[0];
    if (seg) return seg;
    try {
      var saved = localStorage.getItem('origin-key');
      if (ORIGINS[saved]) return saved;
    } catch (e) {}
    return DEFAULT_ORIGIN;
  }

  function setMode(modeKey, updateUrl) {
    if (!MODES[modeKey]) modeKey = 'drive';
    state.mode = modeKey;

    document.querySelectorAll('.tab').forEach(function (btn) {
      btn.setAttribute('aria-selected', String(btn.dataset.mode === modeKey));
    });
    document.getElementById('traffic-panel').hidden = (modeKey !== 'drive');

    if (updateUrl !== false) updateHash();
    if (state.origin) renderActiveMode();
  }

  function setOrigin(originKey, updateUrl) {
    if (!ORIGINS[originKey]) originKey = DEFAULT_ORIGIN;
    if (state.originKey === originKey && state.origin) return;
    var def = ORIGINS[originKey];

    state.originKey = originKey;
    state.origin = null;
    state.currentGeo = null;
    try { localStorage.setItem('origin-key', originKey); } catch (e) {}

    document.querySelectorAll('.origin-tab').forEach(function (btn) {
      btn.setAttribute('aria-selected', String(btn.dataset.origin === originKey));
    });
    var nameEl = document.querySelector('.origin-name');
    if (nameEl) nameEl.textContent = def.label;
    if (updateUrl !== false) updateHash();

    showStatus('Locating ' + def.label + '…');
    geocodeOrigin(def).then(function (loc) {
      if (state.originKey !== originKey) return; // switched again meanwhile
      state.origin = loc;
      if (homeMarker) {
        homeMarker.setLatLng([loc.lat, loc.lon]);
        homeMarker.setTooltipContent(markerTooltipText());
      } else {
        placeHomeMarker();
      }
      if (!state.fitted[originKey + ':' + state.mode]) {
        map.setView([loc.lat, loc.lon], 10);
      }
      renderActiveMode();
    });
  }

  // ------------------------------------------------------------ traffic UI

  function hourLabel(h) {
    if (h === 0) return '12 AM';
    if (h < 12) return h + ' AM';
    if (h === 12) return '12 PM';
    return (h - 12) + ' PM';
  }

  var slider = document.getElementById('depart-slider');
  var readout = document.getElementById('traffic-readout');
  var sliderTimer = null;

  function updateTrafficUI() {
    var f = factorsFor(state.departHour);
    readout.textContent = hourLabel(state.departHour) + ' · ' + trafficWord(f.h) +
      (f.h > 1.01 ? ' ' + sectorFor(activeOrigin(), state.departHour).label : '');
    document.querySelectorAll('.preset').forEach(function (btn) {
      btn.classList.toggle('active', Number(btn.dataset.hour) === state.departHour);
    });
  }

  slider.addEventListener('input', function () {
    state.departHour = Number(slider.value);
    updateTrafficUI();
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(function () {
      if (state.mode === 'drive') renderActiveMode();
    }, 450);
  });

  document.querySelectorAll('.preset').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.departHour = Number(btn.dataset.hour);
      slider.value = String(state.departHour);
      updateTrafficUI();
      if (state.mode === 'drive') renderActiveMode();
    });
  });

  // ---------------------------------------------------------------- theming

  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (e) {}
    if (tileLayer) tileLayer.setUrl(TILES[theme].base);
    if (labelLayer) labelLayer.setUrl(TILES[theme].labels);
    // Re-tint existing isochrones + legend without refetching.
    if (state.mode && state.currentGeo) {
      renderIsochrones(state.mode, state.currentGeo);
    } else if (state.mode && state.origin) {
      renderLegend(state.mode);
    }
  }

  document.getElementById('theme-toggle').addEventListener('click', function () {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  // ------------------------------------------------------------------ about

  var aboutDialog = document.getElementById('about');
  document.getElementById('about-btn').addEventListener('click', function () {
    aboutDialog.showModal();
  });

  // ------------------------------------------------------------------- init

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) {}
    var theme = saved ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark' : 'light');
    applyTheme(theme);
  }

  function initMap(startDef) {
    map = L.map('map', {
      center: [startDef.fallback.lat, startDef.fallback.lon],
      zoom: 10,
      minZoom: 7,
      maxBounds: [[36.4, -124.2], [39.6, -120.3]], // loose Bay Area cage
      maxBoundsViscosity: 0.7,
      zoomControl: true
    });
    // Labels render in their own pane above the isochrone fills (overlayPane
    // is z-index 400) so road and place names stay readable.
    map.createPane('labels');
    map.getPane('labels').style.zIndex = 450;
    map.getPane('labels').style.pointerEvents = 'none';
    tileLayer = L.tileLayer(TILES[state.theme].base, {
      attribution: TILE_ATTR,
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);
    labelLayer = L.tileLayer(TILES[state.theme].labels, {
      subdomains: 'abcd',
      maxZoom: 19,
      pane: 'labels'
    }).addTo(map);
    isoLayerGroup = L.layerGroup().addTo(map);
  }

  function markerTooltipText() {
    var o = state.origin;
    var note = o.custom ? 'custom pin' : (o.approximate ? 'approximate' : 'geocoded');
    return activeOrigin().label + ' (' + note + ' — drag pin to adjust)';
  }

  function placeHomeMarker() {
    var o = state.origin;
    var icon = L.divIcon({
      className: '',
      html: '<div class="home-marker">🏠</div>',
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
    homeMarker = L.marker([o.lat, o.lon], {
      icon: icon,
      zIndexOffset: 1000,
      draggable: true
    }).addTo(map).bindTooltip(markerTooltipText(), { className: 'band-tip' });

    // If the geocoder put the pin in the wrong spot, dragging it fixes the
    // origin, recomputes every mode from there, and remembers the correction
    // (per address).
    homeMarker.on('dragend', function () {
      var p = homeMarker.getLatLng();
      state.origin = { lat: p.lat, lon: p.lng, approximate: false, custom: true };
      try {
        localStorage.setItem(overrideKey(activeOrigin()), JSON.stringify(state.origin));
      } catch (e) {}
      homeMarker.setTooltipContent(markerTooltipText());
      Object.keys(state.fitted).forEach(function (k) {
        if (k.indexOf(state.originKey + ':') === 0) delete state.fitted[k];
      });
      delete prefetchedOrigins[state.originKey];
      renderActiveMode();
    });
  }

  var startOrigin = originFromUrl();
  initTheme();
  initMap(ORIGINS[startOrigin]);
  updateTrafficUI();
  setMode(modeFromUrl(), false);
  setOrigin(startOrigin, false);

  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setMode(btn.dataset.mode);
    });
  });

  document.querySelectorAll('.origin-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setOrigin(btn.dataset.origin);
    });
  });

  window.addEventListener('hashchange', function () {
    setMode(modeFromUrl(), false);
    setOrigin(originFromUrl(), false);
  });
})();
