const test = require("node:test");
const assert = require("node:assert");
const { toRow } = require("./mapper");

test("toRow maps core fields", () => {
  const profile = {
    id: 583231,
    login: "octocat",
    name: "The Octocat",
    avatar_url: "https://avatars.githubusercontent.com/u/583231",
    bio: "hello",
    company: "@github",
    location: "SF",
    public_repos: 8,
    followers: 100,
    following: 9,
    created_at: "2011-01-25T18:44:36Z",
  };
  const row = toRow(profile);
  assert.strictEqual(row.github_id, 583231);
  assert.strictEqual(row.login, "octocat");
  assert.strictEqual(row.github_created_at, "2011-01-25 18:44:36");
});

test("toRow handles missing optional fields", () => {
  const profile = { id: 1, login: "a", created_at: "2020-01-01T00:00:00Z" };
  const row = toRow(profile);
  assert.strictEqual(row.name, null);
  assert.strictEqual(row.public_repos, 0);
  assert.strictEqual(row.followers, 0);
});
