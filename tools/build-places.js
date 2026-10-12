#!/usr/bin/env node
// Regenerates desktop/src/places.tsv, the offline town list behind
// NEARBY → SAME AREA. Ember never reads GPS or calls a geolocation service:
// the user picks a town from this list and only that town's centre is used.
//
// Data: GeoNames (https://www.geonames.org), CC BY 4.0, via the
// all-the-cities npm package. Towns with at least MIN_POP inhabitants.
//
//   npm i --no-save all-the-cities@3.1.0
//   node tools/build-places.js
const fs = require('fs')
const path = require('path')
const MIN_POP = 5000
const cities = require('all-the-cities')
const clean = s => String(s).replace(/[\t\n\r|]/g, ' ').trim()
const rows = cities
  .filter(c => c.population >= MIN_POP && c.loc && Array.isArray(c.loc.coordinates))
  .sort((a, b) => b.population - a.population)
  .map(c => [clean(c.name), c.country, c.loc.coordinates[1].toFixed(2), c.loc.coordinates[0].toFixed(2), c.population].join('\t'))
const out = path.join(__dirname, '..', 'desktop', 'src', 'places.tsv')
fs.writeFileSync(out, '# name\tcountry\tlat\tlon\tpopulation · GeoNames (geonames.org), CC BY 4.0 · regenerate: node tools/build-places.js\n' + rows.join('\n') + '\n')
console.log(`wrote ${rows.length} places → ${path.relative(process.cwd(), out)}`)
