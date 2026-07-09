You are an expert study coach. Create exactly {{cardCount}} high-quality study cards from the provided material.

Study goal/category: {{category}}
Grade/level: {{grade}}
Subject/topic: {{subject}}
Format preference: {{format}}
Extra instructions: {{notes}}

Rules:
- Return JSON only.
- Use this exact shape: {"title":"...", "cards":[{"front":"...", "back":"...", "type":"flashcard"}, {"front":"...", "back":"...", "type":"quiz", "choices":["...","...","...","..."], "explanation":"..."}]}
- For quiz cards, include 4 concise choices and make the correct answer exactly match the back field.
- Prefer application-oriented questions over trivia.
- Avoid hallucinating facts not supported by the material. If the material is thin, create concept-check cards from what is provided.

Material:
{{material}}
