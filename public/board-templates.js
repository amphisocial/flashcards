/*
 * board-templates.js — the catalog of "start from a template" boards.
 *
 * Used in two places (single source of truth):
 *   - the client template picker (served to the browser), and
 *   - the server, which seeds a new board's first page from the chosen
 *     template so the teacher lands on a canvas that already has the relevant
 *     equation / prompt on it plus an instruction to hit Analyze.
 *
 * Each template maps to capabilities the app already has (the graph plotter,
 * the physics sims, molecules, the globe). Seeding writes a text object onto
 * page 1 — the equation or a label — and an instruction note; the teacher then
 * taps Analyze / Analyze Live to get the live graph or 3D model, exactly as
 * the concept pages describe.
 */

const BOARD_TEMPLATES = [
  // ---- Math ----
  {
    id: 'quadratic', subject: 'Math', name: 'Quadratic equation',
    standard: 'Common Core 8.F / A-REI',
    blurb: 'y = ax² + bx + c on the board. Hit Analyze to graph it, then drag a, b, c.',
    seed: { equation: 'y = a x^2 + b x + c',
      instruction: 'Click Analyze (or Analyze Live) to graph this. Then drag the a, b and c sliders and watch the parabola change.' }
  },
  {
    id: 'linear', subject: 'Math', name: 'Straight line (slope-intercept)',
    standard: 'Common Core 8.F',
    blurb: 'y = mx + b. Analyze to plot it; sliders for slope and intercept.',
    seed: { equation: 'y = m x + b',
      instruction: 'Click Analyze to plot this line. Drag the slope (m) and intercept (b) sliders to see how each changes the line.' }
  },
  {
    id: 'solid', subject: 'Math', name: '3D solid (surface area & volume)',
    standard: 'Common Core 6.G / 7.G',
    blurb: 'Sketch or label a cube/prism/cylinder. Analyze for a rotatable 3D model with formulas.',
    seed: { label: 'Cube with side a = 4 cm',
      instruction: 'Draw or keep this label, then click Analyze to get a rotatable 3D solid with its surface-area and volume formulas.' }
  },

  // ---- Science ----
  {
    id: 'newton', subject: 'Science', name: "Newton's laws (free fall)",
    standard: 'NGSS MS-PS2-2',
    blurb: 'Drop a feather and a stone in real gravity. Analyze to run the simulation.',
    seed: { label: 'Free fall: feather vs stone. F = m·g',
      instruction: 'Click Analyze to launch the free-fall simulation. Toggle air resistance and switch to Moon gravity to compare.' }
  },
  {
    id: 'incline', subject: 'Science', name: 'Block on a wedge',
    standard: 'NGSS MS-PS2-2',
    blurb: 'A block on a ramp. Analyze to run it; change angle, friction and mass.',
    seed: { label: 'Block on an incline: a = g(sinθ − μcosθ)',
      instruction: 'Click Analyze to run the inclined-plane simulation. Change the angle, friction (μ) and mass — note the slide point does not depend on mass.' }
  },
  {
    id: 'reflection', subject: 'Science', name: 'Laws of reflection',
    standard: 'NGSS MS-PS4-2',
    blurb: 'Rays on flat, concave and convex mirrors. Analyze to see them converge.',
    seed: { label: 'Reflection: angle of incidence = angle of reflection',
      instruction: 'Click Analyze to send parallel rays at the mirrors. Adjust curvature and find the focus (f = R/2 for a concave mirror).' }
  },
  {
    id: 'molecule', subject: 'Science', name: '3D molecule',
    standard: 'NGSS MS-PS1',
    blurb: 'Name or draw a compound. Analyze for a rotatable model; click an atom for its shells.',
    seed: { label: 'Molecule: CH₃COOH (acetic acid)',
      instruction: 'Click Analyze to build the 3D molecule. Rotate it, then click any atom to zoom into its electron shells.' }
  },
  {
    id: 'pendulum', subject: 'Science', name: 'Pendulum',
    standard: 'NGSS MS-PS2 / MS-PS3',
    blurb: 'A swinging pendulum. Analyze to run it; change length and gravity.',
    seed: { label: 'Pendulum: T = 2π√(L/g)',
      instruction: 'Click Analyze to run the pendulum. Change the length and gravity — notice the period does not depend on mass or (small) amplitude.' }
  },

  // ---- Geography ----
  {
    id: 'globe', subject: 'Geography', name: 'Teaching globe',
    standard: 'Geography 5–9',
    blurb: 'A rotatable Earth. Analyze to build it; borders, capitals, rivers, tropics.',
    seed: { label: 'Earth',
      instruction: 'Click Analyze to build a rotatable teaching globe. Zoom in to reveal country and capital labels; toggle satellite / political maps.' }
  },

  // ---- History / study ----
  {
    id: 'blank-notes', subject: 'History', name: 'Blank board + notes',
    standard: 'US History 5–9',
    blurb: 'A blank board. Write a timeline or key terms, then Analyze for organized notes.',
    seed: { label: '',
      instruction: 'Write your timeline, dates or key terms, then click Analyze for a worked, organized explanation you can push to students.' }
  },

  // ---- Freeform ----
  {
    id: 'blank', subject: 'Freeform', name: 'Blank whiteboard',
    standard: '',
    blurb: 'Start from an empty board.',
    seed: null
  }
];

// Group by subject for the picker UI (order preserved).
function templatesBySubject() {
  const groups = {};
  for (const t of BOARD_TEMPLATES) {
    (groups[t.subject] ||= []).push(t);
  }
  return groups;
}

function findTemplate(id) {
  return BOARD_TEMPLATES.find((t) => t.id === id) || null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BOARD_TEMPLATES, templatesBySubject, findTemplate };
}
if (typeof window !== 'undefined') {
  window.BOARD_TEMPLATES = BOARD_TEMPLATES;
}
