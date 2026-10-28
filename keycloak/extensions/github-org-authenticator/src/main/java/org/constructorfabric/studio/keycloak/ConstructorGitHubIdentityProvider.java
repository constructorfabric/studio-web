package org.constructorfabric.studio.keycloak;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

import org.jboss.logging.Logger;
import org.keycloak.broker.oidc.OAuth2IdentityProviderConfig;
import org.keycloak.broker.provider.BrokeredIdentityContext;
import org.keycloak.broker.provider.IdentityBrokerException;
import org.keycloak.models.KeycloakSession;
import org.keycloak.social.github.GitHubIdentityProvider;

public final class ConstructorGitHubIdentityProvider extends GitHubIdentityProvider {
    static final String ORGANIZATION_CONFIG = "organization";
    static final String DEFAULT_ORGANIZATION = "constructorfabric";
    // Off only when set to "false": no installation opens by accident (ADR-0051).
    static final String REQUIRE_ORGANIZATION_CONFIG = "requireOrganization";
    private static final String DEFAULT_API_URL = "https://api.github.com";
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(5);
    private static final Logger LOG = Logger.getLogger(ConstructorGitHubIdentityProvider.class);

    private final HttpClient httpClient;

    public ConstructorGitHubIdentityProvider(KeycloakSession session, OAuth2IdentityProviderConfig config) {
        this(session, config, HttpClient.newBuilder()
                .connectTimeout(REQUEST_TIMEOUT)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build());
    }

    ConstructorGitHubIdentityProvider(KeycloakSession session,
                                      OAuth2IdentityProviderConfig config,
                                      HttpClient httpClient) {
        super(session, config);
        this.httpClient = httpClient;
    }

    @Override
    protected BrokeredIdentityContext doGetFederatedIdentity(String accessToken) {
        BrokeredIdentityContext identity = super.doGetFederatedIdentity(accessToken);
        requireMembership(identity.getUsername(), accessToken);
        return identity;
    }

    void requireMembership(String username, String accessToken) {
        if (!requiresOrganization()) {
            return;
        }
        String organization = getConfig().getConfig()
                .getOrDefault(ORGANIZATION_CONFIG, DEFAULT_ORGANIZATION).trim();
        String apiUrl = getConfig().getConfig().getOrDefault("apiUrl", DEFAULT_API_URL).trim();

        // A mistyped organization must not mean "everybody".
        if (organization.isBlank()) {
            throw new IdentityBrokerException("GitHub organization membership validation is not configured");
        }

        try {
            HttpResponse<String> response = checkMembership(apiUrl, organization, accessToken);
            if (!GitHubMembershipResponse.isActive(response.statusCode(), response.body())) {
                LOG.warnf("Denied GitHub login for %s: organization=%s status=%d",
                        username, organization, response.statusCode());
                throw new IdentityBrokerException(
                        "Access is restricted to active members of the GitHub organization " + organization);
            }
        } catch (IOException e) {
            LOG.warn("GitHub membership API request failed", e);
            throw new IdentityBrokerException("GitHub organization membership could not be verified", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IdentityBrokerException("GitHub organization membership could not be verified", e);
        }
    }

    private boolean requiresOrganization() {
        String value = getConfig().getConfig().get(REQUIRE_ORGANIZATION_CONFIG);
        return value == null || !"false".equalsIgnoreCase(value.trim());
    }

    private HttpResponse<String> checkMembership(String apiUrl, String organization, String token)
            throws IOException, InterruptedException {
        String normalizedApiUrl = apiUrl.endsWith("/") ? apiUrl.substring(0, apiUrl.length() - 1) : apiUrl;
        String encodedOrganization = URLEncoder.encode(organization, StandardCharsets.UTF_8).replace("+", "%20");
        HttpRequest request = HttpRequest.newBuilder(
                        URI.create(normalizedApiUrl + "/user/memberships/orgs/" + encodedOrganization))
                .timeout(REQUEST_TIMEOUT)
                .header("Accept", "application/vnd.github+json")
                .header("Authorization", "Bearer " + token)
                .header("X-GitHub-Api-Version", "2026-03-10")
                .GET()
                .build();
        return httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }
}
