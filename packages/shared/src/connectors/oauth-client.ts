/** Direct modules preserving the existing connector and specialized mission profile contracts and implementations. */
export type { ConnectorOAuthProvider, ConnectorOAuthScopeMapping, ConnectorOAuthProfile, ConnectorOAuthFlow, ConnectorOAuthTokenSet, ConnectorOAuthHttpRequest, ConnectorOAuthHttpResponse, ConnectorOAuthTransport } from './oauth-client/contracts.ts';
export { ConnectorOAuthError } from './oauth-client/contracts.ts';
export { createConnectorOAuthProfile } from './oauth-client/profiles.ts';
export { prepareConnectorOAuthFlow, exchangeConnectorOAuthCode, refreshConnectorOAuthToken, createConnectorSecretLeaseFromOAuth, fetchConnectorOAuthTransport } from './oauth-client/oauth-flow.ts';
