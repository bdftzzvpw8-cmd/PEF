// Regenerates proposals/*.html for the named prospects from tools/proposal-template.js.
// Run: node tools/gen-proposals.js
const fs = require('fs'), path = require('path');
const T = require('./proposal-template.js');
const OUT = path.join(__dirname, '..', 'proposals');
const SET = { opName: 'Wrapt', opLegal: 'Wrapt Intelligence LLC', opAddress: 'Franklin, Tennessee', opContact: 'Paige Fryer, Owner', opPhone: '615.948.2976', opEmail: 'paige@wraptvending.com', opWeb: 'wraptvending.com', installFee: '200' };
const PROSPECTS = [
  { slug: 'legacy-fit', company: 'Legacy Fit', short: 'Legacy Fit', venue: 'Gym & fitness' },
  { slug: 'baymont-franklin', company: 'Baymont by Wyndham Franklin', short: 'the Baymont', venue: 'Hotel' },
  { slug: 'american-house-brentwood', company: 'American House Brentwood', short: 'American House', venue: 'Senior living' }
];
fs.mkdirSync(OUT, { recursive: true });
for (const p of PROSPECTS) {
  const d = T.VENUES[p.venue];
  const full = Object.assign({ who: d.who, lead: d.lead, mix: d.mix, spot: d.spot, approval: d.approval, pdate: T.today() }, p);
  const f = path.join(OUT, `proposal-${p.slug}.html`);
  fs.writeFileSync(f, T.proposalHTML(full, SET));
  console.log('wrote', path.relative(process.cwd(), f));
}
