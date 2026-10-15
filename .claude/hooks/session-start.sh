#!/usr/bin/env bash
# Installs this repo's dependencies at the start of a Claude Code cloud session.
# Does nothing on your own machine (CLAUDE_CODE_REMOTE is only "true" in the cloud).
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

if [ -f pnpm-lock.yaml ] || [ -f pnpm-workspace.yaml ]; then
  command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10 >/dev/null 2>&1
  pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 \
    || echo "session-start: pnpm install failed — run it manually" >&2
elif [ -f package-lock.json ]; then
  npm ci >/dev/null 2>&1 || echo "session-start: npm ci failed" >&2
fi

if ls ./*.slnx ./*.sln >/dev/null 2>&1; then
  if command -v dotnet >/dev/null 2>&1; then
    dotnet restore --nologo -v q >/dev/null 2>&1 || echo "session-start: dotnet restore failed" >&2
  else
    echo "session-start: .NET SDK missing — add the Sirb setup script to this cloud environment" >&2
  fi
fi

# Printed text is added to Claude's context.
echo "Sirb repo ready. Shared rules: CLAUDE.md. Specialist agents: .claude/agents/. Requirements: sirb-spec/docs/requirements.md."
exit 0
