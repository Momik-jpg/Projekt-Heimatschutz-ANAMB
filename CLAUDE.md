## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Claude operating rules

Claude should treat this repository as the Heimatschutz Aargau project: a Node.js/Express app with static frontend code for triaging Aargau building applications.

At the start of a new chat, use the `tool-aware-workflow` skill from `.claude/skills/tool-aware-workflow/SKILL.md` as the default checklist for choosing tools before answering.

Default work order:
- Use `tool-aware-workflow` to select the smallest useful local/free tool before answering.
- Use `german-umlauts` whenever writing German text: direct ä/ö/ü, always `ss`, no sharp-s character.
- For codebase questions, start with `graphify query "<question>"` when `graphify-out/graph.json` exists.
- Use Serena for precise code navigation, symbol lookup, references, diagnostics, and memory.
- Use Context7 only for current library, framework, SDK, API, CLI, or cloud documentation.
- Use Playwright MCP and Chrome DevTools MCP for UI checks, screenshots, browser behaviour, console errors, network issues, and performance checks.
- Use the installed design skills for UI work: `frontend-design`, `impeccable`, `design-taste-frontend`, `emil-design-eng`, `ui-ux-pro-max`, `high-end-visual-design`, `redesign-existing-projects`, and `minimalist-ui`.
- Keep changes minimal and project-native. Do not rewrite unrelated files or revert user changes.
- After code changes, run the narrowest useful tests first, usually `npm test`, then run scans when security or release confidence matters.
- After modifying code, run `graphify update .`.

No-cost rule:
- Do not set up or use paid/API-key tools unless Andrin explicitly asks. Skip Firecrawl, Perplexity, Glif, image-generation API workflows, or other metered cloud tools by default.
- Prefer local/free tools already installed on this machine.

Important commands:
- Open tool menu: `C:\Users\Andrin\OneDrive - Alte Kantonsschule Aarau\Desktop\AI-Code-Tools\Start-All-Tools.cmd`
- Preview desktop cleanup: `C:\Users\Andrin\OneDrive - Alte Kantonsschule Aarau\Desktop\AI-Code-Tools\Clean-Desktop-Preview.cmd`
- Clean desktop safely: `C:\Users\Andrin\OneDrive - Alte Kantonsschule Aarau\Desktop\AI-Code-Tools\Clean-Desktop.cmd`
- Quick security/quality scan: `C:\Users\Andrin\OneDrive - Alte Kantonsschule Aarau\Desktop\AI-Code-Tools\Run-All-Scans.cmd`
- Deep scan with CodeQL: `C:\Users\Andrin\OneDrive - Alte Kantonsschule Aarau\Desktop\AI-Code-Tools\Run-All-Scans-With-CodeQL.cmd`
- Start app: `npm start`
- Dev mode: `npm run dev`
- Tests: `npm test`
