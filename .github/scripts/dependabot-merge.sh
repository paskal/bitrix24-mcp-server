#!/usr/bin/env bash
# Merges open Dependabot pull requests that are mergeable, whose head commit
# passed both ci jobs with no failing or pending check, and whose updated npm
# releases were published at least MIN_RELEASE_AGE_DAYS ago. Version updates
# already wait out the cooldown in dependabot.yml before they are proposed, so
# the release-age check holds back only security updates, which Dependabot
# raises without a cooldown. DRY_RUN=1 reports without merging.
set -euo pipefail

min_age_days=${MIN_RELEASE_AGE_DAYS:-3}
cutoff=$(( $(date -u +%s) - min_age_days * 86400 ))

# prints "name version" for each item of the updated-dependencies block in a
# Dependabot commit body; values may be YAML-quoted, as scoped names always are.
# An item without a version prints "missing", which fails the release-age check.
updated_deps() {
  awk '
    function unquote(v) { gsub(/^["\047]|["\047]$/, "", v); return v }
    function emit() {
      if (name != "") print name, (ver != "" ? ver : "missing")
      name = ""; ver = ""
    }
    /^updated-dependencies:/ { inblock = 1; next }
    !inblock { next }
    /^\.\.\.$/ { emit(); inblock = 0; next }
    /^- / { emit() }
    /^(- |  )dependency-name: / { name = unquote($NF) }
    /^(- |  )dependency-version: / { ver = unquote($NF) }
    END { emit() }
  '
}

# succeeds when at least one release is listed and every one is older than the cutoff
releases_aged() {
  local name ver published count=0
  while read -r name ver; do
    [ -n "$name" ] || continue
    count=$((count + 1))
    published=$(curl -fsS "https://registry.npmjs.org/${name/\//%2F}" \
      | jq -r --arg v "$ver" '.time[$v] // empty | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601') || return 1
    if [ -z "$published" ] || [ "$published" -gt "$cutoff" ]; then
      echo "  $name $ver published too recently or not found"
      return 1
    fi
  done
  if [ "$count" -eq 0 ]; then
    echo "  no updated dependencies found in the commit message"
    return 1
  fi
}

for n in $(gh pr list --author app/dependabot --state open --limit 200 --json number -q '.[].number'); do
  # GitHub computes mergeability lazily and reports UNKNOWN for a while after
  # master moves, which every merge in this loop does
  for _ in 1 2 3 4 5 6; do
    pr=$(gh pr view "$n" --json mergeable,headRefName,headRefOid,commits,statusCheckRollup)
    [ "$(jq -r .mergeable <<<"$pr")" = UNKNOWN ] || break
    sleep 10
  done
  sha=$(jq -r '
      def passed($name): any(.statusCheckRollup[];
        .workflowName == "ci" and .name == $name and .conclusion == "SUCCESS");
      select(.mergeable == "MERGEABLE")
      | select(passed("test (24)") and passed("test (26)"))
      | select(all(.statusCheckRollup[];
          ((.conclusion // .state) | IN("SUCCESS", "SKIPPED", "NEUTRAL"))))
      | .headRefOid' <<<"$pr")
  if [ -z "$sha" ]; then
    echo "#$n not ready: not mergeable or ci has not passed"
    continue
  fi
  case $(jq -r .headRefName <<<"$pr") in
    dependabot/npm_and_yarn/*)
      if ! jq -r '.commits[-1].messageBody' <<<"$pr" | updated_deps | releases_aged; then
        echo "#$n not ready: release age"
        continue
      fi
      ;;
  esac
  if [ "${DRY_RUN:-}" = 1 ]; then
    echo "#$n would merge at $sha"
    continue
  fi
  echo "merging #$n at $sha"
  gh pr merge "$n" --squash --delete-branch --match-head-commit "$sha" \
    || echo "::warning::merge of #$n failed"
done
