/*
 * Structural checks on the simplified whiteboard toolbar. No browser needed —
 * these guard the invariants that the UI simplification could plausibly break:
 * a tool going missing, the "More" toggle being mistaken for a tool, or the
 * default-collapsed sections drifting out of sync between HTML and JS.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'board.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'board.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'board.css'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('tools survive the restructure');
{
  const tools = (html.match(/data-tool="([a-z]+)"/g) || []).map((m) => m.match(/"([a-z]+)"/)[1]);
  const expected = ['pen', 'shape', 'eraser', 'select', 'text', 'pan', 'move', 'connect', 'laser', 'note'];
  expected.forEach((t) => ok(`${t} still present`, tools.includes(t)));
  ok('no duplicate tool buttons', new Set(tools).size === tools.length,
    `saw ${tools.length}, unique ${new Set(tools).size}`);
  ok('exactly the 10 known tools', tools.length === expected.length, `got ${tools.length}`);
}

console.log('\nprimary vs. secondary split');
{
  const primaryBlock = html.slice(html.indexOf('aria-label="Tools"'), html.indexOf('id="moreTools"'));
  const primary = (primaryBlock.match(/data-tool="([a-z]+)"/g) || []).length;
  ok('primary group holds 5 essential tools', primary === 5, `got ${primary}`);

  const moreBlock = html.slice(html.indexOf('id="moreTools"'));
  const moreEnd = moreBlock.indexOf('</div>');
  const more = (moreBlock.slice(0, moreEnd).match(/data-tool="([a-z]+)"/g) || []).length;
  ok('More group holds the other 5', more === 5, `got ${more}`);
  ok('More group starts hidden', /id="moreTools"[^>]*\shidden/.test(html));
}

console.log('\nthe More toggle is not a tool');
{
  const toggle = html.match(/<button[^>]*id="moreToolsToggle"[^>]*>/);
  ok('toggle exists', !!toggle);
  ok('toggle carries no data-tool', toggle && !/data-tool=/.test(toggle[0]));
  ok('toggle is aria-expanded', toggle && /aria-expanded/.test(toggle[0]));
  ok('click handler ignores buttons without data-tool',
    /if \(!b\.dataset\.tool\) return;/.test(js));
  ok('active state only applied to real tools',
    /\$\$\('\.tool-btn\[data-tool\]'\)/.test(js));
}

console.log('\ndefault-collapsed sections');
{
  ok('Page section starts collapsed', /<section class="tool-section collapsed" data-section="page">/.test(html));
  ok('Page body starts hidden', /id="sec-page" style="display:none"/.test(html));
  ok('Tools section stays open', /<section class="tool-section" data-section="tools">/.test(html));
  ok('Smart AI stays open (Analyze is the core action)',
    /<section class="tool-section" data-section="ai">/.test(html));
  ok('Analyze button still present', /id="analyzeBtn"/.test(html));
}

console.log('\nflowchart mode reveals the tools it needs');
{
  ok('updatePageBar auto-opens More for flowchart pages',
    /isFlow[\s\S]{0,400}moreTools/.test(js));
}

console.log('\ncanvas gains real estate');
{
  const tb = css.match(/\.board-toolbar\s*\{[^}]*flex:\s*0 0 (\d+)px/);
  const ip = css.match(/\.info-panel\s*\{[^}]*flex:\s*0 0 (\d+)px/);
  ok('toolbar narrowed to <= 160px', tb && Number(tb[1]) <= 160, tb && `${tb[1]}px`);
  ok('info panel narrowed to <= 312px', ip && Number(ip[1]) <= 312, ip && `${ip[1]}px`);
  const total = (tb ? Number(tb[1]) : 0) + (ip ? Number(ip[1]) : 0);
  ok('total chrome under the old 530px', total < 530, `${total}px`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
