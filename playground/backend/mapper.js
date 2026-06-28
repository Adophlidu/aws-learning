function toRow(profile) {
  const created = profile.created_at;
  const githubCreatedAt = created
    ? created.replace("T", " ").replace("Z", "")
    : null;
  return {
    github_id: profile.id,
    login: profile.login,
    name: profile.name ?? null,
    avatar_url: profile.avatar_url ?? null,
    bio: profile.bio ?? null,
    company: profile.company ?? null,
    location: profile.location ?? null,
    public_repos: profile.public_repos ?? 0,
    followers: profile.followers ?? 0,
    following: profile.following ?? 0,
    github_created_at: githubCreatedAt,
  };
}

module.exports = { toRow };
