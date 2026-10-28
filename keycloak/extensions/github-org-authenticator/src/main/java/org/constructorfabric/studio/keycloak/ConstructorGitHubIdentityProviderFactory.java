package org.constructorfabric.studio.keycloak;

import java.util.ArrayList;
import java.util.List;

import org.keycloak.broker.oidc.OAuth2IdentityProviderConfig;
import org.keycloak.models.IdentityProviderModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.provider.ProviderConfigProperty;
import org.keycloak.social.github.GitHubIdentityProviderFactory;

public final class ConstructorGitHubIdentityProviderFactory extends GitHubIdentityProviderFactory {
    public static final String PROVIDER_ID = "constructor-github";

    @Override
    public String getName() {
        return "GitHub (constructorfabric members)";
    }

    @Override
    public ConstructorGitHubIdentityProvider create(KeycloakSession session,
                                                     IdentityProviderModel model) {
        return new ConstructorGitHubIdentityProvider(session, new OAuth2IdentityProviderConfig(model));
    }

    @Override
    public String getId() {
        return PROVIDER_ID;
    }

    @Override
    public List<ProviderConfigProperty> getConfigProperties() {
        List<ProviderConfigProperty> properties = new ArrayList<>(super.getConfigProperties());
        ProviderConfigProperty requireOrganization = new ProviderConfigProperty();
        requireOrganization.setName(ConstructorGitHubIdentityProvider.REQUIRE_ORGANIZATION_CONFIG);
        requireOrganization.setLabel("Require GitHub organization membership");
        requireOrganization.setHelpText(
                "When off, any GitHub account may sign in and the organization below is not checked.");
        requireOrganization.setType(ProviderConfigProperty.BOOLEAN_TYPE);
        requireOrganization.setDefaultValue(true);
        properties.add(requireOrganization);
        ProviderConfigProperty organization = new ProviderConfigProperty();
        organization.setName(ConstructorGitHubIdentityProvider.ORGANIZATION_CONFIG);
        organization.setLabel("Required GitHub organization");
        organization.setHelpText("Only active members of this GitHub organization may sign in.");
        organization.setType(ProviderConfigProperty.STRING_TYPE);
        organization.setDefaultValue(ConstructorGitHubIdentityProvider.DEFAULT_ORGANIZATION);
        properties.add(organization);
        return properties;
    }
}
