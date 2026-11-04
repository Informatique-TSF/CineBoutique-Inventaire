using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using ClosedXML.Excel;
using CineBoutique.Inventory.Api.Features.Inventory;
using CineBoutique.Inventory.Api.Features.Inventory.Exports;
using CineBoutique.Inventory.Infrastructure.Database.Inventory;
using FluentAssertions;
using Xunit;

namespace CineBoutique.Inventory.Api.Tests.Exports;

/// <summary>
/// Règle de la quantité retenue et formats des exports de fin d'inventaire.
/// Contexte : en décembre 2025, l'export ne gardait que le dernier comptage de chaque zone (le comptage 3 ne contient
/// que les références en écart) et les fichiers d'import étaient refaits à la main, avec des doublons.
/// </summary>
public sealed class InventoryReconciliationTests
{
    private static readonly DateTime BaseTime = new(2026, 12, 17, 9, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void ThirdCountOnConflictsOnly_KeepsEveryReferenceOfTheZone()
    {
        // Cas signalé par Arnaud : le C3 ne recompte que B, l'export doit quand même contenir A, B et C.
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("A", 3), ("B", 5), ("C", 2))
            .Count("B01", 2, ("A", 3), ("B", 4), ("C", 2))
            .Count("B01", 3, ("B", 5));

        var result = InventoryReconciliation.Compute(builder.Build());

        result.IsComplete.Should().BeTrue();
        result.Stock.Select(stock => (stock.Sku, stock.Quantity))
            .Should().Equal(("A", 3m), ("B", 5m), ("C", 2m));
        result.Products.Single(product => product.Sku == "B").ResolvedAtCountType.Should().Be(3);
        result.Products.Single(product => product.Sku == "A").ResolvedAtCountType.Should().Be(2);
    }

    [Theory]
    [InlineData(5, 4, 4, 4)]
    [InlineData(5, 4, 5, 5)]
    public void ThirdCount_MatchingOneOfTheFirstTwo_ResolvesTheGap(int count1, int count2, int count3, int expected)
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("A", count1))
            .Count("B01", 2, ("A", count2))
            .Count("B01", 3, ("A", count3));

        var result = InventoryReconciliation.Compute(builder.Build());

        var product = result.Products.Single();
        product.Status.Should().Be(ZoneProductStatus.Resolved);
        product.RetainedQuantity.Should().Be(expected);
        product.GapCount1MinusCount2.Should().Be(count1 - count2);
    }

    [Fact]
    public void GapStillOpenAfterThirdCount_BlocksTheImport()
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("A", 5), ("B", 1))
            .Count("B01", 2, ("A", 4), ("B", 1))
            .Count("B01", 3, ("A", 3));

        var result = InventoryReconciliation.Compute(builder.Build());

        result.IsComplete.Should().BeFalse();
        result.BlockingReasons.Should().ContainSingle(reason => reason.Contains("A en B01", StringComparison.Ordinal));
        result.Zones.Single().NextRequiredCountType.Should().Be(4);
        result.Stock.Single(stock => stock.Sku == "A").Exclusion.Should().Be(StockImportExclusion.PendingReview);
    }

    [Fact]
    public void FourthCount_MatchingTheThird_ResolvesTheGap()
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("A", 5))
            .Count("B01", 2, ("A", 4))
            .Count("B01", 3, ("A", 3))
            .Count("B01", 4, ("A", 3));

        var result = InventoryReconciliation.Compute(builder.Build());

        result.IsComplete.Should().BeTrue();
        result.Stock.Single().Quantity.Should().Be(3);
        CountRecapWorkbookBuilder.DescribeResult(result.Products.Single()).Should().Be("Résolu au C4");
    }

    [Theory]
    [InlineData(5, 5)]
    [InlineData(0, 0)]
    public void ReferenceMissingFromSecondCount_IsResolvedByTheThird(int count3, int expected)
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("A", 5), ("B", 1))
            .Count("B01", 2, ("B", 1))
            .Count("B01", 3, ("A", count3));

        var result = InventoryReconciliation.Compute(builder.Build());

        var product = result.Products.Single(item => item.Sku == "A");
        product.Status.Should().Be(ZoneProductStatus.Resolved);
        product.RetainedQuantity.Should().Be(expected);
        product.DisplayedQuantities[2].Should().Be(0, "une zone comptée sans la référence vaut 0");
    }

    [Fact]
    public void ReferenceMissingFromSecondCount_WithoutRecount_IsToReview()
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("A", 5), ("B", 1))
            .Count("B01", 2, ("B", 1));

        var result = InventoryReconciliation.Compute(builder.Build());

        result.Products.Single(item => item.Sku == "A").Status.Should().Be(ZoneProductStatus.ToReview);
        result.IsComplete.Should().BeFalse();
    }

    [Fact]
    public void ReferenceFoundOnlyAtFourthCount_NeedsAConfirmation_LikeTheConflictEngine()
    {
        // Absente des C1 et C2 : le moteur de conflits ne la considère pas comme « 0 = 0 ».
        // L'Excel de 2025 aurait retenu 0 ici ; l'application exige un comptage de confirmation.
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("B", 1))
            .Count("B01", 2, ("B", 2))
            .Count("B01", 3, ("B", 9))
            .Count("B01", 4, ("B", 2), ("X", 3));

        var firstPass = InventoryReconciliation.Compute(builder.Build());
        firstPass.Products.Single(item => item.Sku == "X").Status.Should().Be(ZoneProductStatus.ToReview);

        builder.Count("B01", 5, ("X", 3));
        var secondPass = InventoryReconciliation.Compute(builder.Build());

        secondPass.IsComplete.Should().BeTrue();
        secondPass.Stock.Select(stock => (stock.Sku, stock.Quantity)).Should().Equal(("B", 2m), ("X", 3m));
    }

    [Fact]
    public void ReferenceInSeveralZones_IsSummedOnce()
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Zone("S01")
            .Count("B01", 1, ("A", 3))
            .Count("B01", 2, ("A", 3))
            .Count("S01", 1, ("A", 2), ("Z", 1))
            .Count("S01", 2, ("A", 2), ("Z", 1));

        var result = InventoryReconciliation.Compute(builder.Build());

        result.Stock.Single(stock => stock.Sku == "A").Quantity.Should().Be(5);
        result.Stock.Select(stock => stock.Sku).Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void MissingSecondCountAndOpenRun_AreListedAsBlockingReasons()
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Zone("B02")
            .Count("B01", 1, ("A", 3))
            .Count("B01", 2, ("A", 3))
            .Count("B02", 1, ("A", 1))
            .OpenRun("B01", 3, "Elliot");

        var result = InventoryReconciliation.Compute(builder.Build());

        result.IsComplete.Should().BeFalse();
        result.BlockingReasons.Should().Contain(reason => reason.Contains("B02 (C2)", StringComparison.Ordinal));
        result.BlockingReasons.Should().Contain(reason => reason.Contains("B01 (C3 par Elliot)", StringComparison.Ordinal));
        result.Products.Where(item => item.Zone.Code == "B02").Should().OnlyContain(item => item.Status == ZoneProductStatus.WaitingBaseline);
    }

    [Fact]
    public void ShopWithoutZone_IsNotComplete()
    {
        var result = InventoryReconciliation.Compute(new SnapshotBuilder().Build());

        result.IsComplete.Should().BeFalse();
        result.BlockingReasons.Should().ContainSingle().Which.Should().Contain("Aucune zone");
    }

    [Fact]
    public void UnknownAndZeroStock_AreNotImported()
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("A", 2), ("UNK-1234", 1), ("Z", 0))
            .Count("B01", 2, ("A", 2), ("UNK-1234", 1), ("Z", 0));

        var result = InventoryReconciliation.Compute(builder.Build());

        result.Stock.Single(stock => stock.Sku == "UNK-1234").Exclusion.Should().Be(StockImportExclusion.UnknownProduct);
        result.Stock.Single(stock => stock.Sku == "Z").Exclusion.Should().Be(StockImportExclusion.ZeroStock);
        result.Stock.Where(stock => stock.IsImported).Select(stock => stock.Sku).Should().Equal("A");
    }

    [Fact]
    public void StockImportCsv_MatchesTheMcsTemplate()
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("A-ZED", 2), ("A-ABC", 7), ("A-NUL", 0))
            .Count("B01", 2, ("A-ZED", 2), ("A-ABC", 7), ("A-NUL", 0));
        var result = InventoryReconciliation.Compute(builder.Build());

        var bytes = StockImportCsvBuilder.Build("MTP", result.Stock, new DateTime(2026, 12, 19));

        bytes.Take(3).Should().NotEqual(new byte[] { 0xEF, 0xBB, 0xBF }, "le modèle MCS n'a pas de BOM");
        Encoding.UTF8.GetString(bytes).Should().Be(
            "office;item_id;loc_total_invent;locd_trans_date;locd_trans_cost\r\n" +
            "MTP;A-ABC;7;19/12/2026;0\r\n" +
            "MTP;A-ZED;2;19/12/2026;0\r\n");
    }

    [Fact]
    public void RecapWorkbook_ContainsEveryCountAndTheRetainedStock()
    {
        var builder = new SnapshotBuilder("CinéBoutique Montpellier", "MTP")
            .Zone("B01")
            .Count("B01", 1, ("A", 3), ("B", 5))
            .Count("B01", 2, ("A", 3), ("B", 4))
            .Count("B01", 3, ("B", 5));
        var snapshot = builder.Build();
        var result = InventoryReconciliation.Compute(snapshot);

        var bytes = CountRecapWorkbookBuilder.Build(snapshot, result, new DateTimeOffset(BaseTime));

        using var workbook = new XLWorkbook(new MemoryStream(bytes));
        workbook.Worksheets.Select(sheet => sheet.Name).Should().Equal(
            CountRecapWorkbookBuilder.FollowUpSheet,
            CountRecapWorkbookBuilder.CountsSheet,
            CountRecapWorkbookBuilder.ControlSheet,
            CountRecapWorkbookBuilder.StockSheet);

        var counts = workbook.Worksheet(CountRecapWorkbookBuilder.CountsSheet);
        counts.RowsUsed().Count().Should().Be(1 + 5, "en-tête + 2 lignes C1 + 2 lignes C2 + 1 ligne C3");

        var control = workbook.Worksheet(CountRecapWorkbookBuilder.ControlSheet);
        control.Cell(1, 8).GetString().Should().Be("C3");
        var rowB = control.RowsUsed().Single(row => row.Cell(2).GetString() == "B");
        rowB.Cell(5).GetDouble().Should().Be(5);
        rowB.Cell(6).GetDouble().Should().Be(4);
        rowB.Cell(7).GetDouble().Should().Be(1);
        rowB.Cell(8).GetDouble().Should().Be(5);
        rowB.Cell(9).GetString().Should().Be("Résolu au C3");
        rowB.Cell(10).GetDouble().Should().Be(5);

        var stock = workbook.Worksheet(CountRecapWorkbookBuilder.StockSheet);
        stock.Cell(2, 1).GetString().Should().Be("A");
        stock.Cell(2, 3).GetDouble().Should().Be(3);
        stock.Cell(3, 3).GetDouble().Should().Be(5);

        var followUp = workbook.Worksheet(CountRecapWorkbookBuilder.FollowUpSheet);
        followUp.Cell(4, 2).GetString().Should().Be("Inventaire terminé");
    }

    [Fact]
    public void RecapWorkbook_ListsWhatIsLeftToDo()
    {
        var builder = new SnapshotBuilder()
            .Zone("B01")
            .Count("B01", 1, ("A", 5), ("UNK-9", 1))
            .Count("B01", 2, ("A", 4), ("UNK-9", 1));
        var snapshot = builder.Build();
        var result = InventoryReconciliation.Compute(snapshot);

        using var workbook = new XLWorkbook(new MemoryStream(CountRecapWorkbookBuilder.Build(snapshot, result, new DateTimeOffset(BaseTime))));

        var toDo = workbook.Worksheet(CountRecapWorkbookBuilder.ToDoSheet);
        var reasons = toDo.Column(1).CellsUsed().Select(cell => cell.GetString()).ToArray();
        reasons.Should().Contain("Écart non résolu").And.Contain("Référence inconnue");
        workbook.Worksheet(CountRecapWorkbookBuilder.FollowUpSheet).Cell(4, 2).GetString().Should().StartWith("Inventaire non terminé");
    }

    [Theory]
    [InlineData("CinéBoutique Saint-Denis", "cineboutique-saint-denis")]
    [InlineData("Lumière Montpellier", "lumiere-montpellier")]
    [InlineData("  ", "boutique")]
    public void Slugify_ProducesAsciiFileNames(string name, string expected)
    {
        ReportsEndpoints.Slugify(name).Should().Be(expected);
    }

    private sealed class SnapshotBuilder
    {
        private readonly string _shopName;
        private readonly string? _officeCode;
        private readonly List<InventoryExportZone> _zones = new();
        private readonly List<InventoryExportRun> _runs = new();
        private readonly List<InventoryExportOpenRun> _openRuns = new();
        private readonly List<InventoryExportLine> _lines = new();
        private readonly Dictionary<string, Guid> _products = new(StringComparer.Ordinal);
        private int _runSequence;

        public SnapshotBuilder(string shopName = "Boutique test", string? officeCode = "TST")
        {
            _shopName = shopName;
            _officeCode = officeCode;
        }

        public SnapshotBuilder Zone(string code)
        {
            _zones.Add(new InventoryExportZone { LocationId = Guid.NewGuid(), Code = code, Label = code });
            return this;
        }

        public SnapshotBuilder Count(string zoneCode, short countType, params (string Sku, int Quantity)[] lines)
        {
            var zone = _zones.Single(candidate => candidate.Code == zoneCode);
            var run = new InventoryExportRun
            {
                RunId = Guid.NewGuid(),
                LocationId = zone.LocationId,
                CountType = countType,
                CompletedAtUtc = BaseTime.AddMinutes(++_runSequence),
                OperatorDisplayName = countType % 2 == 0 ? "Victor" : "Elliot"
            };
            _runs.Add(run);

            foreach (var (sku, quantity) in lines)
            {
                if (!_products.TryGetValue(sku, out var productId))
                {
                    productId = Guid.NewGuid();
                    _products[sku] = productId;
                }

                _lines.Add(new InventoryExportLine
                {
                    RunId = run.RunId,
                    ProductId = productId,
                    Sku = sku,
                    Ean = "300000" + _products.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Name = $"Produit {sku}",
                    Quantity = quantity
                });
            }

            return this;
        }

        public SnapshotBuilder OpenRun(string zoneCode, short countType, string operatorName)
        {
            var zone = _zones.Single(candidate => candidate.Code == zoneCode);
            _openRuns.Add(new InventoryExportOpenRun { LocationId = zone.LocationId, CountType = countType, OperatorDisplayName = operatorName });
            return this;
        }

        public InventoryExportSnapshot Build() => new()
        {
            ShopId = Guid.NewGuid(),
            ShopName = _shopName,
            OfficeCode = _officeCode,
            Zones = _zones.ToArray(),
            CompletedRuns = _runs.ToArray(),
            OpenRuns = _openRuns.ToArray(),
            Lines = _lines.ToArray()
        };
    }
}
