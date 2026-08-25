// Commit-message functions for @changesets/cli v3 (`commit: ["./commits.mjs", null]`).
// Keeps generated release commits in the repo's lowercase conventional style
// (see CONTRIBUTING.md → Commit style): `chore: release @mbsks/openrtc-core@0.2.0, ...`
export async function getAddMessage() {
  return "chore: add changeset";
}

export async function getVersionMessage(releasePlan) {
  const releases = Array.isArray(releasePlan) ? releasePlan : releasePlan.releases;
  const summary = releases.map((r) => `${r.name}@${r.newVersion}`).join(", ");
  return `chore: release ${summary}`;
}
