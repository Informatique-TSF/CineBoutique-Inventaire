using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using ClosedXML.Excel;
using CineBoutique.Inventory.Api.Models;
using CineBoutique.Inventory.Api.Tests.Fixtures;
using CineBoutique.Inventory.Api.Tests.Helpers;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc;

namespace CineBoutique.Inventory.Api.Tests;

/// <summary>
/// Exports de fin d'inventaire (J0-3 / J1-8, puis retour d'Arnaud en novembre 2026).
/// En décembre 2025 : le résumé plafonnait les comptages terminés à 50, et les rapports ne gardaient que le dernier
/// comptage de chaque zone. Le comptage 3 ne portant que sur les écarts, des références « disparaissaient ».
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
    public async Task StockImport_ContainsEveryReference_WhenThirdCountOnlyCoversTheGap()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");

        var seeded = await SeedTwoZoneShopAsync("MTP").ConfigureAwait(false);
        var client = CreateClient();

        // Zone 1 : A concorde, B diverge (5 / 4) puis le C3 ne recompte que B.
        await RunCountAsync(client, seeded, seeded.Zone1, seeded.FirstUser, 1, ("A", 3m), ("B", 5m)).ConfigureAwait(false);
        await RunCountAsync(client, seeded, seeded.Zone1, seeded.SecondUser, 2, ("A", 3m), ("B", 4m)).ConfigureAwait(false);
        await RunCountAsync(client, seeded, seeded.Zone1, seeded.FirstUser, 3, ("B", 5m)).ConfigureAwait(false);
        // Zone 2 : A encore, à additionner.
        await RunCountAsync(client, seeded, seeded.Zone2, seeded.FirstUser, 1, ("A", 2m)).ConfigureAwait(false);
        await RunCountAsync(client, seeded, seeded.Zone2, seeded.SecondUser, 2, ("A", 2m)).ConfigureAwait(false);

        var response = await client.GetAsync(
            client.CreateRelativeUri($"/api/shops/{seeded.ShopId}/reports/inventory/stock-import.csv")
        ).ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.OK, "stock import csv").ConfigureAwait(false);
        response.Content.Headers.ContentType?.MediaType.Should().Be("text/csv");
        response.Content.Headers.ContentDisposition?.FileNameStar.Should().StartWith("import-stock-MTP-");

        var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
        bytes.Take(3).Should().NotEqual(new byte[] { 0xEF, 0xBB, 0xBF });

        var lines = Encoding.UTF8.GetString(bytes).Split("\r\n");
        lines[0].Should().Be("office;item_id;loc_total_invent;locd_trans_date;locd_trans_cost");
        lines.Skip(1).Where(line => line.Length > 0).Select(line => string.Join(';', line.Split(';').Take(3)))
            .Should().Equal("MTP;A;5", "MTP;B;5");
        lines[1].Should().MatchRegex(@";\d{2}/\d{2}/\d{4};0$");
    }

    [SkippableFact]
    public async Task StockImport_IsRefused_WhileTheInventoryIsNotFinished()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");

        var seeded = await SeedTwoZoneShopAsync("MTP").ConfigureAwait(false);
        var client = CreateClient();
        await RunCountAsync(client, seeded, seeded.Zone1, seeded.FirstUser, 1, ("A", 3m)).ConfigureAwait(false);

        var response = await client.GetAsync(
            client.CreateRelativeUri($"/api/shops/{seeded.ShopId}/reports/inventory/stock-import.csv")
        ).ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.Conflict, "inventaire non terminé").ConfigureAwait(false);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>().ConfigureAwait(false);
        problem!.Title.Should().Be("Inventaire non terminé");
        problem.Detail.Should().Contain("E01 (C2)").And.Contain("E02 (C1, C2)");
    }

    [SkippableFact]
    public async Task StockImport_IsRefused_WhenTheShopHasNoOfficeCode()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");

        var seeded = await SeedTwoZoneShopAsync(officeCode: null).ConfigureAwait(false);
        var client = CreateClient();

        var response = await client.GetAsync(
            client.CreateRelativeUri($"/api/shops/{seeded.ShopId}/reports/inventory/stock-import.csv")
        ).ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.Conflict, "code office manquant").ConfigureAwait(false);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>().ConfigureAwait(false);
        problem!.Title.Should().Be("Code office manquant");
    }

    [SkippableFact]
    public async Task CountRecap_IsAvailableDuringTheInventory_WithEveryCount()
    {
        Skip.IfNot(TestEnvironment.IsIntegrationBackendAvailable(), "No Docker/Testcontainers and no TEST_DB_CONN provided.");

        var seeded = await SeedTwoZoneShopAsync("SDB").ConfigureAwait(false);
        var client = CreateClient();
        await RunCountAsync(client, seeded, seeded.Zone1, seeded.FirstUser, 1, ("A", 3m), ("B", 5m)).ConfigureAwait(false);
        await RunCountAsync(client, seeded, seeded.Zone1, seeded.SecondUser, 2, ("A", 3m), ("B", 4m)).ConfigureAwait(false);

        var response = await client.GetAsync(
            client.CreateRelativeUri($"/api/shops/{seeded.ShopId}/reports/inventory/recap.xlsx")
        ).ConfigureAwait(false);

        await response.ShouldBeAsync(HttpStatusCode.OK, "count recap").ConfigureAwait(false);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
        using var workbook = new XLWorkbook(new MemoryStream(bytes));

        workbook.Worksheet("Suivi").Cell(2, 2).GetString().Should().Be("SDB");
        workbook.Worksheet("Suivi").Cell(4, 2).GetString().Should().StartWith("Inventaire non terminé");
        workbook.Worksheet("Comptages").RowsUsed().Count().Should().Be(1 + 4);
        workbook.Worksheet("À traiter").Column(3).CellsUsed().Select(cell => cell.GetString()).Should().Contain("B");
    }

    private async Task<(Guid ShopId, Guid FirstUser, Guid SecondUser, Guid Zone1, Guid Zone2)> SeedTwoZoneShopAsync(string? officeCode)
    {
        (Guid ShopId, Guid FirstUser, Guid SecondUser, Guid Zone1, Guid Zone2) seeded = default;

        await Fixture.ResetAndSeedAsync(async seeder =>
        {
            var shopId = await seeder.CreateShopAsync("Boutique Export").ConfigureAwait(false);
            await seeder.SetShopOfficeCodeAsync(shopId, officeCode).ConfigureAwait(false);
            var firstUser = await seeder.CreateShopUserAsync(shopId, "elliot", "Elliot").ConfigureAwait(false);
            var secondUser = await seeder.CreateShopUserAsync(shopId, "victor", "Victor").ConfigureAwait(false);
            await seeder.CreateProductAsync(shopId, "A", "Produit A", "3000000000011").ConfigureAwait(false);
            await seeder.CreateProductAsync(shopId, "B", "Produit B", "3000000000028").ConfigureAwait(false);
            var zone1 = await seeder.CreateLocationAsync(shopId, "E01", "Zone export 1").ConfigureAwait(false);
            var zone2 = await seeder.CreateLocationAsync(shopId, "E02", "Zone export 2").ConfigureAwait(false);
            seeded = (shopId, firstUser, secondUser, zone1, zone2);
        }).ConfigureAwait(false);

        return seeded;
    }

    private static async Task RunCountAsync(
        HttpClient client,
        (Guid ShopId, Guid FirstUser, Guid SecondUser, Guid Zone1, Guid Zone2) seeded,
        Guid locationId,
        Guid operatorId,
        short countType,
        params (string Sku, decimal Quantity)[] lines)
    {
        var startResponse = await client.PostAsJsonAsync(
            client.CreateRelativeUri($"/api/inventories/{locationId}/start"),
            new StartRunRequest(seeded.ShopId, operatorId, countType)
        ).ConfigureAwait(false);
        await startResponse.ShouldBeAsync(HttpStatusCode.OK, "start run").ConfigureAwait(false);
        var started = await startResponse.Content.ReadFromJsonAsync<StartInventoryRunResponse>().ConfigureAwait(false);
        started.Should().NotBeNull();

        var items = lines
            .Select(line => new CompleteRunItemRequest(line.Sku == "A" ? "3000000000011" : "3000000000028", line.Quantity, false))
            .ToArray();

        var completeResponse = await client.PostAsJsonAsync(
            client.CreateRelativeUri($"/api/inventories/{locationId}/complete"),
            new CompleteRunRequest(started!.RunId, operatorId, countType, items)
        ).ConfigureAwait(false);
        await completeResponse.ShouldBeAsync(HttpStatusCode.OK, "complete run").ConfigureAwait(false);
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
