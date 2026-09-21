# Documentation

Start with these. They describe the system as it is now:

- [architecture.md](architecture.md): components, round lifecycle, data model, sandbox and provider abstractions
- [operator-guide.md](operator-guide.md): running real and Docker modes, isolation policies, CLI flags, container sizing
- [api-reference.md](api-reference.md): the dashboard's REST and WebSocket API

## Design history

The rest of this folder is the project's engineering record. Each file is dated and describes the code as planned or measured on that date. Later phases supersede earlier ones, so use the three documents above for current behaviour.

The project was built phase by phase with an AI-assisted workflow ([Superpowers](https://github.com/obra/superpowers) for Claude Code). Each phase started from a written design spec. It was then implemented from a task-by-task plan, with tests written first and a review after each task. Those artifacts are kept here because they record why the code is shaped the way it is.

- [`superpowers/specs/`](superpowers/specs/): design specs for each phase, plus verified-facts records. Examples: the [OpenCode API spike](superpowers/specs/2026-08-24-opencode-api-spike.md), the [protected runtime's verified boundaries](superpowers/specs/2026-09-15-protected-runtime-verified-facts.md), and the [container sizing benchmark](superpowers/specs/2026-09-16-container-sizing-benchmark.md).
- [`superpowers/plans/`](superpowers/plans/): step-by-step implementation plans. These are long, because each one spells out the tests and code for every task.
- [`reviews/`](reviews/): a structured code review of an earlier snapshot and the tickets it produced.
