// Data-only cleanup: drop providerConnections rows for the removed devin-cli
// subprocess provider (noAuth — rows never held credentials). The new `devin`
// OAuth provider is a separate identity and must not inherit stale rows.
export default {
  version: 2,
  name: "remove-devin-cli-connections",
  up(db) {
    db.exec("DELETE FROM providerConnections WHERE provider = 'devin-cli'");
  },
};
