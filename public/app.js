/* Travel-time (isochrone) map from 29 Windstone Dr, Marinwood.
 * Isochrones: Valhalla (FOSSGIS/OpenStreetMap) — free, no API key.
 * Geocoding: Nominatim. Basemap: CARTO / OpenStreetMap.
 * Everything is fetched client-side and cached in localStorage.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ config

  var ORIGIN = {
    label: '29 Windstone Dr, Marinwood',
    query: '29 Windstone Drive, San Rafael, California 94903',
    // Marinwood fallback used until Nominatim answers (or if it can't).
    fallback: { lat: 38.0316, lon: -122.5477 }
  };

  var VALHALLA_URL = 'https://valhalla1.openstreetmap.de/isochrone';
  var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

  var MODES = {
    drive: { costing: 'auto',       bands: [15, 30, 60, 90], noun: 'by car',     legend: 'Travel time by car' },
    bike:  { costing: 'bicycle',    bands: [15, 30, 60, 90], noun: 'by bike',    legend: 'Travel time by bike' },
    walk:  { costing: 'pedestrian', bands: [15, 30, 45, 60], noun: 'on foot',    legend: 'Travel time on foot' }
  };

  // Typical SF Bay Area weekday congestion multiplier by departure hour.
  // 1.0 = free-flow. Peaks ~1.75x at the 5 PM crush. An estimate — the free
  // Valhalla server has no live traffic data.
  var HOURLY_FACTOR = {
    4: 1.0, 5: 1.0, 6: 1.2, 7: 1.5, 8: 1.65, 9: 1.5, 10: 1.25, 11: 1.2,
    12: 1.2, 13: 1.2, 14: 1.25, 15: 1.4, 16: 1.6, 17: 1.75, 18: 1.65,
    19: 1.35, 20: 1.15, 21: 1.05, 22: 1.0
  };

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
    theme: null,              // 'light' | 'dark'
    departHour: 5,            // drive tab departure hour (5 AM = free-flow)
    origin: null,             // {lat, lon, approximate}
    fitted: {},               // mode -> bool, so we only auto-zoom once per mode
    renderToken: 0            // guards against out-of-order async renders
  };

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
    renderActiveMode(true);
  });

  // ---------------------------------------------------------------- geocode

  // Windstone Dr sits in the Miller Creek townhomes in Marinwood; only accept
  // geocode hits inside this tight box AND whose name mentions the street —
  // otherwise a ZIP/city centroid miles away can sneak through.
  var MARINWOOD_BOX = { south: 37.99, north: 38.09, west: -122.63, east: -122.47 };

  function usableHit(lat, lon, name) {
    return isFinite(lat) && isFinite(lon) &&
      lat > MARINWOOD_BOX.south && lat < MARINWOOD_BOX.north &&
      lon > MARINWOOD_BOX.west && lon < MARINWOOD_BOX.east &&
      /windstone/i.test(name || '');
  }

  function geocodeNominatim() {
    var url = NOMINATIM_URL + '?format=jsonv2&limit=3&countrycodes=us' +
      '&street=' + encodeURIComponent('29 Windstone Drive') +
      '&city=' + encodeURIComponent('San Rafael') +
      '&state=California&postalcode=94903';
    return fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, 8000)
      .then(function (res) { return res.json(); })
      .then(function (results) {
        var hit = (results || []).filter(function (r) {
          return usableHit(parseFloat(r.lat), parseFloat(r.lon), r.display_name);
        })[0];
        if (!hit) throw new Error('no usable Nominatim result');
        return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), approximate: false };
      });
  }

  function geocodePhoton() {
    var url = 'https://photon.komoot.io/api/?limit=5&lat=38.03&lon=-122.55&q=' +
      encodeURIComponent('29 Windstone Drive San Rafael');
    return fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, 8000)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var hit = ((data && data.features) || []).filter(function (f) {
          var p = f.properties || {};
          var c = (f.geometry || {}).coordinates || [];
          return usableHit(c[1], c[0], [p.name, p.street].join(' '));
        })[0];
        if (!hit) throw new Error('no usable Photon result');
        var coords = hit.geometry.coordinates;
        return { lat: coords[1], lon: coords[0], approximate: false };
      });
  }

  var ORIGIN_OVERRIDE_KEY = 'origin-override:v1';

  function geocodeOrigin() {
    // A hand-corrected pin (dragged marker) always wins.
    try {
      var override = JSON.parse(localStorage.getItem(ORIGIN_OVERRIDE_KEY));
      if (override && isFinite(override.lat)) return Promise.resolve(override);
    } catch (e) {}

    var cacheKey = 'geo:v2:' + ORIGIN.query;
    var cached = cacheGet(cacheKey);
    if (cached) return Promise.resolve(cached);

    return geocodeNominatim()
      .catch(function () { return geocodePhoton(); })
      .then(function (loc) {
        cacheSet(cacheKey, loc);
        return loc;
      })
      .catch(function () {
        return { lat: ORIGIN.fallback.lat, lon: ORIGIN.fallback.lon, approximate: true };
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
      if (modeKey === 'drive' && currentFactor() > 1.01) {
        label += ' (' + trafficWord(currentFactor()) + ')';
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

    if (!state.fitted[modeKey]) {
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
      state.fitted[modeKey] = true;
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
      var f = currentFactor();
      note.textContent = f > 1.01
        ? 'Departing ' + hourLabel(state.departHour) + ' · ' + trafficWord(f) +
          ' (≈' + f + '× free-flow, estimated)'
        : 'Free-flow (no congestion)';
    } else {
      note.textContent = '';
    }
  }

  // -------------------------------------------------------------- mode logic

  function currentFactor() {
    return state.mode === 'drive' ? (HOURLY_FACTOR[state.departHour] || 1.0) : 1.0;
  }

  function renderActiveMode(force) {
    var modeKey = state.mode;
    var token = ++state.renderToken;
    showStatus('Computing ' + modeKey + ' travel times… (first time can take ~20 s)');

    fetchIsochrones(modeKey, currentFactor())
      .then(function (geojson) {
        if (token !== state.renderToken) return; // a newer render superseded us
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

  var prefetched = false;
  function prefetchOtherModes() {
    if (prefetched) return;
    prefetched = true;
    Object.keys(MODES).forEach(function (m) {
      if (m !== state.mode) fetchIsochrones(m, 1.0).catch(function () {});
    });
  }

  function setMode(modeKey, updateUrl) {
    if (!MODES[modeKey]) modeKey = 'drive';
    state.mode = modeKey;

    document.querySelectorAll('.tab').forEach(function (btn) {
      btn.setAttribute('aria-selected', String(btn.dataset.mode === modeKey));
    });
    document.getElementById('traffic-panel').hidden = (modeKey !== 'drive');

    if (updateUrl !== false) {
      // Hash-based so it works when hosted under a subpath (e.g. GitHub Pages).
      history.replaceState(null, '', '#' + modeKey);
    }
    if (state.origin) renderActiveMode();
  }

  function modeFromUrl() {
    // Last path segment, so /drive and /mgt656-hw2/drive both work.
    var seg = location.pathname.split('/').filter(Boolean).pop() || '';
    var hash = location.hash.replace(/^#/, '');
    if (MODES[hash]) return hash;
    if (MODES[seg]) return seg;
    return 'drive';
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
    var f = HOURLY_FACTOR[state.departHour] || 1.0;
    readout.textContent = hourLabel(state.departHour) + ' · ' + trafficWord(f) +
      (f > 1.01 ? ' (≈' + f + '×)' : '');
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
    if (state.mode && state.origin && isoLayerGroup.getLayers().length) {
      var cached = cacheGet(['iso', CACHE_VERSION, MODES[state.mode].costing,
        Math.round(currentFactor() * 100) / 100,
        state.origin.lat.toFixed(5), state.origin.lon.toFixed(5)].join(':'));
      if (cached) renderIsochrones(state.mode, cached);
      else renderLegend(state.mode);
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

  function initMap() {
    map = L.map('map', {
      center: [ORIGIN.fallback.lat, ORIGIN.fallback.lon],
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
    return ORIGIN.label + ' (' + note + ' — drag pin to adjust)';
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
    // origin, recomputes every mode from there, and remembers the correction.
    homeMarker.on('dragend', function () {
      var p = homeMarker.getLatLng();
      state.origin = { lat: p.lat, lon: p.lng, approximate: false, custom: true };
      try {
        localStorage.setItem(ORIGIN_OVERRIDE_KEY, JSON.stringify(state.origin));
      } catch (e) {}
      homeMarker.setTooltipContent(markerTooltipText());
      state.fitted = {};
      prefetched = false;
      renderActiveMode();
    });
  }

  initTheme();
  initMap();
  updateTrafficUI();
  setMode(modeFromUrl(), false);

  showStatus('Locating ' + ORIGIN.label + '…');
  geocodeOrigin().then(function (loc) {
    state.origin = loc;
    placeHomeMarker();
    map.setView([loc.lat, loc.lon], 10);
    renderActiveMode();
  });

  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setMode(btn.dataset.mode);
    });
  });

  window.addEventListener('hashchange', function () {
    setMode(modeFromUrl());
  });
})();
