#!/usr/bin/env bash
# Cuts a release: sets the version, commits, tags, and pushes. The release
# workflow (.github/workflows/release.yml) then builds and publishes it. For
# the app it also builds build/g2-claude-X.Y.Z.ehpk and
# build/g2-claude-X.Y.Z-notes.txt (the CHANGELOG entry as plain text), ready
# to upload to Even Hub.
#
#   scripts/release.sh app 0.3.6       glasses app (apps/glasses/app.json)
#   scripts/release.sh plugin 0.3.4    Claude Code plugin (plugin.json; rebuilds the bundle)
set -euo pipefail
cd "$(dirname "$0")/.."

kind="${1:-}"; version="${2:-}"
[[ "$kind" =~ ^(app|plugin)$ && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: scripts/release.sh app|plugin X.Y.Z" >&2; exit 1; }
tag="$kind-v$version"
file=$([ "$kind" = app ] && echo apps/glasses/app.json || echo plugin/.claude-plugin/plugin.json)

[ "$(git branch --show-current)" = main ] || { echo "release from main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "$tag already exists" >&2; exit 1; }
command -v jq >/dev/null || { echo "missing: jq" >&2; exit 1; }
label=$([ "$kind" = app ] && echo App || echo Plugin)
grep -qx "## $label $version" CHANGELOG.md || { echo "add a \"## $label $version\" entry to CHANGELOG.md first" >&2; exit 1; }

current=$(jq -r .version "$file")
if [ "$current" != "$version" ]; then
  tmp=$(mktemp)
  jq --indent 2 --arg v "$version" '.version = $v' "$file" > "$tmp" && mv "$tmp" "$file"
fi
if [ "$kind" = plugin ]; then
  bun run build:plugin >/dev/null
  (cd channel && bun test >/dev/null) || { echo "channel tests failed" >&2; exit 1; }
else
  (cd apps/glasses && bunx tsc --noEmit && bun test --path-ignore-patterns 'test/sim.e2e.test.ts' >/dev/null) || { echo "app checks failed" >&2; exit 1; }
fi

if [ -n "$(git status --porcelain)" ]; then
  git add -A "$file" plugin/dist
  git commit -q -m "release: $kind v$version"
fi
git tag -a "$tag" -m "$kind v$version"
git push -q origin main "$tag"
echo "pushed $tag: the release workflow builds and publishes it"

# The upload-ready package and its Even Hub notes, built from the same commit as the release.
if [ "$kind" = app ]; then
  (cd apps/glasses && bun run pack:bundled >/dev/null)
  cp build/g2-claude-bundled.ehpk "build/g2-claude-$version.ehpk"
  bun scripts/changelog.ts app "$version" > "build/g2-claude-$version-notes.txt"
  echo
  echo "Even Hub upload: build/g2-claude-$version.ehpk"
  echo "Release notes:   build/g2-claude-$version-notes.txt"
  echo
  cat "build/g2-claude-$version-notes.txt"
fi
