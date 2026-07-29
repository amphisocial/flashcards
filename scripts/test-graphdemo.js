/*
 * Verifies the graph widget's math without a browser. The curve function is
 * the substance of the quadratic lesson page, so it gets tested like code,
 * not eyeballed.
 */
const path = require('path');
const { FAMILIES } = require(path.join(__dirname, '..', 'public', 'graphdemo.js'));

let pass = 0, fail = 0;
function check(name, got, want, tol = 1e-9) {
  const ok = Math.abs(got - want) <= tol;
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}: got ${got}, want ${want}`); }
}

console.log('parabola  y = ax^2 + bx + c');
{
  const f = FAMILIES.parabola.fn;
  // Defaults are a=1, b=0, c=-3 -> y = x^2 - 3
  const d = { a: 1, b: 0, c: -3 };
  check('x=0 -> -3 (the y-intercept is c)', f(0, d), -3);
  check('x=2 -> 1', f(2, d), 1);
  check('x=-2 -> 1 (symmetric)', f(-2, d), 1);
  // c lifts the whole curve
  check('c=+2 lifts vertex to 2', f(0, { a: 1, b: 0, c: 2 }), 2);
  // a flips it
  check('a=-1 flips: x=2 -> -4', f(2, { a: -1, b: 0, c: 0 }), -4);
  // b moves the vertex sideways: vertex at x = -b/2a
  const p = { a: 1, b: -4, c: 0 };
  const vx = -p.b / (2 * p.a);
  check('vertex x = -b/2a = 2', vx, 2);
  check('vertex value = -4', f(vx, p), -4);
}

console.log('line      y = mx + b');
{
  const f = FAMILIES.line.fn;
  check('slope 2, intercept 1 at x=0', f(0, { m: 2, b: 1 }), 1);
  check('slope 2, intercept 1 at x=3', f(3, { m: 2, b: 1 }), 7);
  check('negative slope', f(2, { m: -1.5, b: 0 }), -3);
}

console.log('sine      y = A sin(Bx) + D');
{
  const f = FAMILIES.sine.fn;
  check('A=2,B=1,D=0 at x=0', f(0, { A: 2, B: 1, D: 0 }), 0);
  check('peak at x=pi/2 is A', f(Math.PI / 2, { A: 2, B: 1, D: 0 }), 2, 1e-9);
  check('D shifts vertically', f(0, { A: 2, B: 1, D: 1.5 }), 1.5);
  check('B=2 doubles frequency: peak at pi/4', f(Math.PI / 4, { A: 1, B: 2, D: 0 }), 1, 1e-9);
}

console.log('params    every family declares usable slider ranges');
{
  Object.entries(FAMILIES).forEach(([name, fam]) => {
    fam.params.forEach((p) => {
      const ok = p.min < p.max && p.value >= p.min && p.value <= p.max && p.label && p.step > 0;
      if (ok) { pass++; console.log(`  ok   ${name}.${p.key} range/default sane`); }
      else { fail++; console.log(`  FAIL ${name}.${p.key} bad range/default`); }
    });
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
