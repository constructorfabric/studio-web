package org.constructorfabric.studio.keycloak;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.keycloak.broker.oidc.OAuth2IdentityProviderConfig;
import org.keycloak.broker.provider.IdentityBrokerException;
import org.keycloak.models.IdentityProviderModel;

// A local stand-in for the GitHub API: it records each path asked for and
// answers with the membership state the test sets.
class ConstructorGitHubIdentityProviderTest {
    private final List<String> requests = new CopyOnWriteArrayList<>();
    private HttpServer github;
    private volatile int status;
    private volatile String body;

    @BeforeEach
    void startGitHub() throws IOException {
        github = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        github.createContext("/", exchange -> {
            requests.add(exchange.getRequestURI().getPath());
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        github.start();
    }

    @AfterEach
    void stopGitHub() {
        github.stop(0);
    }

    @Test
    void checksConstructorfabricWhenNothingIsSet() {
        answer(200, "{\"state\":\"active\"}");
        assertDoesNotThrow(() -> provider(null, null).requireMembership("member", "token"));
        assertEquals(List.of("/user/memberships/orgs/constructorfabric"), requests);

        answer(404, "{}");
        assertThrows(IdentityBrokerException.class,
                () -> provider(null, null).requireMembership("stranger", "token"));
    }

    @Test
    void anythingButFalseKeepsTheCheck() {
        answer(404, "{}");
        for (String value : List.of("true", "TRUE", "", "yes")) {
            assertThrows(IdentityBrokerException.class,
                    () -> provider(value, "constructorfabric").requireMembership("stranger", "token"));
        }
        assertEquals(4, requests.size());
    }

    @Test
    void falseAdmitsAnyGitHubAccountWithoutAskingGitHub() {
        answer(404, "{}");
        assertDoesNotThrow(() -> provider("false", "constructorfabric").requireMembership("anybody", "token"));
        assertDoesNotThrow(() -> provider(" False ", "").requireMembership("anybody", "token"));
        assertEquals(List.of(), requests);
    }

    @Test
    void aBlankOrganizationWithTheCheckOnIsAnError() {
        answer(200, "{\"state\":\"active\"}");
        assertThrows(IdentityBrokerException.class,
                () -> provider("true", "  ").requireMembership("member", "token"));
        assertThrows(IdentityBrokerException.class,
                () -> provider(null, "").requireMembership("member", "token"));
        assertEquals(List.of(), requests);
    }

    private void answer(int status, String body) {
        this.status = status;
        this.body = body;
    }

    private ConstructorGitHubIdentityProvider provider(String requireOrganization, String organization) {
        IdentityProviderModel model = new IdentityProviderModel();
        model.getConfig().put("apiUrl", "http://127.0.0.1:" + github.getAddress().getPort() + "/");
        if (requireOrganization != null) {
            model.getConfig().put(ConstructorGitHubIdentityProvider.REQUIRE_ORGANIZATION_CONFIG, requireOrganization);
        }
        if (organization != null) {
            model.getConfig().put(ConstructorGitHubIdentityProvider.ORGANIZATION_CONFIG, organization);
        }
        return new ConstructorGitHubIdentityProvider(null, new OAuth2IdentityProviderConfig(model),
                HttpClient.newHttpClient());
    }
}
