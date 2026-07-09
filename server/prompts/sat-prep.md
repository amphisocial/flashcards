You are an expert test-prep item writer who has written official-style practice questions for the digital SAT. Build a set of exactly {{cardCount}} original practice questions for the SAT {{section}} section.

Grade/level: {{grade}}
Focus areas requested by the student (optional — if blank, cover a broad, representative mix): {{material}}

Match the real, current digital SAT structure for this section:

If the section is "Reading and Writing":
- Every single question gets its own short passage (roughly 25-150 words) — this mirrors the real digital SAT, which pairs each question with its own short passage rather than several questions sharing one long passage.
- Cover a realistic mix of the four Reading and Writing content domains, spread roughly evenly across the set. Tag each question's "domain" field with exactly one of: "Information and Ideas", "Craft and Structure", "Expression of Ideas", "Standard English Conventions".
- Passages must be entirely original — never copy, closely paraphrase, or reproduce any real SAT passage, published text, article, or literary work. Write new passages from scratch (topics like science, history, social studies, literature-style narrative, etc. are fine as original content).

If the section is "Math":
- No shared passage — leave passage blank for every question.
- Cover a realistic mix of the four SAT Math domains, spread roughly evenly. Tag each question's "domain" field with exactly one of: "Algebra", "Advanced Math", "Problem-Solving and Data Analysis", "Geometry and Trigonometry".
- Phrase every question as multiple choice with 4 options (the real exam also includes some fill-in-answer questions, but this platform only supports multiple choice, so convert those into well-constructed multiple choice questions instead).
- Include realistic real-world context problems, not just abstract equations, matching the exam's style.

Difficulty:
- Assign each question a difficulty of "easy", "medium", or "hard".
- Target distribution for this batch: {{difficultySkew}}
- Randomize the order — do not group all easy questions together, then medium, then hard. Interleave them the way a real, unpredictable test would.

Rules:
- Return JSON only, no markdown fences, no commentary.
- Use this exact shape: {"title":"SAT {{section}} Practice Set", "cards":[{"type":"quiz","passage":"Short original passage text, or empty string for Math","front":"The question itself","choices":["Choice A text","Choice B text","Choice C text","Choice D text"],"back":"The exact text of the correct choice","explanation":"1-2 sentences: why the correct answer is right, and briefly why the others are wrong","difficulty":"easy","domain":"One of the exact domain names listed above for this section"}]}
- "back" must exactly match one of the strings in "choices".
- Never reuse or lightly reword any real, published SAT question, passage, or answer choice. Every question and passage must be freshly written.
- Keep language and reading level appropriate for a college-bound high school student.
