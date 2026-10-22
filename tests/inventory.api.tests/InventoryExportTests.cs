using System.Linq;
using System.Net;
using System.Net.Http.Json;
using CineBoutique.Inventory.Api.Models;
using CineBoutique.Inventory.Api.Tests.Fixtures;
using CineBoutique.Inventory.Api.Tests.Helpers;
using FluentAssertions;

namespace CineBoutique.Inventory.Api.Tests;

/// <summary>
/// Tests de caractérisation des exports de fin d'inventaire (J0-3 / J1-8).
/// Le résumé plafonnait les comptages terminés à 50 : avec 39 zones et deux passages,
/// l'export global était tronqué (bug rencontré en décembre 2025).
/// </summary>
[Collection("api-tests")]
public sealed class InventoryExportTests : IntegrationTestBase
{
    private const int ZoneCount = 60; // strictement supérieur à l'ancien plafond de 50
    private const string ProductSku = "SKU-EXPORT-001";
    private const string ProductEan = "2345678901234";

    public InventoryExportTests(InventoryApiFixture fx) { UseFixture(fx); }

    [SkippableFact]
    public async Task Summary_ListsEveryCompletedRun_EvenBeyondFiftyZones()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");

        var seeded = await SeedShopWithZonesAsync(ZoneCount).ConfigureAwait(false);
        var client = CreateClient();
        await CompleteOneRunPerZoneAsync(client, seeded).ConfigureAwait(false);

        var response = await client.GetAsync(
            client.CreateRelativeUri($"/api/inventories/summary?shopId={seeded.ShopId}")
        ).ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.OK, "inventory summary").ConfigureAwait(false);
        var summary = await response.Content.ReadFromJsonAsync<InventorySummaryDto>().ConfigureAwait(false);

        summary.Should().NotBeNull();
        summary!.CompletedRuns.Should().Be(ZoneCount, "chaque zone a un comptage terminé");
        summary.CompletedRunDetails.Should().HaveCount(ZoneCount);
        summary.CompletedRunDetails.Select(run => run.LocationId).Distinct().Should().HaveCount(ZoneCount);
        summary.OpenRuns.Should().Be(0);
    }

    [SkippableFact]
    public async Task ZonesCsv_ContainsOneBlockPerCompletedZone()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");

        var seeded = await SeedShopWithZonesAsync(ZoneCount).ConfigureAwait(false);
        var client = CreateClient();
        await CompleteOneRunPerZoneAsync(client, seeded).ConfigureAwait(false);

        var response = await client.GetAsync(
            client.CreateRelativeUri($"/api/shops/{seeded.ShopId}/reports/inventory/zones.csv")
        ).ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.OK, "zones csv").ConfigureAwait(false);
        response.Content.Headers.ContentType?.MediaType.Should().Be("text/csv");

        var csv = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        var lines = csv.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();

        lines.Count(line => line.StartsWith("Zone;", System.StringComparison.Ordinal))
            .Should().Be(ZoneCount, "un bloc par zone terminée, sans plafond");
        lines.Count(line => line.Contains(ProductEan, System.StringComparison.Ordinal) && line.Contains(";" + ProductSku + ";", System.StringComparison.Ordinal))
            .Should().Be(ZoneCount, "une ligne produit par zone");
        csv.Should().Contain("E01").And.Contain($"E{ZoneCount:00}");
    }

    [SkippableFact]
    public async Task SkuCsv_ContainsOneLinePerCompletedZone()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");

        var seeded = await SeedShopWithZonesAsync(ZoneCount).ConfigureAwait(false);
        var client = CreateClient();
        await CompleteOneRunPerZoneAsync(client, seeded).ConfigureAwait(false);

        var response = await client.GetAsync(
            client.CreateRelativeUri($"/api/shops/{seeded.ShopId}/reports/inventory/sku.csv")
        ).ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.OK, "sku csv").ConfigureAwait(false);

        var csv = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        var lines = csv.Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0).ToArray();

        lines[0].Should().Be("SKU/item;Zone;Quantité validée");
        lines.Skip(1).Should().HaveCount(ZoneCount);
        lines.Skip(1).Should().OnlyContain(line => line.StartsWith(ProductSku + ";", System.StringComparison.Ordinal));
        lines.Skip(1).Should().OnlyContain(line => line.EndsWith(";1", System.StringComparison.Ordinal));
    }

    private async Task<(Guid ShopId, Guid UserId, IReadOnlyList<Guid> LocationIds)> SeedShopWithZonesAsync(int zoneCount)
    {
        var shopId = Guid.Empty;
        var userId = Guid.Empty;
        var locationIds = new List<Guid>(zoneCount);

        await Fixture.ResetAndSeedAsync(async seeder =>
        {
            shopId = await seeder.CreateShopAsync("Boutique Export").ConfigureAwait(false);
            userId = await seeder.CreateShopUserAsync(shopId, "export", "Export").ConfigureAwait(false);
            await seeder.CreateProductAsync(shopId, ProductSku, "Produit Export", ProductEan).ConfigureAwait(false);

            for (var index = 1; index <= zoneCount; index++)
            {
                var code = $"E{index:00}";
                locationIds.Add(await seeder.CreateLocationAsync(shopId, code, $"Zone export {index}").ConfigureAwait(false));
            }
        }).ConfigureAwait(false);

        return (shopId, userId, locationIds);
    }

    private static async Task CompleteOneRunPerZoneAsync(
        HttpClient client,
        (Guid ShopId, Guid UserId, IReadOnlyList<Guid> LocationIds) seeded)
    {
        foreach (var locationId in seeded.LocationIds)
        {
            var startResponse = await client.PostAsJsonAsync(
                client.CreateRelativeUri($"/api/inventories/{locationId}/start"),
                new StartRunRequest(seeded.ShopId, seeded.UserId, 1)
            ).ConfigureAwait(false);
            await startResponse.ShouldBeAsync(HttpStatusCode.OK, "start run").ConfigureAwait(false);
            var started = await startResponse.Content.ReadFromJsonAsync<StartInventoryRunResponse>().ConfigureAwait(false);
            started.Should().NotBeNull();

            var completeResponse = await client.PostAsJsonAsync(
                client.CreateRelativeUri($"/api/inventories/{locationId}/complete"),
                new CompleteRunRequest(
                    started!.RunId,
                    seeded.UserId,
                    1,
                    new[] { new CompleteRunItemRequest(ProductEan, 1m, false) })
            ).ConfigureAwait(false);
            await completeResponse.ShouldBeAsync(HttpStatusCode.OK, "complete run").ConfigureAwait(false);
        }
    }
}
