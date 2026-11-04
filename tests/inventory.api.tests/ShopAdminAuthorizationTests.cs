using System.Net;
using System.Net.Http.Json;
using CineBoutique.Inventory.Api.Models;
using CineBoutique.Inventory.Api.Tests.Fixtures;
using CineBoutique.Inventory.Api.Tests.Helpers;
using FluentAssertions;

namespace CineBoutique.Inventory.Api.Tests;

/// <summary>
/// Les actions d'administration (réinitialisation, zones, utilisateurs, boutiques, catalogue) exigent un administrateur
/// réel de la boutique, vérifié en base. Avant novembre 2026, deux en-têtes quelconques (X-Operator-Id / X-Operator-Name)
/// suffisaient pour effacer les comptages d'une boutique ; l'en-tête X-Admin, envoyé par le navigateur, ne prouve rien.
/// </summary>
[Collection("api-tests")]
public sealed class ShopAdminAuthorizationTests : IntegrationTestBase
{
    public ShopAdminAuthorizationTests(InventoryApiFixture fx) { UseFixture(fx); }

    [SkippableFact]
    public async Task Reset_IsRefused_WithAnInventedOperator_EvenWithTheAdminHeader()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");
        var seeded = await SeedAsync().ConfigureAwait(false);
        var client = Fixture.CreateClientWithShopAdminVerification();

        var response = await SendAsync(client, HttpMethod.Post, $"/api/shops/{seeded.ShopId}/inventories/reset", Guid.NewGuid(), "Inconnu").ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.Forbidden, "opérateur inventé").ConfigureAwait(false);
    }

    [SkippableFact]
    public async Task Reset_IsRefused_ForANonAdminUser()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");
        var seeded = await SeedAsync().ConfigureAwait(false);
        var client = Fixture.CreateClientWithShopAdminVerification();

        var response = await SendAsync(client, HttpMethod.Post, $"/api/shops/{seeded.ShopId}/inventories/reset", seeded.CounterId, "Compteur").ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.Forbidden, "utilisateur non administrateur").ConfigureAwait(false);
    }

    [SkippableFact]
    public async Task Reset_IsRefused_ForTheAdminOfAnotherShop()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");
        var seeded = await SeedAsync().ConfigureAwait(false);
        var client = Fixture.CreateClientWithShopAdminVerification();

        var response = await SendAsync(client, HttpMethod.Post, $"/api/shops/{seeded.ShopId}/inventories/reset", seeded.OtherShopAdminId, "Admin ailleurs").ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.Forbidden, "administrateur d'une autre boutique").ConfigureAwait(false);
    }

    [SkippableFact]
    public async Task Reset_IsAllowed_ForTheShopAdmin()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");
        var seeded = await SeedAsync().ConfigureAwait(false);
        var client = Fixture.CreateClientWithShopAdminVerification();

        var response = await SendAsync(client, HttpMethod.Post, $"/api/shops/{seeded.ShopId}/inventories/reset", seeded.AdminId, "Admin").ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.OK, "administrateur de la boutique").ConfigureAwait(false);
    }

    [SkippableFact]
    public async Task DisablingAZone_RequiresTheShopAdmin()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");
        var seeded = await SeedAsync().ConfigureAwait(false);
        var client = Fixture.CreateClientWithShopAdminVerification();
        var uri = $"/api/locations/{seeded.LocationId}?shopId={seeded.ShopId}";

        var refused = await SendAsync(client, HttpMethod.Delete, uri, seeded.CounterId, "Compteur").ConfigureAwait(false);
        await refused.ShouldBeAsync(HttpStatusCode.Forbidden, "non administrateur").ConfigureAwait(false);

        var allowed = await SendAsync(client, HttpMethod.Delete, uri, seeded.AdminId, "Admin").ConfigureAwait(false);
        await allowed.ShouldBeAsync(HttpStatusCode.OK, "administrateur de la boutique").ConfigureAwait(false);
    }

    [SkippableFact]
    public async Task ANonAdmin_CannotCreateAnAdminUser()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");
        var seeded = await SeedAsync().ConfigureAwait(false);
        var client = Fixture.CreateClientWithShopAdminVerification();

        var response = await SendAsync(
            client,
            HttpMethod.Post,
            $"/api/shops/{seeded.ShopId}/users",
            seeded.CounterId,
            "Compteur",
            body: new CreateShopUserRequest { Login = "intrus", DisplayName = "Intrus", IsAdmin = true }).ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.Forbidden, "création d'un admin par un non-admin").ConfigureAwait(false);
    }

    [SkippableFact]
    public async Task UpdatingTheShop_RequiresAnAdminOfTheOperatorShop()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");
        var seeded = await SeedAsync().ConfigureAwait(false);
        var client = Fixture.CreateClientWithShopAdminVerification();
        var body = new UpdateShopRequest { Id = seeded.ShopId, Name = "Boutique Droits", OfficeCode = "MTP" };

        var refused = await SendAsync(client, HttpMethod.Put, "/api/shops", seeded.CounterId, "Compteur", seeded.ShopId, body).ConfigureAwait(false);
        await refused.ShouldBeAsync(HttpStatusCode.Forbidden, "non administrateur").ConfigureAwait(false);

        var allowed = await SendAsync(client, HttpMethod.Put, "/api/shops", seeded.AdminId, "Admin", seeded.ShopId, body).ConfigureAwait(false);
        await allowed.ShouldBeAsync(HttpStatusCode.OK, "administrateur de la boutique").ConfigureAwait(false);
    }

    [SkippableFact]
    public async Task Counting_RemainsOpenToNonAdminUsers()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");
        var seeded = await SeedAsync().ConfigureAwait(false);
        var client = Fixture.CreateClientWithShopAdminVerification();

        var response = await SendAsync(
            client,
            HttpMethod.Post,
            $"/api/inventories/{seeded.LocationId}/start",
            seeded.CounterId,
            "Compteur",
            body: new StartRunRequest(seeded.ShopId, seeded.CounterId, 1)).ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.OK, "un compteur doit pouvoir démarrer un comptage").ConfigureAwait(false);
    }

    private async Task<(Guid ShopId, Guid AdminId, Guid CounterId, Guid OtherShopAdminId, Guid LocationId)> SeedAsync()
    {
        (Guid ShopId, Guid AdminId, Guid CounterId, Guid OtherShopAdminId, Guid LocationId) seeded = default;

        await Fixture.ResetAndSeedAsync(async seeder =>
        {
            var shopId = await seeder.CreateShopAsync("Boutique Droits").ConfigureAwait(false);
            var otherShopId = await seeder.CreateShopAsync("Boutique Voisine").ConfigureAwait(false);
            var adminId = await seeder.CreateShopUserAsync(shopId, "admin", "Admin", isAdmin: true).ConfigureAwait(false);
            var counterId = await seeder.CreateShopUserAsync(shopId, "compteur", "Compteur").ConfigureAwait(false);
            var otherAdminId = await seeder.CreateShopUserAsync(otherShopId, "admin-voisin", "Admin voisin", isAdmin: true).ConfigureAwait(false);
            var locationId = await seeder.CreateLocationAsync(shopId, "D01", "Zone droits").ConfigureAwait(false);
            seeded = (shopId, adminId, counterId, otherAdminId, locationId);
        }).ConfigureAwait(false);

        return seeded;
    }

    private static async Task<HttpResponseMessage> SendAsync(
        HttpClient client,
        HttpMethod method,
        string relativeUri,
        Guid operatorId,
        string operatorName,
        Guid? operatorShopId = null,
        object? body = null)
    {
        using var request = new HttpRequestMessage(method, client.CreateRelativeUri(relativeUri));
        request.Headers.Add("X-Operator-Id", operatorId.ToString("D"));
        request.Headers.Add("X-Operator-Name", operatorName);
        if (operatorShopId is { } shopId)
        {
            request.Headers.Add("X-Operator-ShopId", shopId.ToString("D"));
        }

        if (body is not null)
        {
            request.Content = JsonContent.Create(body, body.GetType());
        }

        return await client.SendAsync(request).ConfigureAwait(false);
    }
}
