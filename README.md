# Travel-time map — 29 Windstone Dr, Marinwood

A Bay Area travel-time (isochrone) map showing how far you can get from
**29 Windstone Dr, Marinwood (San Rafael), CA** by car, bike, or on foot.
Each shaded band on the map is everywhere reachable within that many minutes.

## Features

- **Three tabs** — 🚗 Drive, 🚴 Bike, 🚶 Walk (also reachable at `/drive`,
  `/bike`, `/walk`).
- **Rush-hour modeling for driving** — instead of a simple on/off switch, a
  departure-time slider (with Off-peak / AM rush / PM rush presets) scales
  free-flow drive times by a typical Bay Area weekday congestion factor
  (up to ~1.75× at the 5 PM peak). It's an estimate — the free routing
  server has no live traffic data.
- **Real network isochrones**, not circles — computed by the
  [Valhalla](https://valhalla.openstreetmap.de) routing engine on
  OpenStreetMap data (free FOSSGIS server, no API key).
- Light/dark map themes, hover tooltips on each band, and a legend.
- Results are cached in the browser for a week to be gentle on the free
  servers (Valhalla for isochrones, Nominatim for geocoding, CARTO tiles).

## Running

```
npm install
npm start
```

Then open http://localhost:4000. The isochrones and geocoding are fetched
by the browser at page load, so the machine viewing the page needs internet
access (the server itself does not).

---

*Originally the minimal Node.js starter for MGT-656 HW2 at the Yale School
of Management; the `/nickname` route from that assignment still works.*
