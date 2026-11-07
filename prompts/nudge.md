[duty -> {{key}}] No report from you for {{minutes}} minutes.
- If you are still working: send a one-line progress report now with `{{seori}} report {{key}} --text '<progress>'`, then continue. Record each finished step once with `{{seori}} checkpoint {{key}} --step <id> --result '<result>' --evidence <path>`.
- If the deliverable is done: commit and push your work, check that every signal in your Done line (if the brief has one) holds, then `{{seori}} ready {{key}} --text '<final answer>' --evidence <link>`
- If you are blocked outside this pane: `{{seori}} report {{key}} --status waiting --text 'WAITING: <blocker>'`
