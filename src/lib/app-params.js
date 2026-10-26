/**
 * Local stand-in for Base44's app parameters.
 *
 * The hosted app read an appId and bearer token injected at build time. Locally
 * there is no platform origin and no token — the client talks to a server on
 * this machine.
 */
export const appParams = {
  appId: 'cryptomate-local',
  token: null,
  functionsVersion: 'local',
  serverUrl: '',
};

export default appParams;
