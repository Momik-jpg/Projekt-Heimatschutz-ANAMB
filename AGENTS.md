## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## tool-aware-workflow

This project includes a meta skill at `.agents/skills/tool-aware-workflow/SKILL.md` and `.claude/skills/tool-aware-workflow/SKILL.md`.

Use it at the start of a new chat, and whenever the user asks about the project, tools, code, setup, debugging, UI/UX, browser testing, docs, security, scans, cleanup, or how Codex/Claude should work.

Core rule: inform yourself with the smallest useful local/free tool before answering. Prefer Graphify, Serena, Context7, Playwright MCP, Chrome DevTools MCP, installed design skills, and local scanners. Do not use paid/API-key tools unless Andrin explicitly asks.

Use the global `tool-router` skill for non-trivial work to choose the right local/free tools. Minimum rule: use at least one relevant local tool before answering or editing, and use a separate verification tool after risky, user-facing, or code-changing work.

No API-key mode: `agent-browser` is local-only. Do not use `agent-browser chat`, Dashboard AI, Vercel Sandbox, AWS AgentCore, Browserbase, Browser Use, Browserless, Kernel, or other cloud/API-key provider features unless Andrin explicitly asks and provides credentials.

## german-umlauts

Use `.agents/skills/german-umlauts/SKILL.md` and `.claude/skills/german-umlauts/SKILL.md` whenever writing or polishing German text for Andrin. Write Swiss-style German: use ä/ö/ü directly when ae/oe/ue clearly means an umlaut, and always use `ss` instead of the German sharp-s character. Do not rewrite code identifiers, commands, URLs, paths, package names, env vars, exact quotes, or literal data unless explicitly asked.

<!-- context7 -->
Use Context7 MCP to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Steps

1. Always start with `resolve-library-id` using the library name and the user's question, unless the user provides an exact library ID in `/org/project` format
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question). Use version-specific IDs when the user mentions a version
3. `query-docs` with the selected library ID and the user's full question (not single words)
4. Answer using the fetched docs
<!-- context7 -->
